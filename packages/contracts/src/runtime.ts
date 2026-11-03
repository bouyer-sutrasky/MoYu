import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';
import { taskSummarySchema } from './tasks';

/**
 * Machine callback from the repository's private Bridge to the platform. Only
 * the Bridge's workspace Channel uses it in M3: acknowledgements, questions,
 * results and notices that must appear in the conversation.
 */
export const channelMessageEventSchema = z
  .object({
    sourceEventId: z.string().min(1).max(256),
    type: z.literal('channel.message'),
    conversationId: uuidSchema,
    ticketId: z.string().min(1).nullable(),
    triggerId: z.string().min(1).nullable(),
    messageKind: z.enum(['acknowledgement', 'question', 'reply', 'result', 'notice']),
    text: z.string().min(1).max(20_000),
    at: isoTimestampSchema,
  })
  .strict();

export const runtimeEventInputSchema = z.discriminatedUnion('type', [channelMessageEventSchema]);

export type RuntimeEventInput = z.infer<typeof runtimeEventInputSchema>;

export const runtimeEventDataSchema = z.object({
  messageId: uuidSchema,
  duplicate: z.boolean(),
  task: taskSummarySchema.nullable(),
});

export type RuntimeEventData = z.infer<typeof runtimeEventDataSchema>;

/** Capability document served by the runtime Bridge. */
export const bridgeCapabilitiesSchema = z.object({
  protocolVersion: z.string().min(1),
  upstream: z.object({
    package: z.string().optional(),
    version: z.string().optional(),
    commit: z.string().nullable().optional(),
  }),
  capabilities: z.object({
    trigger: z.boolean(),
    events: z.boolean(),
    tickets: z.boolean(),
    models: z.boolean(),
    pause: z.boolean(),
    resume: z.boolean(),
    retry: z.boolean(),
    readOnlyDiscussion: z.boolean(),
  }),
  source: z.object({ kind: z.string(), enabled: z.boolean() }),
});

export type BridgeCapabilities = z.infer<typeof bridgeCapabilitiesSchema>;

export const bridgeModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1).nullable().optional(),
  reasoningEfforts: z.array(z.string()).optional(),
});

export const bridgeModelListSchema = z.object({ models: z.array(bridgeModelSchema) });

export type BridgeModelList = z.infer<typeof bridgeModelListSchema>;

export const bridgeTriggerInputSchema = z
  .object({
    triggerId: z.string().min(1).max(256),
    conversationId: uuidSchema,
    messageId: uuidSchema,
    replyToMessageId: uuidSchema.nullable(),
    actor: z.object({ id: z.string().min(1), name: z.string().optional() }),
    text: z.string().min(1).max(20_000),
    at: isoTimestampSchema,
    executionSpec: z.object({
      repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
      baseBranch: z.string().min(1),
      baseCommit: z
        .string()
        .regex(/^[0-9a-f]{7,64}$/)
        .nullable(),
      model: z
        .object({
          provider: z.string().min(1),
          model: z.string().min(1),
          reasoningEffort: z.string().min(1).nullable().optional(),
        })
        .nullable(),
      mode: z.enum(['execute', 'discuss']),
    }),
  })
  .strict();

export type BridgeTriggerInput = z.infer<typeof bridgeTriggerInputSchema>;

export const bridgeTriggerResultSchema = z.object({
  result: z.enum(['stored', 'duplicate', 'filtered']),
  triggerId: z.string().min(1),
  baseCommit: z.string().nullable(),
  ticketId: z.string().nullable(),
});

export type BridgeTriggerResult = z.infer<typeof bridgeTriggerResultSchema>;

export const bridgeEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  id: z.string().min(1),
  type: z.string().min(1),
  at: isoTimestampSchema,
  data: z.record(z.string(), z.unknown()),
});

export const bridgeEventPageSchema = z.object({
  events: z.array(bridgeEventSchema),
  next: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export type BridgeEvent = z.infer<typeof bridgeEventSchema>;
export type BridgeEventPage = z.infer<typeof bridgeEventPageSchema>;
