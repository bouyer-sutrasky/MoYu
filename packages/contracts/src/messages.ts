import { z } from 'zod';

import { isoTimestampSchema, pageCursorSchema, uuidSchema } from './common';

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

/**
 * Reads one page of a conversation in ascending message order. `before` loads
 * the page immediately older than a cursor; `after` loads messages newer than
 * a cursor (used to merge SSE arrivals into an already loaded history). Both
 * are opaque server cursors and are mutually exclusive.
 */
export const messageListQuerySchema = z
  .object({
    before: pageCursorSchema.optional(),
    after: pageCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((value) => value.before === undefined || value.after === undefined, {
    message: 'before and after are mutually exclusive',
  });

export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

/** One message with its current delivery projection, used to refresh an already loaded row. */
export const messageDetailDataSchema = z.object({
  message: messageSchema,
});

export type MessageDetailData = z.infer<typeof messageDetailDataSchema>;

export const messageListDataSchema = z.object({
  messages: z.array(messageSchema),
  /** Pass as `before` to load the next older page; null when no older message exists. */
  nextCursor: pageCursorSchema.nullable(),
  /** Cursor of the newest message in this response; pass as `after` to merge newer messages. */
  newerCursor: pageCursorSchema.nullable(),
  /** Whether older messages exist beyond this page. */
  hasMore: z.boolean().default(false),
  /** Whether newer messages exist beyond this page (only meaningful for an `after` query). */
  hasNewer: z.boolean().default(false),
});

export type MessageListData = z.infer<typeof messageListDataSchema>;
