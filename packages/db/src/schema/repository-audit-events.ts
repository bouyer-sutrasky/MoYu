import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { owners } from './owners';
import { repositories } from './repositories';

/**
 * Append-only audit of owner changes to a repository's own configuration.
 *
 * This is deliberately separate from `events`: those rows drive the owner event
 * stream and notifications, while an audit row is a durable who/what/when record
 * that is not replayed to browsers. `detail` carries the before/after values.
 */
export const repositoryAuditEvents = pgTable(
  'repository_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** The owner who performed the change. */
    actorOwnerId: uuid('actor_owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    /** Machine-readable action, for example `check_commands_updated`. */
    type: text('type').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('repository_audit_events_repository_idx').on(table.repositoryId, table.createdAt),
  ],
);

export type RepositoryAuditEvent = typeof repositoryAuditEvents.$inferSelect;
export type NewRepositoryAuditEvent = typeof repositoryAuditEvents.$inferInsert;
