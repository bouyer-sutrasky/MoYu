import type pg from 'pg';

import { taskStateSchema, type ArtifactSummary } from '@moyu/contracts';
import type { RuntimeBridgeClient, BridgeEvent } from '@moyu/runtime-client';

import type { DispatcherLogger } from './logger';
import type { RepositoryBinding } from './runtime';
import { appendEventSql } from './events-sql';
import { endedState, TASK_COLUMNS, taskSummary, type TaskRow } from './tasks';

interface ProjectedTask {
  task: TaskRow;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stateOf(value: unknown): string {
  const parsed = taskStateSchema.safeParse(value);
  return parsed.success ? parsed.data : 'queued';
}

async function taskByConversation(
  client: pg.PoolClient,
  conversationId: string,
  repositoryId: string,
): Promise<TaskRow | null> {
  const result = await client.query<TaskRow>(
    `select ${TASK_COLUMNS} from task_links t
      where t.conversation_id = $1 and t.repository_id = $2 limit 1`,
    [conversationId, repositoryId],
  );
  return result.rows[0] ?? null;
}

async function taskByTicket(
  client: pg.PoolClient,
  ticketId: string,
  repositoryId: string,
): Promise<TaskRow | null> {
  const result = await client.query<TaskRow>(
    `select ${TASK_COLUMNS} from task_links t
      where t.upstream_ticket_id = $1 and t.repository_id = $2 limit 1`,
    [ticketId, repositoryId],
  );
  return result.rows[0] ?? null;
}

async function emit(
  client: pg.PoolClient,
  repository: RepositoryBinding,
  event: BridgeEvent,
  type: string,
  conversationId: string | null,
  taskId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendEventSql(client, {
    type,
    source: 'bridge',
    sourceEventId: event.id,
    repositoryId: repository.id,
    conversationId,
    taskId,
    payload,
    occurredAt: new Date(event.at),
  });
}

async function applyTaskEvent(
  client: pg.PoolClient,
  repository: RepositoryBinding,
  event: BridgeEvent,
  logger: DispatcherLogger,
): Promise<void> {
  const data = asRecord(event.data);
  const ticketId = asString(data.ticketId);
  if (!ticketId) {
    logger.warn(
      { event: 'bridge.event_invalid', bridgeEvent: event.id },
      'ticket event had no ticketId',
    );
    return;
  }
  const conversationId = asString(data.conversationId);
  const existing = conversationId
    ? await taskByConversation(client, conversationId, repository.id)
    : await taskByTicket(client, ticketId, repository.id);
  if (!existing) {
    // The run may not have linked the ticket yet; a later ticket.linked event
    // carries the conversation. Dropping the projection is safer than
    // inventing a task row.
    logger.warn(
      { event: 'bridge.task_unmapped', bridgeEvent: event.id, ticketId },
      'ticket event arrived before the platform task was linked',
    );
    return;
  }

  let next: TaskRow | null = existing;
  if (event.type === 'ticket.linked') {
    const base = asRecord(data.base);
    const baseBranch = asString(base.branch);
    const baseCommit = asString(base.commit);
    const model = asRecord(base.model);
    const provider = asString(model.provider);
    const modelName = asString(model.model);
    const effort = asString(model.reasoningEffort);
    const updated = await client.query(
      `update task_links
          set upstream_ticket_id = $3,
              upstream_thread_id = coalesce(upstream_thread_id, $4),
              state = $5,
              base_branch = coalesce($6, base_branch),
              base_commit = coalesce($7, base_commit),
              model_id = coalesce($8, model_id),
              model_reasoning_effort = coalesce($9, model_reasoning_effort),
              last_event_seq = greatest(coalesce(last_event_seq, 0), $10),
              version = version + 1,
              updated_at = now()
        where id = $1 and repository_id = $2
          and (last_event_seq is null or last_event_seq < $10)`,
      [
        existing.id,
        repository.id,
        ticketId,
        `workspace:${existing.conversationId}`,
        stateOf(data.state),
        baseBranch,
        baseCommit,
        provider && modelName ? `${provider}/${modelName}` : null,
        effort,
        event.seq,
      ],
    );
    if (baseCommit) {
      await client.query(
        `update conversations set base_commit = coalesce(base_commit, $2), updated_at = now() where id = $1`,
        [existing.conversationId, baseCommit],
      );
    }
    if ((updated.rowCount ?? 0) === 0) {
      return;
    }
    next = await taskByConversation(client, existing.conversationId, repository.id);
    if (next) {
      await emit(client, repository, event, 'task.linked', next.conversationId, next.id, {
        task: taskSummary(next),
      });
    }
    return;
  }

  if (event.type === 'ticket.state_changed') {
    const question = asString(data.question);
    const updated = await client.query(
      `update task_links
          set state = $2,
              question = $3::text,
              question_message_id = case when $3::text is null then null else question_message_id end,
              last_event_seq = greatest(coalesce(last_event_seq, 0), $4),
              version = version + 1,
              updated_at = now()
        where id = $1 and (last_event_seq is null or last_event_seq < $4)`,
      [existing.id, stateOf(data.state), question, event.seq],
    );
    if ((updated.rowCount ?? 0) === 0) {
      return;
    }
    next = await taskByTicket(client, ticketId, repository.id);
    if (next) {
      await emit(client, repository, event, 'task.state_changed', next.conversationId, next.id, {
        task: taskSummary(next),
      });
    }
    return;
  }

  if (event.type === 'ticket.question') {
    const question = asString(data.question);
    if (!question) {
      return;
    }
    const updated = await client.query(
      `update task_links
          set question = $2,
              last_event_seq = greatest(coalesce(last_event_seq, 0), $3),
              version = version + 1,
              updated_at = now()
        where id = $1 and (last_event_seq is null or last_event_seq < $3)`,
      [existing.id, question, event.seq],
    );
    if ((updated.rowCount ?? 0) === 0) {
      return;
    }
    next = await taskByTicket(client, ticketId, repository.id);
    if (next) {
      await emit(client, repository, event, 'task.question', next.conversationId, next.id, {
        task: taskSummary(next),
      });
    }
    return;
  }

  if (event.type === 'ticket.ended') {
    const updated = await client.query(
      `update task_links
          set state = $2,
              question = null,
              question_message_id = null,
              last_event_seq = greatest(coalesce(last_event_seq, 0), $3),
              version = version + 1,
              updated_at = now()
        where id = $1 and (last_event_seq is null or last_event_seq < $3)`,
      [existing.id, endedState(data.outcome), event.seq],
    );
    if ((updated.rowCount ?? 0) === 0) {
      return;
    }
    next = await taskByTicket(client, ticketId, repository.id);
    if (next) {
      await emit(client, repository, event, 'task.state_changed', next.conversationId, next.id, {
        task: taskSummary(next),
      });
    }
  }
}

async function applyReadEvent(
  client: pg.PoolClient,
  repository: RepositoryBinding,
  event: BridgeEvent,
  logger: DispatcherLogger,
): Promise<void> {
  const data = asRecord(event.data);
  const messageId = asString(data.messageId);
  if (!messageId) {
    return;
  }
  const at = asString(data.at);
  const updated = await client.query<{ conversation_id: string }>(
    `update deliveries d
        set read_at = coalesce(d.read_at, $2::timestamptz), updated_at = now()
       from messages m
      where d.message_id = m.id and m.id = $1 and d.read_at is null
      returning m.conversation_id`,
    [messageId, at ?? new Date().toISOString()],
  );
  const conversationId = updated.rows[0]?.conversation_id;
  if (!conversationId) {
    logger.warn(
      { event: 'bridge.read_unmapped', bridgeEvent: event.id, messageId },
      'read evidence for a message without a delivery',
    );
    return;
  }
  await emit(client, repository, event, 'message.delivery_changed', conversationId, null, {
    messageId,
    deliveryState: 'read',
  });
}

async function applyDeliveredEvent(client: pg.PoolClient, event: BridgeEvent): Promise<void> {
  const data = asRecord(event.data);
  const messageId = asString(data.messageId);
  if (!messageId) {
    return;
  }
  const at = asString(data.at);
  await client.query(
    `update deliveries
        set handed_to_worker_at = coalesce(handed_to_worker_at, $2::timestamptz), updated_at = now()
      where message_id = $1 and handed_to_worker_at is null`,
    [messageId, at ?? new Date().toISOString()],
  );
}

async function applyProgressEvent(
  client: pg.PoolClient,
  repository: RepositoryBinding,
  event: BridgeEvent,
): Promise<void> {
  const data = asRecord(event.data);
  const ticketId = asString(data.ticketId);
  const text = asString(data.text);
  if (!ticketId || !text) {
    return;
  }
  const task = await taskByTicket(client, ticketId, repository.id);
  if (!task) {
    return;
  }
  await emit(client, repository, event, 'task.progress', task.conversationId, task.id, {
    ticketId,
    text: text.slice(0, 4000),
    at: asString(data.at) ?? event.at,
  });
}

async function applyArtifactEvent(
  client: pg.PoolClient,
  repository: RepositoryBinding,
  event: BridgeEvent,
): Promise<void> {
  const data = asRecord(event.data);
  const ticketId = asString(data.ticketId);
  const url = asString(data.url);
  const number = asNumber(data.number);
  if (!ticketId || !url || number === null) {
    return;
  }
  const task = await taskByTicket(client, ticketId, repository.id);
  if (!task) {
    return;
  }
  const inserted = await client.query<{
    id: string;
    task_id: string | null;
    conversation_id: string | null;
    type: string;
    mime_type: string | null;
    size_bytes: number | null;
    sha256: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `insert into artifacts (repository_id, conversation_id, task_id, type, metadata)
     values ($1, $2, $3, 'pull_request', $4::jsonb)
     returning id, task_id, conversation_id, type, mime_type, size_bytes, sha256, metadata, created_at`,
    [
      repository.id,
      task.conversationId,
      task.id,
      JSON.stringify({ url, number, title: asString(data.title) }),
    ],
  );
  const artifactRow = inserted.rows[0];
  if (!artifactRow) {
    return;
  }
  await client.query(
    `update task_links set pr_url = $2, pr_number = $3, updated_at = now() where id = $1`,
    [task.id, url, number],
  );
  const artifact: ArtifactSummary = {
    id: artifactRow.id,
    taskId: artifactRow.task_id,
    conversationId: artifactRow.conversation_id,
    type: 'pull_request',
    mimeType: artifactRow.mime_type,
    sizeBytes: artifactRow.size_bytes,
    sha256: artifactRow.sha256,
    metadata: artifactRow.metadata,
    createdAt: artifactRow.created_at.toISOString(),
  };
  await emit(client, repository, event, 'artifact.created', task.conversationId, task.id, {
    artifact,
  });
}

async function applyEvent(
  client: pg.PoolClient,
  repository: RepositoryBinding,
  event: BridgeEvent,
  logger: DispatcherLogger,
): Promise<void> {
  const seen = await client.query(
    `select 1 from events where source = 'bridge' and source_event_id = $1 limit 1`,
    [event.id],
  );
  if ((seen.rowCount ?? 0) > 0) {
    return;
  }
  switch (event.type) {
    case 'ticket.linked':
    case 'ticket.state_changed':
    case 'ticket.question':
    case 'ticket.ended':
      await applyTaskEvent(client, repository, event, logger);
      return;
    case 'message.read':
      await applyReadEvent(client, repository, event, logger);
      return;
    case 'message.delivered':
      await applyDeliveredEvent(client, event);
      return;
    case 'task.progress':
      await applyProgressEvent(client, repository, event);
      return;
    case 'artifact.created':
      await applyArtifactEvent(client, repository, event);
      return;
    default:
      logger.warn(
        { event: 'bridge.event_unknown', bridgeEvent: event.id, type: event.type },
        'skipped an unknown Bridge event type',
      );
  }
}

/** Pulls one page of Bridge events and applies them with the cursor in one transaction. */
export async function syncOnce(
  pool: pg.Pool,
  repository: RepositoryBinding,
  bridge: RuntimeBridgeClient,
  logger: DispatcherLogger,
): Promise<boolean> {
  await pool.query(
    `insert into runtime_cursors (repository_id) values ($1) on conflict do nothing`,
    [repository.id],
  );
  const cursorResult = await pool.query<{ cursor: string }>(
    `select cursor from runtime_cursors where repository_id = $1`,
    [repository.id],
  );
  const cursor = BigInt(cursorResult.rows[0]?.cursor ?? '0');
  const page = await bridge.events(cursor, 100);
  if (page.events.length === 0) {
    return false;
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const event of page.events) {
      // A failed projection rolls back the whole page and keeps the cursor
      // before it, so the next sync retries the event instead of silently
      // losing a task-state or message-read update.
      await applyEvent(client, repository, event, logger);
    }
    const last = page.events[page.events.length - 1]?.seq ?? cursor;
    await client.query(
      `update runtime_cursors set cursor = $2, updated_at = now() where repository_id = $1`,
      [repository.id, String(last)],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return true;
}

export type { ProjectedTask };
