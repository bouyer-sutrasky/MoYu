import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';

export const messageDirectionSchema = z.enum(['inbound', 'outbound']);
export const deliveryStateSchema = z.enum(['pending', 'delivering', 'delivered', 'failed']);

export const createMessageInputSchema = z.object({
  clientMessageId: z.string().trim().min(1).max(128),
  text: z.string().trim().min(1).max(20_000),
  replyToMessageId: uuidSchema.optional(),
  attachmentIds: z.array(uuidSchema).max(20).optional(),
});

export type CreateMessageInput = z.infer<typeof createMessageInputSchema>;

export const messageSchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  direction: messageDirectionSchema,
  clientMessageId: z.string().nullable(),
  body: z.string(),
  replyToMessageId: uuidSchema.nullable(),
  createdAt: isoTimestampSchema,
});

export type Message = z.infer<typeof messageSchema>;
