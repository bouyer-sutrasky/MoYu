import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';

export const messageDirectionSchema = z.enum(['inbound', 'outbound']);

/**
 * Delivery evidence levels: platform receipt (`stored`), an active dispatcher
 * lease (`delivering`), runtime acceptance (`delivered`), and worker-session
 * history proof that the model could read it (`read`).
 */
export const deliveryStateSchema = z.enum(['stored', 'delivering', 'delivered', 'read', 'failed']);

export type DeliveryState = z.infer<typeof deliveryStateSchema>;

/** Kinds of outbound Channel replies; inbound web messages use `user`. */
export const messageKindSchema = z.enum([
  'user',
  'acknowledgement',
  'question',
  'reply',
  'result',
  'notice',
  'progress',
]);

export type MessageKind = z.infer<typeof messageKindSchema>;

export const deliverySummarySchema = z.object({
  state: deliveryStateSchema,
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  deliveredAt: isoTimestampSchema.nullable(),
  handedToWorkerAt: isoTimestampSchema.nullable(),
  readAt: isoTimestampSchema.nullable(),
});

export type DeliverySummary = z.infer<typeof deliverySummarySchema>;

export const messageSchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  direction: messageDirectionSchema,
  kind: messageKindSchema,
  clientMessageId: z.string().nullable(),
  body: z.string(),
  replyToMessageId: uuidSchema.nullable(),
  source: z.string().min(1),
  createdAt: isoTimestampSchema,
  delivery: deliverySummarySchema.nullable(),
});

export type Message = z.infer<typeof messageSchema>;

export const createMessageInputSchema = z.object({
  clientMessageId: z.string().trim().min(1).max(128),
  text: z.string().trim().min(1).max(20_000),
  replyToMessageId: uuidSchema.optional(),
  attachmentIds: z.array(uuidSchema).max(20).optional(),
});

export type CreateMessageInput = z.infer<typeof createMessageInputSchema>;

export const createMessageDataSchema = z.object({
  message: messageSchema,
  duplicate: z.boolean(),
});

export type CreateMessageData = z.infer<typeof createMessageDataSchema>;

export const messageListDataSchema = z.object({
  messages: z.array(messageSchema),
  nextCursor: z.string().nullable(),
});

export type MessageListData = z.infer<typeof messageListDataSchema>;
