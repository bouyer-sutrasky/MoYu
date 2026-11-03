import { sql } from 'drizzle-orm';
import { bigserial, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { runtimeLeaseState } from './enums';
import { repositories } from './repositories';

/**
 * Execution admission lease. At most one active lease may exist per repository;
 * fencingToken increases monotonically and is checked by the host supervisor
 * before starting a worker, so an expired lease alone cannot start a second one.
 */
export const runtimeLeases = pgTable(
  'runtime_leases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    holderId: text('holder_id').notNull(),
    fencingToken: bigserial('fencing_token', { mode: 'bigint' }).notNull(),
    state: runtimeLeaseState('state').notNull().default('active'),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('runtime_leases_fencing_token_uq').on(table.fencingToken),
    uniqueIndex('runtime_leases_active_repository_uq')
      .on(table.repositoryId)
      .where(sql`${table.state} = 'active'`),
    index('runtime_leases_expires_at_idx').on(table.expiresAt),
  ],
);

export type RuntimeLease = typeof runtimeLeases.$inferSelect;
export type NewRuntimeLease = typeof runtimeLeases.$inferInsert;
