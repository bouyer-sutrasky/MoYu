import type pg from 'pg';

export interface EventInput {
  type: string;
  source: string;
  sourceEventId?: string | null;
  repositoryId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Inserts a platform event inside the caller's transaction. The advisory lock
 * serializes commits with the API's event writer so sequence order and
 * visibility order agree; `(source, source_event_id)` dedupes Bridge replays.
 */
export async function appendEventSql(client: pg.PoolClient, input: EventInput): Promise<boolean> {
  await client.query('select pg_advisory_xact_lock(918273646)');
  const result = await client.query(
    `insert into events (type, source, source_event_id, repository_id, conversation_id, task_id, payload, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     on conflict do nothing
     returning id`,
    [
      input.type,
      input.source,
      input.sourceEventId ?? null,
      input.repositoryId ?? null,
      input.conversationId ?? null,
      input.taskId ?? null,
      JSON.stringify(input.payload),
      input.occurredAt ?? new Date(),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
