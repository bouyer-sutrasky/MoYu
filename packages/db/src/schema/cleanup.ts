import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { cleanupItemState, cleanupRunMode, cleanupRunStatus } from './enums';
import { owners } from './owners';
import { repositories } from './repositories';

/**
 * One cleanup preview or one execution confirmed from a preview. The run is the
 * audit record: a person can see exactly which paths were proposed, which were
 * removed, and why every other candidate was skipped.
 */
export const cleanupRuns = pgTable(
  'cleanup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    mode: cleanupRunMode('mode').notNull(),
    status: cleanupRunStatus('status').notNull().default('preview'),
    retentionDays: integer('retention_days').notNull().default(7),
    /** Execution runs point at the preview the owner confirmed; one execution per preview. */
    previewOfRunId: uuid('preview_of_run_id').references((): AnyPgColumn => cleanupRuns.id, {
      onDelete: 'set null',
    }),
    candidates: integer('candidates').notNull().default(0),
    eligible: integer('eligible').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    alreadyCleaned: integer('already_cleaned').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
    bytesFreed: bigint('bytes_freed', { mode: 'number' }).notNull().default(0),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    error: text('error'),
    /** A preview is only executable while it is fresh. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('cleanup_runs_owner_created_idx').on(table.ownerId, table.createdAt),
    uniqueIndex('cleanup_runs_preview_uq')
      .on(table.previewOfRunId)
      .where(sql`${table.previewOfRunId} is not null`),
  ],
);

export type CleanupRun = typeof cleanupRuns.$inferSelect;
export type NewCleanupRun = typeof cleanupRuns.$inferInsert;

/**
 * One candidate inside a run. A skipped row carries the real reason (state,
 * dirty worktree, unpushed commits, occupied process, boundary refusal), so a
 * skipped deletion is never silent.
 */
export const cleanupItems = pgTable(
  'cleanup_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => cleanupRuns.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id'),
    ticketId: text('ticket_id').notNull(),
    profile: text('profile'),
    directory: text('directory'),
    state: cleanupItemState('state').notNull().default('planned'),
    eligible: boolean('eligible').notNull().default(false),
    reason: text('reason').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    modifiedAt: timestamp('modified_at', { withTimezone: true }),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A ticket id is scoped to its repository runtime; the same id in another
    // repository is a different worktree and must not collide in one run.
    uniqueIndex('cleanup_items_run_repository_ticket_uq').on(
      table.runId,
      table.repositoryId,
      table.ticketId,
    ),
  ],
);

export type CleanupItem = typeof cleanupItems.$inferSelect;
export type NewCleanupItem = typeof cleanupItems.$inferInsert;
