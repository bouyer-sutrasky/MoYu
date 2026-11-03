import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';
import { modelSelectionSchema, taskSummarySchema } from './tasks';

export const conversationModeSchema = z.enum(['work', 'chat']);

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
  baseBranch: z.string().min(1),
  baseCommit: z.string().nullable(),
  model: modelSelectionSchema.nullable(),
  title: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  task: taskSummarySchema.nullable(),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListDataSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});

export type ConversationListData = z.infer<typeof conversationListDataSchema>;

export const conversationDetailDataSchema = z.object({
  conversation: conversationSummarySchema,
});

export type ConversationDetailData = z.infer<typeof conversationDetailDataSchema>;
