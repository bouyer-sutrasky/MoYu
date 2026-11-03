import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversations } from './conversations';
import { executionMode, taskState } from './enums';
import { repositories } from './repositories';

/**
 * One conversation owns at most one task. The upstream ticket id is filled only
 * after the runtime accepts the task; a stored Trigger is not a Ticket.
 */
export const taskLinks = pgTable(
  'task_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    upstreamTicketId: text('upstream_ticket_id'),
    upstreamThreadId: text('upstream_thread_id'),
    state: taskState('state').notNull().default('pending_admission'),
    version: integer('version').notNull().default(0),
    baseBranch: text('base_branch').notNull(),
    baseCommit: text('base_commit'),
    modelId: text('model_id'),
    modelReasoningEffort: text('model_reasoning_effort'),
    executionMode: executionMode('execution_mode').notNull().default('execute'),
    /** Current question the worker asked a person, when the ticket waits for input. */
    question: text('question'),
    questionMessageId: uuid('question_message_id'),
    /** Pull request the ticket delivered, when the runtime reported or bound one. */
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    lastEventSeq: bigint('last_event_seq', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('task_links_conversation_uq').on(table.conversationId),
    uniqueIndex('task_links_repository_upstream_ticket_uq')
      .on(table.repositoryId, table.upstreamTicketId)
      .where(sql`${table.upstreamTicketId} is not null`),
    index('task_links_state_idx').on(table.state),
    check('task_links_version_nonnegative', sql`${table.version} >= 0`),
  ],
);

export type TaskLink = typeof taskLinks.$inferSelect;
export type NewTaskLink = typeof taskLinks.$inferInsert;
