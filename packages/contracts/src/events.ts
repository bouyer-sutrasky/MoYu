import { z } from 'zod';

import { eventSeqSchema, isoTimestampSchema, uuidSchema } from './common';
import { artifactSummarySchema, taskSummarySchema } from './tasks';

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

export const workspaceEventDataSchemas = {
  'message.created': z.object({
    messageId: uuidSchema,
    direction: z.enum(['inbound', 'outbound']),
  }),
  'message.delivery_changed': z.object({
    messageId: uuidSchema,
    deliveryState: z.enum(['stored', 'delivering', 'delivered', 'read', 'failed']),
  }),
  'task.linked': z.object({ task: taskSummarySchema }),
  'task.state_changed': z.object({ task: taskSummarySchema }),
  'task.question': z.object({ task: taskSummarySchema }),
  'task.progress': z.object({
    ticketId: z.string().min(1),
    text: z.string().max(4000),
    at: isoTimestampSchema,
  }),
  'artifact.created': z.object({ artifact: artifactSummarySchema }),
  'runtime.state_changed': z.object({
    status: z.enum(['online', 'offline', 'degraded']),
    detail: z.string().optional(),
  }),
} as const;

const base = {
  id: z.string().min(1),
  seq: eventSeqSchema,
  repositoryId: uuidSchema.optional(),
  conversationId: uuidSchema.optional(),
  taskId: uuidSchema.optional(),
  occurredAt: isoTimestampSchema,
};

/**
 * Durable event kinds share one envelope; `data` is discriminated per type so
 * the API, SSE route and web client validate the same payloads.
 */
export const workspaceEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('message.created'),
    data: workspaceEventDataSchemas['message.created'],
  }),
  z.object({
    ...base,
    type: z.literal('message.delivery_changed'),
    data: workspaceEventDataSchemas['message.delivery_changed'],
  }),
  z.object({
    ...base,
    type: z.literal('task.linked'),
    data: workspaceEventDataSchemas['task.linked'],
  }),
  z.object({
    ...base,
    type: z.literal('task.state_changed'),
    data: workspaceEventDataSchemas['task.state_changed'],
  }),
  z.object({
    ...base,
    type: z.literal('task.progress'),
    data: workspaceEventDataSchemas['task.progress'],
  }),
  z.object({
    ...base,
    type: z.literal('task.question'),
    data: workspaceEventDataSchemas['task.question'],
  }),
  z.object({
    ...base,
    type: z.literal('artifact.created'),
    data: workspaceEventDataSchemas['artifact.created'],
  }),
  z.object({
    ...base,
    type: z.literal('runtime.state_changed'),
    data: workspaceEventDataSchemas['runtime.state_changed'],
  }),
]);

export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
