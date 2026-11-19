import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { RuntimeBridgeClient } from '@moyu/runtime-client';

import type { DispatcherConfig } from './config';
import { appendEventSql } from './events-sql';
import { acquireExecutionLease, releaseTaskLease } from './leases';
import type { DispatcherLogger } from './logger';
import { claimExecution, readReservation, reserveExecution } from './reservations';
import {
  RuntimeBridgeError,
  bridgeErrorMessage,
  isRetryableBridgeError,
  type RepositoryBinding,
} from './runtime';
import { TASK_COLUMNS, taskDecision, taskSummary, type TaskRow } from './tasks';
import { stateFromSnapshot } from './tasks';

/** Task states from which a routed handoff can never wake the target Ticket. */
const TERMINAL_TARGET_STATES = new Set(['completed', 'closed_unmerged', 'not_accepted', 'failed']);

/** Runtime states that end a Ticket. `stopped` is handled after the pause check. */
const TERMINAL_RUNTIME_STATES = new Set(['completed', 'closed_unmerged', 'stopped', 'failed']);

function bridgeErrorDetail(error: unknown): string {
  const message = bridgeErrorMessage(error);
  const code = error instanceof RuntimeBridgeError ? error.code : null;
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

interface RoutingPatch {
  routingState?: 'pending' | 'handed_off' | 'deferred' | 'failed';
  routingDetail?: string;
  routingError?: string | null;
  routingAttempts?: number;
  routingAttemptedAt?: string;
  handedOffAt?: string;
  targetTaskId?: string;
  targetConversationId?: string;
  targetRepositoryId?: string;
  targetTitle?: string | null;
  targetAssignmentId?: string;
}

interface TargetIdentity {
  id: string;
  conversationId: string;
  repositoryId: string;
  upstreamTicketId: string | null;
  state: string;
}

function newAssignmentId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 32);
}

function attemptsOf(task: TaskRow): number {
  const decision = taskDecision(task);
  return typeof decision?.routingAttempts === 'number' ? decision.routingAttempts : 0;
}

function attemptedAt(task: TaskRow): number {
  const decision = taskDecision(task);
  const value = decision?.routingAttemptedAt;
  return typeof value === 'string' ? Date.parse(value) : 0;
}

async function loadTarget(
  pool: pg.Pool | pg.PoolClient,
  repositoryId: string,
  taskId: string,
): Promise<TargetIdentity | null> {
  const result = await pool.query<TargetIdentity>(
    `select id, conversation_id as "conversationId", repository_id as "repositoryId",
            upstream_ticket_id as "upstreamTicketId", state
       from task_links
      where id = $1 and repository_id = $2
      limit 1`,
    [taskId, repositoryId],
  );
  return result.rows[0] ?? null;
}

async function loadTargetByTicket(
  pool: pg.Pool | pg.PoolClient,
  repositoryId: string,
  ticketId: string,
): Promise<TargetIdentity | null> {
  const result = await pool.query<TargetIdentity>(
    `select id, conversation_id as "conversationId", repository_id as "repositoryId",
            upstream_ticket_id as "upstreamTicketId", state
       from task_links
      where repository_id = $1 and upstream_ticket_id = $2
      limit 1`,
    [repositoryId, ticketId],
  );
  return result.rows[0] ?? null;
}

/**
 * Writes the source task's routing patch and, only when the owner-visible
 * outcome changed, emits the same `task.state_changed` event the UI already
 * consumes. Repeated attempts that find the same pending fact stay quiet.
 */
