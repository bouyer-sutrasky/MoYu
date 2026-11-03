import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { passkeyCredentials } from './credentials';
import { owners } from './owners';

/**
 * Server-side browser sessions. Only the digest of the random session token is
 * stored, so a database read does not expose a usable cookie. expiresAt is
 * rolled forward on authenticated activity; there is no fixed re-verification
 * timer, matching the long-lived-login product decision.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id').references(() => passkeyCredentials.id, {
      onDelete: 'set null',
    }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '90 days'`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    index('sessions_owner_idx').on(table.ownerId),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
