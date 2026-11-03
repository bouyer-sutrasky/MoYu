import { sql } from 'drizzle-orm';
import { bigint, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { repositories } from './repositories';

/**
 * Durable pull cursors for a repository's runtime (Bridge) event log. The
 * dispatcher advances `cursor` in the same transaction that persists the events
 * it processed, so API or Bridge restarts cannot lose or replay business events.
 */
export const runtimeCursors = pgTable('runtime_cursors', {
  repositoryId: uuid('repository_id')
    .primaryKey()
    .references(() => repositories.id, { onDelete: 'cascade' }),
  cursor: bigint('cursor', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RuntimeCursor = typeof runtimeCursors.$inferSelect;
export type NewRuntimeCursor = typeof runtimeCursors.$inferInsert;