async function saveRouting(
  pool: pg.Pool,
  repository: RepositoryBinding,
  source: TaskRow,
  patch: RoutingPatch,
  _logger: DispatcherLogger,
): Promise<TaskRow | null> {
  const before = taskDecision(source);
  const visible =
    (patch.routingState !== undefined && patch.routingState !== before?.routingState) ||
    (patch.routingDetail !== undefined && patch.routingDetail !== before?.routingDetail) ||
    (patch.routingError !== undefined && patch.routingError !== before?.routingError) ||
    (patch.targetTaskId !== undefined && patch.targetTaskId !== before?.targetTaskId);
  const { targetAssignmentId, ...decisionPatch } = patch;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const updated = await client.query<TaskRow>(
      `update task_links
          set decision = decision || $2::jsonb,
              version = version + 1,
              updated_at = now()
        where id = $1
        returning ${TASK_COLUMNS.replaceAll('t.', 'task_links.')}`,
      [source.id, JSON.stringify(decisionPatch)],
    );
    let task = updated.rows[0];
    if (targetAssignmentId) {
      // A handoff assignment is only an inference. A delivery/read event may
      // already have proved the actual assignment; a late routing update must
      // never overwrite that evidence.
      const assigned = await client.query<TaskRow>(
        `update task_links
            set decision = decision || jsonb_build_object(
                  'targetAssignmentId', $2::text,
                  'targetAssignmentSource', 'handoff'),
                version = version + 1,
                updated_at = now()
          where id = $1 and not (decision ? 'targetAssignmentId')
          returning ${TASK_COLUMNS.replaceAll('t.', 'task_links.')}`,
        [source.id, targetAssignmentId],
      );
      if (assigned.rows[0]) task = assigned.rows[0];
    }
    if (task && visible) {
      await appendEventSql(client, {
        type: 'task.state_changed',
        source: 'dispatcher',
        sourceEventId: `routing:${task.id}:${task.version}`,
        repositoryId: repository.id,
        conversationId: task.conversationId,
        taskId: task.id,
        payload: { task: taskSummary(task) },
      });
    }
    await client.query('commit');
    return task ?? null;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Brings a target task into the platform's execution projection after its
 * Ticket accepted the routed admission. `queued` keeps the single execution
 * lease alive until the runtime's own state event says it is running.
 */
async function markTargetQueued(
  pool: pg.Pool,
  repository: RepositoryBinding,
  target: TargetIdentity,
  logger: DispatcherLogger,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const updated = await client.query<TaskRow>(
      `update task_links
          set state = 'queued', version = version + 1, updated_at = now()
        where id = $1 and state::text = any($2::text[])
        returning ${TASK_COLUMNS.replaceAll('t.', 'task_links.')}`,
      [
        target.id,
        ['pending_admission', 'awaiting_review', 'waiting_input', 'blocked', 'failed', 'queued'],
      ],
    );
    const task = updated.rows[0];
    if (task) {
      await appendEventSql(client, {
        type: 'task.state_changed',
        source: 'dispatcher',
        sourceEventId: `routed-admit:${task.id}:${task.version}`,
        repositoryId: repository.id,
        conversationId: task.conversationId,
        taskId: task.id,
        payload: { task: taskSummary(task) },
      });
      logger.info(
        { event: 'routing.target_queued', taskId: task.id, sourceTicket: target.upstreamTicketId },
        'marked the routed target queued under its new execution admission',
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Wakes the Ticket a routed message was attached to, under the repository's
 * single execution lease. A paused target stays paused: its input waits for the
 * manual resume, which starts a new admitted Assignment. A target that already
 * holds the live generation needs no new admission; its executor receives the
 * input through the existing delivery path.
 *
 * The work is driven from the durable decision row, so a repeated Bridge event,
 * a dispatcher restart or a temporary lease shortage only retries the handoff;
 * it never creates a second admission or a second Ticket.
 */
export async function handoffRoutedOnce(
  pool: pg.Pool,
  config: DispatcherConfig,
  repository: RepositoryBinding,
  bridge: RuntimeBridgeClient,
  supported: boolean,
  logger: DispatcherLogger,
): Promise<boolean> {
  if (!supported) return false;
  const rows = await pool.query<TaskRow>(
    `select ${TASK_COLUMNS} from task_links t
      where t.repository_id = $1
        and t.decision->>'outcome' = 'routed'
        and coalesce(t.decision->>'routingState', 'pending') in ('pending', 'deferred')
      order by t.updated_at
      limit 5`,
    [repository.id],
  );
  let worked = false;
  for (const source of rows.rows) {
    const decision = taskDecision(source);
    if (!decision || decision.outcome !== 'routed') continue;
    // A target link that arrived after the decision is filled in once.
    let targetTaskId = typeof decision.targetTaskId === 'string' ? decision.targetTaskId : null;
    const targetTicketId = decision.targetTicketId ?? null;
    if (!targetTaskId && targetTicketId) {
      const found = await loadTargetByTicket(pool, repository.id, targetTicketId);
      if (found) {
        targetTaskId = found.id;
        const conversation = await pool.query<{ title: string | null }>(
          `select title from conversations where id = $1`,
          [found.conversationId],
        );
        await saveRouting(
          pool,
          repository,
          source,
          {
            targetTaskId: found.id,
            targetConversationId: found.conversationId,
            targetRepositoryId: found.repositoryId,
            targetTitle: conversation.rows[0]?.title ?? null,
          },
          logger,
        );
      }
    }
    if (!targetTaskId) {
      // The target Ticket exists in the runtime but its platform task has not
      // been projected yet; a later pass resolves it. Do not invent a target.
      if (Date.now() - attemptedAt(source) < 10_000) continue;
      worked = true;
      await saveRouting(
        pool,
        repository,
        source,
        {
          routingState: 'pending',
          routingDetail: '目标工单尚未完成平台关联，确认后会自动交接。',
          routingAttempts: attemptsOf(source) + 1,
          routingAttemptedAt: new Date().toISOString(),
        },
        logger,
      );
      continue;
    }

    const target = await loadTarget(pool, repository.id, targetTaskId);
    if (!target) {
      await saveRouting(
        pool,
        repository,
        source,
        {
          routingState: 'failed',
          routingError: '目标工单已不存在，无法交接。',
          routingAttempts: attemptsOf(source) + 1,
          routingAttemptedAt: new Date().toISOString(),
        },
        logger,
      );
      worked = true;
      continue;
    }
    if (TERMINAL_TARGET_STATES.has(target.state)) {
      await saveRouting(
        pool,
        repository,
        source,
        {
          routingState: 'failed',
          routingError: `目标工单已经是 ${target.state}，不会再接收返修输入。`,
          routingAttempts: attemptsOf(source) + 1,
          routingAttemptedAt: new Date().toISOString(),
        },
        logger,
      );
      worked = true;
      continue;
    }
    if (!target.upstreamTicketId) {
      if (Date.now() - attemptedAt(source) < 10_000) continue;
      await saveRouting(
        pool,
        repository,
        source,
        {
          routingState: 'pending',
          routingDetail: '目标工单尚未在运行时建立，确认后会自动交接。',
          routingAttempts: attemptsOf(source) + 1,
          routingAttemptedAt: new Date().toISOString(),
        },
        logger,
      );
      worked = true;
      continue;
    }

    let snapshot;
    try {
      snapshot = await bridge.ticket(target.upstreamTicketId);
    } catch (error) {
      // Only the Bridge's own failures are retryable here; a platform/database
      // error must abort the loop instead of being recorded as a runtime fact.
      if (!(error instanceof RuntimeBridgeError)) throw error;
      if (isRetryableBridgeError(error)) {
        if (Date.now() - attemptedAt(source) < 10_000) continue;
        await saveRouting(
          pool,
          repository,
          source,
          {
            routingState: 'pending',
            routingDetail: `运行时暂时不可达，稍后重试：${bridgeErrorDetail(error)}`,
            routingAttempts: attemptsOf(source) + 1,
            routingAttemptedAt: new Date().toISOString(),
          },
          logger,
        );
        worked = true;
        continue;
      }
      await saveRouting(
        pool,
        repository,
        source,
        {
          routingState: 'failed',
          routingError: `无法读取目标工单：${bridgeErrorDetail(error)}`,
          routingAttempts: attemptsOf(source) + 1,
          routingAttemptedAt: new Date().toISOString(),
        },
        logger,
      );
      worked = true;
      continue;
    }

    // A manual pause is authoritative: keep the input queued and say what the
    // owner must do. The resume path starts an admitted Assignment that takes
    // the waiting input, so the handoff is not lost.
    if (snapshot.paused) {
      if (decision.routingState !== 'deferred') {
        await saveRouting(
          pool,
          repository,
          source,
          {
            routingState: 'deferred',
            routingDetail: '目标工单已手动暂停；在目标工单点「继续」后会自动交接这条返修输入。',
            routingAttempts: attemptsOf(source) + 1,
            routingAttemptedAt: new Date().toISOString(),
          },
          logger,
        );
        worked = true;
      }
      continue;
    }
    const runtimeState = stateFromSnapshot(snapshot.state);
    if (runtimeState && TERMINAL_RUNTIME_STATES.has(runtimeState)) {
      await saveRouting(
        pool,
        repository,
        source,
        {
          routingState: 'failed',
          routingError: `目标工单在运行时已经是 ${runtimeState}，不会再接收返修输入。`,
          routingAttempts: attemptsOf(source) + 1,
          routingAttemptedAt: new Date().toISOString(),
        },
        logger,
      );
      worked = true;
      continue;
    }

    if (snapshot.admissionRequired === true) {
      const account = await acquireExecutionLease(
        pool,
        repository.id,
        { taskId: target.id, reason: 'routed handoff' },
        config.operationLeaseTtlMs,
      );
      if (!account.lease) {
        if (Date.now() - attemptedAt(source) < 10_000) continue;
        await saveRouting(
          pool,
          repository,
          source,
          {
            routingState: 'pending',
            routingDetail: `目标工单正在等待执行名额：${account.detail ?? account.waitingFor ?? '未知原因'}`,
            routingAttempts: attemptsOf(source) + 1,
            routingAttemptedAt: new Date().toISOString(),
          },
          logger,
        );
        worked = true;
        continue;
      }
      // Scope the idempotency key to the lease generation. The first rework's
      // reservation stays claimed under its old generation; a later rework that
      // needs a new admission must be able to reserve independently instead of
      // being rejected as a generation conflict. Replays of the same generation
      // still reuse one reservation.
      const requestKey = `admit:${target.id}:${account.lease.fencingToken}`;
      const existing = await readReservation(pool, repository.id, requestKey);
      if (
        existing &&
        (existing.leaseId !== account.lease.id ||
          existing.fencingToken !== account.lease.fencingToken)
      ) {
        // A reservation from another generation may already have admitted the
        // target. Keep the slot conservative rather than starting a second
        // Assignment under a generation the runtime did not accept.
        await saveRouting(
          pool,
          repository,
          source,
          {
            routingState: 'failed',
            routingError: '目标工单的执行准入属于另一个代次，需人工核对后再重试。',
            routingAttempts: attemptsOf(source) + 1,
            routingAttemptedAt: new Date().toISOString(),
          },
          logger,
        );
        logger.error(
          {
            event: 'routing.reservation_generation_conflict',
            sourceTaskId: source.id,
            targetTaskId: target.id,
          },
          'routed handoff found a target admission reservation from another lease generation',
        );
        worked = true;
        continue;
      }
      const assignmentId = existing?.assignmentId ?? newAssignmentId();
      const reservation = {
        repositoryId: repository.id,
        requestKey,
        taskId: target.id,
        ticketId: target.upstreamTicketId,
        assignmentId,
        leaseId: account.lease.id,
        fencingToken: account.lease.fencingToken,
      };
      try {
        await reserveExecution(pool, reservation);
        await bridge.admit(target.upstreamTicketId, {
          admission: { leaseId: account.lease.id, fencingToken: account.lease.fencingToken },
          assignmentId,
        });
        await claimExecution(pool, reservation);
        await markTargetQueued(pool, repository, target, logger);
        await saveRouting(
          pool,
          repository,
          source,
          {
            routingState: 'handed_off',
            routingDetail: '输入已交接给目标工单的执行器，等待其读取。',
            handedOffAt: new Date().toISOString(),
            targetAssignmentId: assignmentId,
            routingAttempts: attemptsOf(source) + 1,
            routingAttemptedAt: new Date().toISOString(),
          },
          logger,
        );
        logger.info(
          {
            event: 'routing.admitted',
            sourceTaskId: source.id,
            targetTaskId: target.id,
            admissionId: account.lease.id,
            assignmentId,
          },
          'admitted the routed target ticket under the repository execution lease',
        );
        worked = true;
      } catch (error) {
        if (!(error instanceof RuntimeBridgeError)) throw error;
        if (isRetryableBridgeError(error)) {
          // The request may or may not have started; retry the same admission
          // identity so the Bridge deduplicates a stored Trigger.
          if (Date.now() - attemptedAt(source) >= 10_000) {
            await saveRouting(
              pool,
              repository,
              source,
              {
                routingState: 'pending',
                routingDetail: `交接请求暂时失败，稍后用同一准入重试：${bridgeErrorDetail(error)}`,
                routingAttempts: attemptsOf(source) + 1,
                routingAttemptedAt: new Date().toISOString(),
              },
              logger,
            );
          }
          worked = true;
          continue;
        }
        // A permanent refusal means the runtime started no new Assignment.
        await releaseTaskLease(
          pool,
          repository.id,
          target.id,
          'the routed target refused its execution admission',
          { expectedLeaseId: account.lease.id, allowUnproven: true },
        ).catch(() => undefined);
        await saveRouting(
          pool,
          repository,
          source,
          {
            routingState: 'failed',
            routingError: `目标工单拒绝交接：${bridgeErrorDetail(error)}`,
            routingAttempts: attemptsOf(source) + 1,
            routingAttemptedAt: new Date().toISOString(),
          },
          logger,
        );
        logger.error(
          {
            event: 'routing.refused',
            sourceTaskId: source.id,
            targetTaskId: target.id,
            error: bridgeErrorDetail(error),
          },
          'runtime refused the routed handoff admission',
        );
        worked = true;
      }
      continue;
    }

    // The target still holds the live generation; the attached input already
    // goes through its normal delivery path. This does not claim the worker
    // read it: message.delivered/message.read remain the only proof.
    await saveRouting(
      pool,
      repository,
      source,
      {
        routingState: 'handed_off',
        routingDetail: '输入已交接给目标工单当前执行中的 worker。',
        handedOffAt: new Date().toISOString(),
        ...(snapshot.assignmentId ? { targetAssignmentId: snapshot.assignmentId } : {}),
        routingAttempts: attemptsOf(source) + 1,
        routingAttemptedAt: new Date().toISOString(),
      },
      logger,
    );
    worked = true;
  }
  return worked;
}
