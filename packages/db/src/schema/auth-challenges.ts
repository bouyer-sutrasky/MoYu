import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { authChallengeKind } from './enums';
import { owners } from './owners';

/**
 * Short-lived, single-use WebAuthn challenges. Consumption is an atomic update
 * of consumedAt; the cerememony row is kept only long enough for audit.
 */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').references(() => owners.id, { onDelete: 'cascade' }),
    kind: authChallengeKind('kind').notNull(),
    challenge: text('challenge').notNull(),
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [index('auth_challenges_expires_at_idx').on(table.expiresAt)],
);

export type AuthChallenge = typeof authChallenges.$inferSelect;
export type NewAuthChallenge = typeof authChallenges.$inferInsert;
