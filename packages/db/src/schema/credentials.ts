import {
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

import { owners } from './owners';

/**
 * Passkey (WebAuthn) credential metadata. The credential public key is public
 * material; session secrets and binding codes are never stored here.
 */
export const passkeyCredentials = pgTable(
  'passkey_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up').notNull().default(false),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('passkey_credentials_credential_id_uq').on(table.credentialId),
    index('passkey_credentials_owner_idx').on(table.ownerId),
  ],
);

export type PasskeyCredential = typeof passkeyCredentials.$inferSelect;
export type NewPasskeyCredential = typeof passkeyCredentials.$inferInsert;
