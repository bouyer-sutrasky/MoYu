import { z } from 'zod';

import { eventSeqSchema, isoTimestampSchema, uuidSchema } from './common';

export const workspaceEventTypeSchema = z.enum([
  'message.created',
  'message.delivery_changed',
  'task.linked',
  'task.state_changed',
  'task.progress',
  'task.question',
  'artifact.created',
  'runtime.state_changed',
]);

export type WorkspaceEventType = z.infer<typeof workspaceEventTypeSchema>;

export const workspaceEventSchema = z.object({
  id: z.string().min(1),
  seq: eventSeqSchema,
  type: workspaceEventTypeSchema,
  repositoryId: uuidSchema.optional(),
  conversationId: uuidSchema.optional(),
  taskId: uuidSchema.optional(),
  occurredAt: isoTimestampSchema,
  data: z.unknown(),
});

export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
