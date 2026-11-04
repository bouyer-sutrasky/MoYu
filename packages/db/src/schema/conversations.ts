import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { conversationMode, conversationSource, executionMode } from './enums';
import { owners } from './owners';
import { repositories } from './repositories';

/**
 * A conversation captures the repository, branch base, model and execution mode
 * chosen at creation time. Later branch movement does not silently change it.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    mode: conversationMode('mode').notNull().default('work'),
    executionMode: executionMode('execution_mode').notNull().default('execute'),
    /** `web` for a composer conversation, `github` for an imported GitHub ticket. */
    source: conversationSource('source').notNull().default('web'),
    /** Stable identity of an imported ticket (`github:<number>`); null for web conversations. */
    externalKey: text('external_key'),
    externalUrl: text('external_url'),
    /** Web conversation merged into an exact imported GitHub conversation; kept as a retry/idempotency alias. */
    mergedIntoConversationId: uuid('merged_into_conversation_id').references(
      (): AnyPgColumn => conversations.id,
      { onDelete: 'set null' },
    ),
    /** Plan revision the owner approved when a discussion became execution. */
    planRevision: integer('plan_revision'),
    baseBranch: text('base_branch').notNull(),
    baseCommit: text('base_commit'),
    modelId: text('model_id'),
    /** Short title derived from the first user message; null until one arrives. */
    title: text('title'),
    modelReasoningEffort: text('model_reasoning_effort'),
    /** Client-supplied idempotency key for conversation creation. */
    clientRequestId: text('client_request_id'),
    /** Hash of the creation payload, so reusing the key with a different payload is a conflict. */
    requestFingerprint: text('request_fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Referenced by the composite task-link foreign key that binds a task to the
    // conversation's repository.
    uniqueIndex('conversations_id_repository_uq').on(table.id, table.repositoryId),
    index('conversations_repository_idx').on(table.repositoryId),
    index('conversations_owner_idx').on(table.ownerId),
    index('conversations_merged_into_idx').on(table.mergedIntoConversationId),
    uniqueIndex('conversations_owner_client_request_uq')
      .on(table.ownerId, table.clientRequestId)
      .where(sql`${table.clientRequestId} is not null`),
    // One Work conversation per imported GitHub thread; the import projection and a
    // repeated Bridge event both resolve to this row instead of creating another task.
    uniqueIndex('conversations_repository_external_uq')
      .on(table.repositoryId, table.source, table.externalKey)
      .where(sql`${table.externalKey} is not null`),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
