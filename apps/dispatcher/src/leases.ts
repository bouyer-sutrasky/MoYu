import type pg from 'pg';

import type { RuntimeBridgeClient } from '@moyu/runtime-client';

import type { DispatcherLogger } from './logger';
import { pauseEvidenceProblem, pauseEvidenceProven } from './pause-evidence';
import type { RepositoryBinding } from './runtime';
import { bridgeErrorMessage } from './runtime';

/**
 * One execution admission for a repository. The fencing token is the persisted
 * generation of the row: every command and receipt written under a lease carries
 * it, and a receipt whose token is no longer current is rejected instead of
 * applied. Acquisition of a replacement is refused while the previous execution
 * has not been proven stopped.
 */
export interface ExecutionLease {
  id: string;
  fencingToken: string;
  generation: number;
  holderId: string;
  expiresAt: Date;
  recoveryState: string;
}

export interface LeaseAccount {
  lease: ExecutionLease | null;
  /** Why a lease could not be obtained. `stop_proof_required` and `unknown` block. */
  refused:
    | null
    | 'held'
    | 'stop_proof_required'
    | 'recovery_blocked'
    | 'recovery_in_progress'
    | 'conflict';
  waitingFor: string | null;
  detail: string | null;
}

export interface LeaseSubject {
  taskId?: string | null;
  deliveryId?: string | null;
  /** Overrides the derived holder id; used by the recovery loop. */
  holderId?: string;
  reason?: string;
}

interface LeaseRow {
  id: string;
  repository_id: string;
  holder_id: string;
  fencing_token: string;
  state: 'active' | 'released' | 'expired';
  recovery_state: string;
  recovery_reason: string | null;
  waiting_for: string | null;
  stop_proof: Record<string, unknown>;
  stop_proven_at: Date | null;
  expires_at: Date;
  last_error: string | null;
}

const LEASE_COLUMNS = `
  id, repository_id, holder_id, fencing_token, state, recovery_state, recovery_reason,
  waiting_for, stop_proof, stop_proven_at, expires_at, last_error
`;

/** Active task states that may still execute and therefore hold an execution slot. */
export const ACTIVE_EXECUTION_STATES = ['queued', 'running', 'discussing', 'stopping'] as const;

/** Runtime states in which no worker turn can currently run. */
const IDLE_RUNTIME_STATES = new Set([
  'waiting_input',
  'awaiting_review',
  'stopped',
  'completed',
  'closed_unmerged',
]);

/** Runtime states that mean an execution may still be active and must be stopped. */
const RUNNING_RUNTIME_STATES = new Set(['queued', 'discussing', 'running', 'starting']);

export function deriveHolderId(subject: LeaseSubject): string {
  if (subject.holderId) return subject.holderId;
  if (subject.taskId) return `task:${subject.taskId}`;
  if (subject.deliveryId) return `delivery:${subject.deliveryId}`;
  return `dispatcher:${process.pid}`;
}

function toLease(row: LeaseRow): ExecutionLease {
  return {
    id: row.id,
    fencingToken: String(row.fencing_token),
    generation: Number(row.fencing_token),
    holderId: row.holder_id,
    expiresAt: row.expires_at,
    recoveryState: row.recovery_state,
  };
}

