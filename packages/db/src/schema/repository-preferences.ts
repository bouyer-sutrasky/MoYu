import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { executionMode } from './enums';
import { owners } from './owners';
import { repositories } from './repositories';

/**
 * Per-repository task defaults chosen by the owner. These are only defaults for
 * the next task: a conversation and its task copy the chosen branch, model and
 * execution mode when they are created, so editing a preference never changes
 * an existing task's frozen configuration.
 */
export const repositoryPreferences = pgTable(
  'repository_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    executionMode: executionMode('execution_mode').notNull().default('execute'),
    baseBranch: text('base_branch').notNull(),
    /** Encoded `provider/model`; null means the instance's own default model. */
    modelId: text('model_id'),
    modelReasoningEffort: text('model_reasoning_effort'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('repository_preferences_owner_repository_uq').on(table.ownerId, table.repositoryId),
  ],
);

export type RepositoryPreferencesRow = typeof repositoryPreferences.$inferSelect;
export type NewRepositoryPreferences = typeof repositoryPreferences.$inferInsert;
