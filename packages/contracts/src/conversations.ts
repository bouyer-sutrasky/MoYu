import { z } from 'zod';

import { isoTimestampSchema, pageCursorSchema, uuidSchema } from './common';
import { modelSelectionSchema, taskSummarySchema } from './tasks';

export const conversationModeSchema = z.enum(['work', 'chat']);

/** Where a Work conversation came from: the web composer or an imported GitHub ticket. */
export const conversationSourceSchema = z.enum(['web', 'github']);

/**
 * Creates one Work conversation and freezes its repository, branch start,
 * execution mode and model. `clientRequestId` is the creation idempotency key.
 */
export const createConversationInputSchema = z
  .object({
    repositoryId: uuidSchema,
    mode: conversationModeSchema.default('work'),
    executionMode: z.enum(['execute', 'discuss']).default('execute'),
    baseBranch: z.string().trim().min(1).max(255),
    model: modelSelectionSchema.nullable().optional(),
    clientRequestId: z.string().trim().min(1).max(128),
  })
  .strict();

export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;

export const conversationSummarySchema = z.object({
  id: uuidSchema,
  repositoryId: uuidSchema,
  mode: conversationModeSchema,
  executionMode: z.enum(['execute', 'discuss']),
  source: conversationSourceSchema,
  /** `github:<number>` for an imported ticket; null for a web conversation. */
  externalKey: z.string().nullable(),
  externalUrl: z.string().nullable(),
  /** Approved plan revision after a discussion became execution. */
  planRevision: z.number().int().positive().nullable(),
  baseBranch: z.string().min(1),
  baseCommit: z.string().nullable(),
  model: modelSelectionSchema.nullable(),
  title: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  task: taskSummarySchema.nullable(),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/**
 * Lists one repository's conversations, newest activity first. `cursor` is an
 * opaque keyset cursor scoped to the repository so a cursor cannot be reused
 * after switching repositories.
 */
export const conversationListQuerySchema = z.object({
  repositoryId: uuidSchema.optional(),
  cursor: pageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export const conversationListDataSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  /** Pass as `cursor` to load the next older page; null when no more remain. */
  nextCursor: pageCursorSchema.nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type ConversationListData = z.infer<typeof conversationListDataSchema>;

export const conversationDetailDataSchema = z.object({
  conversation: conversationSummarySchema,
});

export type ConversationDetailData = z.infer<typeof conversationDetailDataSchema>;
