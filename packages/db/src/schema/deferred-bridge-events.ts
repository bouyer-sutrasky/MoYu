import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { repositories } from './repositories';

/**
 * Bridge events that cannot be projected yet because their Ticket has not been
 * linked to a conversation. The dispatcher stores them here before advancing
 * its cursor, then projects and deletes them when `ticket.linked` arrives.
 * Keeping them durable means a restart cannot lose an early progress event.
 */
export const deferredBridgeEvents = pgTable(
  'deferred_bridge_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sourceEventId: text('source_event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('deferred_bridge_events_repository_source_uq').on(
      table.repositoryId,
      table.sourceEventId,
    ),
  ],
);

export type DeferredBridgeEvent = typeof deferredBridgeEvents.$inferSelect;
export type NewDeferredBridgeEvent = typeof deferredBridgeEvents.$inferInsert;
