import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
    /** Loopback Bridge endpoint for this repository's runtime instance. */
    bridgeUrl: text('bridge_url'),
    /** Name of the environment reference that holds the Bridge machine token, never the token itself. */
    bridgeCredentialRef: text('bridge_credential_ref'),
    /**
     * SHA-256 of this repository's machine callback token. The Bridge proves its
     * repository by presenting that token; a token from another repository is
     * rejected even though the platform route itself is shared.
     */
    bridgeCallbackTokenHash: text('bridge_callback_token_hash'),
    /**
     * Repository-specific review check commands, or null to use the host
     * supervisor's REVIEW_CHECK_COMMANDS default. The supervisor reads this
     * column directly; the platform never forwards commands through the control
     * API. Keeping the shape check in PostgreSQL means a manually edited row
     * cannot silently become an empty (skip checks) configuration.
     */
    checkCommands: jsonb('check_commands').$type<string[]>(),
    status: repositoryStatus('status').notNull().default('provisioning'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('repositories_full_name_uq').on(table.fullName),
    uniqueIndex('repositories_github_id_uq')
      .on(table.githubRepositoryId)
      .where(sql`${table.githubRepositoryId} is not null`),
    check(
      'repositories_check_commands_shape',
      sql`${table.checkCommands} is null or (jsonb_typeof(${table.checkCommands}) = 'array' and jsonb_array_length(${table.checkCommands}) between 1 and 8)`,
    ),
  ],
);

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
