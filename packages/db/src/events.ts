import { sql } from 'drizzle-orm';

import type { Database } from './client';
import { events, type Event } from './schema/events';

export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface AppendEventInput {
  type: string;
  source?: string;
  sourceEventId?: string | null;
  repositoryId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Appends a durable event inside the caller's transaction and returns null when
 * the producer's `sourceEventId` was already recorded. A fixed advisory lock
 * serializes commits so a later sequence is never visible before an earlier one;
 * SSE readers can advance monotonically without skipping rows.
 */
export async function appendEvent(
  database: DatabaseTransaction,
  input: AppendEventInput,
): Promise<Event | null> {
  await database.execute(sql`select pg_advisory_xact_lock(918273646)`);
  const inserted = await database
    .insert(events)
    .values({
      type: input.type,
      source: input.source ?? 'api',
      sourceEventId: input.sourceEventId ?? null,
      repositoryId: input.repositoryId ?? null,
      conversationId: input.conversationId ?? null,
      taskId: input.taskId ?? null,
      payload: input.payload,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  return inserted[0] ?? null;
}
