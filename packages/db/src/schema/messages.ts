import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { conversations } from './conversations';
import { messageDirection } from './enums';

/**
 * Conversation messages. Inbound client messages carry a stable
 * clientMessageId; the partial unique index below is the database-level
 * idempotency boundary. HTTP 409/202 semantics are implemented with M3.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: messageDirection('direction').notNull(),
    clientMessageId: text('client_message_id'),
    body: text('body').notNull(),
    replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    /** 'user' for messages typed on the web, otherwise the Channel reply kind. */
    kind: text('kind').notNull().default('user'),
    /** Stable upstream reply id, used to deduplicate repeated Bridge callbacks. */
    sourceEventId: text('source_event_id'),
    source: text('source').notNull().default('web'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Redundant with the primary key, but PostgreSQL requires a unique
    // constraint on the referenced columns of the composite reply foreign key.
    uniqueIndex('messages_id_conversation_uq').on(table.id, table.conversationId),
    uniqueIndex('messages_conversation_client_message_uq')
      .on(table.conversationId, table.clientMessageId)
      .where(sql`${table.clientMessageId} is not null`),
    uniqueIndex('messages_conversation_source_event_uq')
      .on(table.conversationId, table.sourceEventId)
      .where(sql`${table.sourceEventId} is not null`),
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    // Keyset pagination orders by (createdAt, id): the id breaks ties when two
    // messages share a timestamp, so a page boundary never skips or repeats one.
    index('messages_conversation_created_id_idx').on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    // A reply may only reference a message from the same conversation. The
    // single-column FK above keeps ON DELETE SET NULL behaviour; this composite
    // key is what rejects cross-conversation references at the database level.
    foreignKey({
      name: 'messages_reply_same_conversation_fk',
      columns: [table.replyToMessageId, table.conversationId],
      foreignColumns: [table.id, table.conversationId],
    }).onDelete('set null'),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
