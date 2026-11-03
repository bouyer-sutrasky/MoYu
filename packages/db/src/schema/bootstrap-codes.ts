import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bootstrapCodePurpose } from './enums';
import { owners } from './owners';

/**
 * Short-lived, single-use binding codes created by the server-side owner CLI.
 * Only a SHA-256 digest of the printable code is stored. Exchanging a code
 * creates a registration-only cookie whose digest lives in tokenHash; the row is
 * completed when the credential is actually registered.
 */
export const bootstrapCodes = pgTable(
  'bootstrap_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: bootstrapCodePurpose('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    tokenHash: text('token_hash'),
    ownerId: uuid('owner_id').references(() => owners.id, { onDelete: 'cascade' }),
    requestIp: text('request_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('bootstrap_codes_code_hash_uq').on(table.codeHash),
    uniqueIndex('bootstrap_codes_token_hash_uq')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} is not null`),
    index('bootstrap_codes_expires_at_idx').on(table.expiresAt),
  ],
);

export type BootstrapCode = typeof bootstrapCodes.$inferSelect;
export type NewBootstrapCode = typeof bootstrapCodes.$inferInsert;
