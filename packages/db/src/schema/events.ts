import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { conversations } from './conversations';
import { repositories } from './repositories';
import { taskLinks } from './task-links';

/**
 * Persistent event log backing SSE catch-up. seq is a decimal string at the API
 * boundary; sourceEventId is the provider dedupe key for imported events.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    type: text('type').notNull(),
    source: text('source').notNull().default('internal'),
    sourceEventId: text('source_event_id'),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    taskId: uuid('task_id').references(() => taskLinks.id, { onDelete: 'set null' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('events_seq_uq').on(table.seq),
    uniqueIndex('events_source_event_uq')
      .on(table.source, table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`),
    index('events_repository_seq_idx').on(table.repositoryId, table.seq),
    index('events_conversation_seq_idx').on(table.conversationId, table.seq),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
