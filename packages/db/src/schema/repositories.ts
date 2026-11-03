import { sql } from 'drizzle-orm';
import { bigint, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { repositoryStatus } from './enums';
import { owners } from './owners';

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    githubRepositoryId: bigint('github_repository_id', { mode: 'number' }),
    defaultBranch: text('default_branch').notNull().default('main'),
    status: repositoryStatus('status').notNull().default('provisioning'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('repositories_full_name_uq').on(table.fullName),
    uniqueIndex('repositories_github_id_uq')
      .on(table.githubRepositoryId)
      .where(sql`${table.githubRepositoryId} is not null`),
  ],
);

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
