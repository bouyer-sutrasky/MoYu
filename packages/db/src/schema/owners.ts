import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * MoYu is a single-owner product. This row is the owner identity referenced by
 * credentials, sessions and conversations; it is not a multi-user account model.
 */
export const owners = pgTable('owners', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Owner = typeof owners.$inferSelect;
export type NewOwner = typeof owners.$inferInsert;
