import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { conversationMode, executionMode } from './enums';
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
    baseBranch: text('base_branch').notNull(),
    baseCommit: text('base_commit'),
    modelId: text('model_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('conversations_repository_idx').on(table.repositoryId),
    index('conversations_owner_idx').on(table.ownerId),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
