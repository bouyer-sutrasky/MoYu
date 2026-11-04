import { index, pgTable, text, timestamp, uniqueIndex, uuid, integer } from 'drizzle-orm/pg-core';

import { repositories } from './repositories';
import { taskLinks } from './task-links';

/**
 * A runtime Ticket that a GitHub import identified as the same requirement as an
 * active platform task. It is durable so a failed or interrupted pause is retried
 * after a restart; the platform never relies on the post-commit best effort alone.
 */
export const duplicateTickets = pgTable(
  'duplicate_tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => taskLinks.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    operationId: uuid('operation_id'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    repositoryTicket: uniqueIndex('duplicate_tickets_repository_ticket_uq').on(
      table.repositoryId,
      table.ticketId,
    ),
    due: index('duplicate_tickets_due_idx').on(table.state, table.nextAttemptAt),
  }),
);
