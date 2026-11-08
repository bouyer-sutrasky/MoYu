import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversations } from './conversations';
import { artifactType } from './enums';
import { messages } from './messages';
import { repositories } from './repositories';
import { taskLinks } from './task-links';

/**
 * Delivered artifacts: diffs, check results, PR references, logs and uploaded
 * attachments. storageKey is an internal reference, never a user-supplied path.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    taskId: uuid('task_id').references(() => taskLinks.id, { onDelete: 'set null' }),
    /** The message an uploaded attachment was sent with; a review artifact has none. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    type: artifactType('type').notNull(),
    storageKey: text('storage_key'),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('artifacts_task_idx').on(table.taskId),
    index('artifacts_conversation_idx').on(table.conversationId),
    index('artifacts_message_idx').on(table.messageId),
    uniqueIndex('artifacts_storage_key_uq')
      .on(table.storageKey)
      .where(sql`${table.storageKey} is not null`),
    check(
      'artifacts_size_bytes_nonnegative',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
  ],
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