async function appendLeaseEvent(
  database: pg.Pool | pg.PoolClient,
  input: {
    leaseId: string | null;
    repositoryId: string;
    fencingToken: string | null;
    type: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await database.query(
    `insert into runtime_lease_events (lease_id, repository_id, fencing_token, type, detail)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.leaseId,
      input.repositoryId,
      input.fencingToken,
      input.type,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

async function bindTaskLease(
  client: pg.PoolClient,
  taskId: string,
  lease: ExecutionLease,
): Promise<void> {
  await client.query(
    `update task_links
        set runtime_lease_id = $2, updated_at = now()
      where id = $1 and (runtime_lease_id is distinct from $2)`,
    [taskId, lease.id],
  );
}

/**
 * Core acquisition decision. The caller owns the transaction and the row lock,
 * so an import event can bind its new task without a second connection.
 */
async function acquireOn(
  client: pg.PoolClient,
  repositoryId: string,
  subject: LeaseSubject,
  ttlMs: number,
): Promise<LeaseAccount> {
  const holderId = deriveHolderId(subject);
  const active = await client.query<LeaseRow & { expired: boolean }>(
    `select ${LEASE_COLUMNS}, (expires_at <= now()) as expired from runtime_leases
      where repository_id = $1 and state = 'active'
      for update`,
    [repositoryId],
  );
  const current = active.rows[0];
  if (current) {
    // Compare against the database clock in the same statement that locks the
    // row: a JS `Date.now()` can disagree with the `now()` that writes expiry.
    const expired = current.expired;
    if (!expired) {
      if (current.holder_id === holderId) {
        const renewed = await client.query<LeaseRow>(
          `update runtime_leases
              set heartbeat_at = now(), expires_at = now() + make_interval(secs => $2)
            where id = $1 returning ${LEASE_COLUMNS}`,
          [current.id, ttlMs / 1000],
        );
        const lease = toLease(renewed.rows[0] ?? current);
        if (subject.taskId) await bindTaskLease(client, subject.taskId, lease);
        return { lease, refused: null, waitingFor: null, detail: null };
      }
      return {
        lease: null,
        refused: 'held',
        waitingFor: 'execution_slot',
        detail: 'Another task holds this repository execution lease',
      };
    }

    if (current.recovery_state === 'recovered') {
      await client.query(
        `update runtime_leases
            set state = 'expired', released_at = now(), heartbeat_at = now()
          where id = $1`,
        [current.id],
      );
      await appendLeaseEvent(client, {
        leaseId: current.id,
        repositoryId,
        fencingToken: String(current.fencing_token),
        type: 'expired',
        detail: { reason: 'stop proof recorded; generation can be replaced' },
      });
    } else if (current.recovery_state === 'none' || current.recovery_state === 'required') {
      await client.query(
        `update runtime_leases
            set recovery_state = 'required',
                recovery_reason = coalesce(recovery_reason, $2),
                waiting_for = 'execution_stop_proof',
                last_error = coalesce(last_error, $2)
          where id = $1`,
        [current.id, 'The lease expired before the previous execution proved it had stopped'],
      );
      await appendLeaseEvent(client, {
        leaseId: current.id,
        repositoryId,
        fencingToken: String(current.fencing_token),
        type: 'stop_proof_required',
        detail: { requester: holderId },
      });
      return {
        lease: null,
        refused: 'stop_proof_required',
        waitingFor: 'execution_stop_proof',
        detail:
          'The previous execution lease expired; a replacement waits until the old worker and its descendants are proven stopped',
      };
    } else {
      const state = current.recovery_state;
      return {
        lease: null,
        refused: state === 'verifying' ? 'recovery_in_progress' : 'recovery_blocked',
        waitingFor: current.waiting_for ?? 'execution_stop_proof',
        detail:
          current.recovery_reason ??
          'Lease recovery is in progress; a new execution generation is not allowed yet',
      };
    }
  }

  const inserted = await client.query<LeaseRow>(
    `insert into runtime_leases (repository_id, holder_id, expires_at, recovery_state)
     values ($1, $2, now() + make_interval(secs => $3), 'none')
     returning ${LEASE_COLUMNS}`,
    [repositoryId, holderId, ttlMs / 1000],
  );
  const row = inserted.rows[0];
  if (!row) {
    return {
      lease: null,
      refused: 'conflict',
      waitingFor: null,
      detail: 'The lease insert returned no row',
    };
  }
  const lease = toLease(row);
  if (subject.taskId) await bindTaskLease(client, subject.taskId, lease);
  await appendLeaseEvent(client, {
    leaseId: lease.id,
    repositoryId,
    fencingToken: lease.fencingToken,
    type: 'acquired',
    detail: { holderId, reason: subject.reason ?? null },
  });
  return { lease, refused: null, waitingFor: null, detail: null };
}

/**
 * Attempts to take (or renew) the repository's single execution lease in its
 * own transaction. An expired lease is never silently replaced: it either moves
 * to `required` (waiting for a stop proof) or, when a previous recovery already
 * proved the stop, expires and a new generation is issued.
 */
export async function acquireExecutionLease(
  pool: pg.Pool,
  repositoryId: string,
  subject: LeaseSubject,
  ttlMs: number,
): Promise<LeaseAccount> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const account = await acquireOn(client, repositoryId, subject, ttlMs);
    await client.query('commit');
    return account;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    // A concurrent transaction won the unique active index; report it as held
    // rather than retrying into an unbounded race.
    if ((error as { code?: string }).code === '23505') {
      return {
        lease: null,
        refused: 'held',
        waitingFor: 'execution_slot',
        detail: 'Another dispatcher acquired the repository execution lease',
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Acquisition inside an existing projection transaction (GitHub import). */
export async function acquireExecutionLeaseOn(
  client: pg.PoolClient,
  repositoryId: string,
  subject: LeaseSubject,
  ttlMs: number,
): Promise<LeaseAccount> {
  return acquireOn(client, repositoryId, subject, ttlMs);
}

/** Releases a live lease. Only a proven-safe or voluntarily finished execution may call this. */
export async function releaseExecutionLease(
  pool: pg.Pool,
  repositoryId: string,
  leaseId: string,
  reason: string,
  proof?: Record<string, unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const row = await client.query<LeaseRow>(
      `select ${LEASE_COLUMNS} from runtime_leases where id = $1 for update`,
      [leaseId],
    );
    const lease = row.rows[0];
    if (!lease || lease.state !== 'active') {
      await client.query('commit');
      return;
    }
    // Never release a lease that still backs a task that has not reached a
    // confirmed-safe state or supplied a stop proof.
    const bound = await client.query(
      `select 1 from task_links
        where runtime_lease_id = $1
          and not (state::text in ('waiting_input','awaiting_review','completed','closed_unmerged')
                   or (state::text = 'stopped' and stopped_at is not null))
        limit 1`,
      [leaseId],
    );
    if ((bound.rowCount ?? 0) > 0) {
      await client.query('commit');
      return;
    }
    await client.query(
      `update runtime_leases
          set state = 'released', released_at = now(), heartbeat_at = now(),
              stop_proof = case when $2::jsonb = '{}'::jsonb then stop_proof else $2::jsonb end,
              stop_proven_at = case when $2::jsonb = '{}'::jsonb then stop_proven_at else now() end,
              recovery_state = 'none', waiting_for = null, last_error = null
        where id = $1`,
      [leaseId, JSON.stringify(proof ?? {})],
    );
    await appendLeaseEvent(client, {
      leaseId,
      repositoryId,
      fencingToken: String(lease.fencing_token),
      type: 'released',
      detail: { reason, ...(proof ? { proof } : {}) },
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Releases the lease currently bound to a task. The task row and lease row are
 * locked together, and an expected lease id prevents a maintenance pass from
 * releasing a newer generation acquired while it was deciding.
 *
 * Waiting/review/ended states are confirmed safe; `stopped` needs a timestamp.
 * `blocked`/`stopping` need an explicit stop proof, otherwise the slot stays
 * occupied.
 */
export async function releaseTaskLease(
  pool: pg.Pool,
  repositoryId: string,
  taskId: string,
  reason: string,
  options: {
    expectedLeaseId?: string;
    proof?: Record<string, unknown>;
    allowUnproven?: boolean;
  } = {},
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const task = await client.query<{
      runtime_lease_id: string | null;
      state: string;
      stopped_at: Date | null;
    }>(`select runtime_lease_id, state, stopped_at from task_links where id = $1 for update`, [
      taskId,
    ]);
    const row = task.rows[0];
    if (!row?.runtime_lease_id) {
      await client.query('commit');
      return false;
    }
    if (options.expectedLeaseId && row.runtime_lease_id !== options.expectedLeaseId) {
      // A newer generation is already bound; never release it on behalf of the
      // operation/maintenance pass that was looking at the old one.
      await client.query('commit');
      return false;
    }
    const safe =
      options.proof !== undefined ||
      options.allowUnproven === true ||
      ['waiting_input', 'awaiting_review', 'completed', 'closed_unmerged'].includes(row.state) ||
      (row.state === 'stopped' && row.stopped_at !== null);
    if (!safe) {
      await client.query('commit');
      return false;
    }
    const leaseResult = await client.query<LeaseRow>(
      `select ${LEASE_COLUMNS} from runtime_leases where id = $1 for update`,
      [row.runtime_lease_id],
    );
    const lease = leaseResult.rows[0];
    if (!lease || lease.state !== 'active') {
      await client.query(
        `update task_links set runtime_lease_id = null
          where id = $1 and runtime_lease_id = $2`,
        [taskId, row.runtime_lease_id],
      );
      await client.query('commit');
      return false;
    }
    await client.query(
      `update runtime_leases
          set state = 'released', released_at = now(), heartbeat_at = now(),
              stop_proof = case when $2::jsonb = '{}'::jsonb then stop_proof else $2::jsonb end,
              stop_proven_at = case when $2::jsonb = '{}'::jsonb then stop_proven_at else now() end,
              recovery_state = 'none', waiting_for = null, last_error = null
        where id = $1`,
      [lease.id, JSON.stringify(options.proof ?? {})],
    );
    await client.query(
      `update task_links set runtime_lease_id = null
        where id = $1 and runtime_lease_id = $2`,
      [taskId, lease.id],
    );
    await appendLeaseEvent(client, {
      leaseId: lease.id,
      repositoryId,
      fencingToken: String(lease.fencing_token),
      type: 'released',
      detail: { reason, ...(options.proof ? { proof: options.proof } : {}) },
    });
    await client.query('commit');
    return true;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The exact generation an ignored runtime decision names. */
export interface IgnoredAdmissionGeneration {
  taskId: string;
  decisionId: string;
  messageIds: string[];
  leaseId: string;
  /** The delivery's fencing token; the lease row decides when it is absent. */
  fencingToken: string | null;
  reason: string;
}

export interface IgnoredAdmissionSettlement {
  settled: boolean;
  detail: string;
}

/**
 * Settles the execution generation of an admission the runtime ignored.
 *
 * `decision.ignored` is the runtime's own statement that it created no ticket or
 * Assignment for the named triggers, so this generation never executed. The
 * caller passes the lease the ignored messages were delivered under: a late
 * receipt that reaches a task already bound to a newer generation must not free
 * that newer slot. The platform evidence is checked again here. A live runtime
 * ticket, a claimed reservation, a pending delivery, a queued command or another
 * task bound to the generation keeps it occupied and records why instead of
 * releasing it.
 *
 * The caller owns the transaction, the task row lock and the `not_accepted`
 * projection; this function locks the lease after the task, matching
 * `releaseTaskLease`.
 */
export async function settleIgnoredAdmissionOn(
  client: pg.PoolClient,
  repositoryId: string,
  generation: IgnoredAdmissionGeneration,
): Promise<IgnoredAdmissionSettlement> {
  const taskResult = await client.query<{
    id: string;
    state: string;
    runtime_lease_id: string | null;
    upstream_ticket_id: string | null;
  }>(
    `select id, state, runtime_lease_id, upstream_ticket_id
       from task_links where id = $1 and repository_id = $2 for update`,
    [generation.taskId, repositoryId],
  );
  const task = taskResult.rows[0];
  if (!task) return { settled: false, detail: 'the platform task no longer exists' };
  if (task.runtime_lease_id !== generation.leaseId) {
    // The ignored receipt names an older generation; releasing the current one
    // would free a slot that may still be executing.
    return { settled: false, detail: 'the task is bound to a different execution generation' };
  }
  if (task.state !== 'not_accepted' && task.state !== 'pending_admission') {
    return { settled: false, detail: `the task is ${task.state}, not an unaccepted admission` };
  }
  const leaseResult = await client.query<LeaseRow>(
    `select ${LEASE_COLUMNS} from runtime_leases where id = $1 and repository_id = $2 for update`,
    [generation.leaseId, repositoryId],
  );
  const lease = leaseResult.rows[0];
  if (!lease || lease.state !== 'active') {
    return { settled: false, detail: 'the execution lease is no longer active' };
  }
  if (
    generation.fencingToken !== null &&
    String(lease.fencing_token) !== String(generation.fencingToken)
  ) {
    return { settled: false, detail: 'the receipt carries an older fencing generation' };
  }

  const evidence = await client.query<{
    operations: number;
    claimed: number;
    reserved: number;
    deliveries: number;
    otherTasks: number;
  }>(
    `select
       (select count(*)::int from task_operations op
         where op.task_id = $1 and op.state in ('queued', 'running')) as operations,
       (select count(*)::int from execution_reservations r
         where r.lease_id = $2 and r.state = 'claimed') as claimed,
       (select count(*)::int from execution_reservations r
         where r.lease_id = $2 and r.state = 'reserved') as reserved,
       (select count(*)::int from deliveries d
         where d.runtime_lease_id = $2 and d.state in ('pending', 'delivering')) as deliveries,
       (select count(*)::int from task_links t
         where t.runtime_lease_id = $2 and t.id <> $1) as "otherTasks"`,
    [generation.taskId, generation.leaseId],
  );
  const facts = evidence.rows[0];
  const problem =
    task.upstream_ticket_id !== null
      ? 'The runtime ticket bound to this admission cannot be proven not to have executed'
      : facts && facts.deliveries > 0
        ? 'A delivery is still in flight on this execution generation'
        : facts && facts.operations > 0
          ? 'A command is still queued on this execution generation'
          : facts && facts.claimed > 0
            ? 'The execution reservation is already claimed by the runtime'
            : facts && facts.otherTasks > 0
              ? 'Another task is bound to this execution generation'
              : null;
  if (problem) {
    await client.query(
      `update runtime_leases
          set recovery_state = 'blocked', recovery_reason = $2,
              waiting_for = 'execution_stop_proof', last_error = $2
        where id = $1 and state = 'active'`,
      [generation.leaseId, problem],
    );
    await appendLeaseEvent(client, {
      leaseId: generation.leaseId,
      repositoryId,
      fencingToken: String(lease.fencing_token),
      type: 'recovery_blocked',
      detail: { reason: problem, source: 'decision_ignored', decisionId: generation.decisionId },
    });
    return { settled: false, detail: problem };
  }

  const proof = {
    kind: 'admission_ignored',
    decisionId: generation.decisionId,
    messageIds: generation.messageIds,
    taskId: generation.taskId,
    noRuntimeTicket: true,
  };
  if (facts && facts.reserved > 0) {
    // The generation never reached a claimed Assignment, so its platform
    // reservation is abandoned with the same fence instead of being reused.
    await client.query(
      `update execution_reservations
          set state = 'abandoned', updated_at = now()
        where lease_id = $1 and state = 'reserved'`,
      [generation.leaseId],
    );
  }
  await client.query(
    `update runtime_leases
        set state = 'released', released_at = now(), heartbeat_at = now(),
            stop_proof = $2::jsonb, stop_proven_at = now(),
            recovery_state = 'none', waiting_for = null, last_error = null
      where id = $1 and state = 'active'`,
    [generation.leaseId, JSON.stringify(proof)],
  );
  await client.query(
    `update task_links
        set runtime_lease_id = null,
            stop_evidence = coalesce(stop_evidence, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      where id = $1 and runtime_lease_id = $3`,
    [generation.taskId, JSON.stringify({ leaseSettlement: proof }), generation.leaseId],
  );
  await appendLeaseEvent(client, {
    leaseId: generation.leaseId,
    repositoryId,
    fencingToken: String(lease.fencing_token),
    type: 'released',
    detail: { reason: generation.reason, proof },
  });
  return { settled: true, detail: 'settled the generation that never executed' };
}

/** Marks a live lease as needing a stop proof before any replacement. */
export async function requireLeaseStopProof(
  pool: pg.Pool,
  repositoryId: string,
  leaseId: string,
  reason: string,
): Promise<void> {
  const result = await pool.query<{ fencing_token: string }>(
    `update runtime_leases
        set recovery_state = case when recovery_state = 'recovered' then recovery_state
                                  else 'required' end,
            recovery_reason = $2, waiting_for = 'execution_stop_proof',
            expires_at = now(), last_error = $2
      where id = $1 and state = 'active'
      returning fencing_token`,
    [leaseId, reason.slice(0, 1000)],
  );
  const row = result.rows[0];
  if (!row) return;
  await appendLeaseEvent(pool, {
    leaseId,
    repositoryId,
    fencingToken: String(row.fencing_token),
    type: 'stop_proof_required',
    detail: { reason: reason.slice(0, 1000) },
  });
}

/**
 * Verifies that a runtime receipt still belongs to the task's current lease
 * generation. A stale receipt is audited and counted, never applied.
 */
export async function receiptIsCurrentOn(
  client: pg.PoolClient,
  input: {
    repositoryId: string;
    leaseId: string | null;
    fencingToken: string | null;
    taskId: string;
    operationId?: string;
    kind: string;
  },
): Promise<{ current: boolean; reason?: string }> {
  if (!input.leaseId) {
    return { current: false, reason: 'The command was sent without a recorded execution lease' };
  }
  const result = await client.query<{
    id: string;
    fencing_token: string;
    state: string;
    recovery_state: string;
    task_lease: string | null;
    task_state: string;
  }>(
    `select l.id, l.fencing_token, l.state, l.recovery_state,
            t.runtime_lease_id as task_lease, t.state as task_state
       from runtime_leases l
       join task_links t on t.id = $2
      where l.id = $1
      for update of l, t`,
    [input.leaseId, input.taskId],
  );
  const row = result.rows[0];
  const stale =
    !row ||
    row.state !== 'active' ||
    String(row.fencing_token) !== String(input.fencingToken ?? '') ||
    row.task_lease !== input.leaseId;
  if (!stale) return { current: true };

  const reason = !row
    ? 'The execution lease no longer exists'
    : row.state !== 'active'
      ? `The execution lease is ${row.state}`
      : String(row.fencing_token) !== String(input.fencingToken ?? '')
        ? 'The receipt carries an older fencing generation'
        : 'The task is bound to a newer execution lease';
  await client.query(
    `update runtime_leases
        set stale_receipt_count = stale_receipt_count + 1, last_error = $2
      where id = $1`,
    [input.leaseId, reason],
  );
  await appendLeaseEvent(client, {
    leaseId: input.leaseId,
    repositoryId: input.repositoryId,
    fencingToken: input.fencingToken,
    type: 'stale_receipt_rejected',
    detail: {
      taskId: input.taskId,
      operationId: input.operationId ?? null,
      kind: input.kind,
      reason,
    },
  });
  if (input.operationId) {
    await client.query(
      `update task_operations
          set stale_at = now(), stale_reason = $2, updated_at = now()
        where id = $1`,
      [input.operationId, reason],
    );
  }
  return { current: false, reason };
}

/** Transactional wrapper for callers that do not already own a transaction. */
export async function receiptIsCurrent(
  pool: pg.Pool,
  input: Parameters<typeof receiptIsCurrentOn>[1],
): Promise<{ current: boolean; reason?: string }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await receiptIsCurrentOn(client, input);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reconciles an expired lease with the runtime.
 *
 * - A still-running ticket is adopted only when the runtime reports the SAME
 *   generation, i.e. `snapshot.admission.leaseId` equals this lease id and the
 *   fencing token matches. No new execution is started and no second worker can
 *   appear. A different admission, or no admission at all, means the runtime
 *   cannot prove this generation is the live one, so the lease stays blocked.
 *   Deliberate tradeoff: a runtime build that never reports an admission will
 *   block on every expired-but-running lease instead of reviving it. Safety wins
 *   here; the slot is held, nothing is killed, and the stop proof path applies.
 * - An idle/stopped snapshot or pause evidence is not a supervisor stop proof;
 *   the lease stays active/blocked until a supervisor-owned cgroup proof for
 *   the exact old generation exists.
 * - A ticket that must still be stopped is paused, its proof recorded, and the
 *   lease stays blocked until that evidence exists.
 * - Bridge unreachable or identity unknown keeps the lease blocked (capacity is
 *   not released, no process is killed).
 */
export async function reconcileLeases(
  pool: pg.Pool,
  repository: RepositoryBinding,
  bridge: RuntimeBridgeClient,
  logger: DispatcherLogger,
): Promise<void> {
  const rows = await pool.query<LeaseRow>(
    `select ${LEASE_COLUMNS} from runtime_leases
      where repository_id = $1 and state = 'active'
        and (expires_at <= now() or recovery_state in ('required', 'verifying'))
      order by expires_at
      limit 20`,
    [repository.id],
  );
  for (const lease of rows.rows) {
    const task = await pool.query<{
      id: string;
      state: string;
      upstream_ticket_id: string | null;
    }>(
      `select t.id, t.state, t.upstream_ticket_id
         from task_links t
        where t.runtime_lease_id = $1
        union all
       select t.id, t.state, t.upstream_ticket_id
         from deliveries d
         join messages m on m.id = d.message_id
         join task_links t on t.conversation_id = m.conversation_id
        where d.runtime_lease_id = $1
        limit 1`,
      [lease.id],
    );
    const linked = task.rows[0];
    if (!linked || !linked.upstream_ticket_id) {
      // A launch lease can be bound to a delivery before the ticket exists. It
      // cannot be proven stopped from the platform side, so it stays blocked.
      await markRecoveryBlocked(
        pool,
        repository.id,
        lease,
        'The execution target is not yet an accepted runtime ticket; stop cannot be proven',
        'runtime_ticket',
      );
      continue;
    }
    let snapshot;
    try {
      snapshot = await bridge.ticket(linked.upstream_ticket_id);
    } catch (error) {
      await markRecoveryBlocked(
        pool,
        repository.id,
        lease,
        `The runtime Bridge is unreachable (${bridgeErrorMessage(error)}); execution state is unknown`,
        'runtime',
      );
      logger.warn(
        {
          event: 'lease.recovery_bridge_unreachable',
          repositoryId: repository.id,
          leaseId: lease.id,
          error: bridgeErrorMessage(error),
        },
        'lease recovery keeps the execution slot while the runtime cannot prove a stop',
      );
      continue;
    }

    if (snapshot.paused?.stoppedAt) {
      const evidence = { ...snapshot.paused.evidence, stoppedAt: snapshot.paused.stoppedAt };
      // Pause evidence describes a Session; it does not prove the supervisor's
      // cgroup and its managed descendants are empty. Keep the old generation
      // blocked until that authority is bound and verified.
      await markRecoveryBlocked(
        pool,
        repository.id,
        lease,
        pauseEvidenceProven(evidence)
          ? 'The paused worker has no supervisor-owned cgroup stop proof bound to this generation'
          : (pauseEvidenceProblem(evidence) ?? 'The runtime pause evidence is incomplete'),
        'execution_stop_proof',
      );
      continue;
    }
    if (IDLE_RUNTIME_STATES.has(snapshot.state)) {
      // An idle Runtime snapshot is not a stop proof: it cannot see a surviving
      // managed descendant or an unreported job. Only a supervisor-owned cgroup
      // verification may release this generation.
      await markRecoveryBlocked(
        pool,
        repository.id,
        lease,
        'The runtime reported idle, but no supervisor-owned cgroup stop proof is bound to this generation',
        'execution_stop_proof',
      );
      continue;
    }
    if (RUNNING_RUNTIME_STATES.has(snapshot.state)) {
      // The runtime reporting a live state is not enough: the generation must
      // still be the one the runtime accepted. A snapshot carrying a different
      // lease id or fencing token means another generation owns the ticket, and
      // a snapshot carrying no admission cannot prove this generation at all.
      // Either way the expired generation stays fenced instead of being
      // extended, so a late heartbeat can never revive a superseded lease.
      const admission = snapshot.admission;
      const sameGeneration =
        admission !== null &&
        admission !== undefined &&
        admission.leaseId === lease.id &&
        String(admission.fencingToken) === String(lease.fencing_token);
      if (!sameGeneration) {
        await markRecoveryBlocked(
          pool,
          repository.id,
          lease,
          admission
            ? `The runtime is running under a different admission (${admission.leaseId}/${String(admission.fencingToken)})`
            : 'The runtime reported no admission, so this generation cannot be proven current',
          'execution_stop_proof',
        );
        continue;
      }
      const adopted = await pool.query(
        `update runtime_leases
            set holder_id = $2, heartbeat_at = now(), expires_at = now() + interval '30 minutes',
                recovery_state = 'none', recovery_reason = null, waiting_for = null, last_error = null
          where id = $1 and state = 'active' returning id`,
        [lease.id, `dispatcher:${process.pid}`],
      );
      if ((adopted.rowCount ?? 0) > 0) {
        await appendLeaseEvent(pool, {
          leaseId: lease.id,
          repositoryId: repository.id,
          fencingToken: String(lease.fencing_token),
          type: 'adopted',
          detail: { runtimeState: snapshot.state, taskId: linked.id },
        });
        logger.info(
          {
            event: 'lease.adopted',
            repositoryId: repository.id,
            leaseId: lease.id,
            runtimeState: snapshot.state,
          },
          'adopted the still-running execution under its existing fencing generation',
        );
        continue;
      }
    }
    await markRecoveryBlocked(
      pool,
      repository.id,
      lease,
      `The runtime reported an unrecognised state: ${String(snapshot.state)}`,
      'runtime',
    );
  }
}

async function markRecoveryBlocked(
  pool: pg.Pool,
  repositoryId: string,
  lease: LeaseRow,
  reason: string,
  waitingFor: string,
): Promise<void> {
  await pool.query(
    `update runtime_leases
        set recovery_state = case when recovery_state = 'recovered' then recovery_state
                                  else 'blocked' end,
            recovery_reason = $2, waiting_for = $3, last_error = $2
      where id = $1`,
    [lease.id, reason.slice(0, 1000), waitingFor],
  );
  await appendLeaseEvent(pool, {
    leaseId: lease.id,
    repositoryId,
    fencingToken: String(lease.fencing_token),
    type: 'recovery_blocked',
    detail: { reason: reason.slice(0, 1000), waitingFor },
  });
}
