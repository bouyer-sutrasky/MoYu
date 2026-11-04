import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';

export const executionModeSchema = z.enum(['execute', 'discuss']);

export const taskStateSchema = z.enum([
  'pending_admission',
  'discussing',
  'queued',
  'running',
  'waiting_input',
  'awaiting_review',
  'stopping',
  'stopped',
  'blocked',
  'failed',
  'completed',
  'closed_unmerged',
  'not_accepted',
]);

export type TaskState = z.infer<typeof taskStateSchema>;

/** A model identity selected from the runtime's own configured catalog. */
export const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).nullable().optional(),
});

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const modelOptionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1).nullable(),
  reasoningEfforts: z.array(z.string()),
});

export type ModelOption = z.infer<typeof modelOptionSchema>;

export const modelListDataSchema = z.object({
  repositoryId: uuidSchema,
  models: z.array(modelOptionSchema),
});

export type ModelListData = z.infer<typeof modelListDataSchema>;

/** One owner command for a task; `start` also carries the approved plan revision. */
export const taskOperationKindSchema = z.enum(['start', 'pause', 'resume', 'retry']);

export type TaskOperationKind = z.infer<typeof taskOperationKindSchema>;

export const taskOperationStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);

export type TaskOperationState = z.infer<typeof taskOperationStateSchema>;

export const taskOperationSummarySchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema,
  kind: taskOperationKindSchema,
  state: taskOperationStateSchema,
  /** Execution evidence the runtime returned, such as the stop evidence object. */
  evidence: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type TaskOperationSummary = z.infer<typeof taskOperationSummarySchema>;

export const taskCommandInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    clientCommandId: z.string().trim().min(1).max(128),
  })
  .strict();

export type TaskCommandInput = z.infer<typeof taskCommandInputSchema>;

export const startTaskInputSchema = taskCommandInputSchema
  .extend({ planRevision: z.number().int().positive() })
  .strict();

export type StartTaskInput = z.infer<typeof startTaskInputSchema>;

export const taskSummarySchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  repositoryId: uuidSchema,
  state: taskStateSchema,
  upstreamTicketId: z.string().nullable(),
  upstreamThreadId: z.string().nullable(),
  baseBranch: z.string().min(1),
  baseCommit: z.string().nullable(),
  model: modelSelectionSchema.nullable(),
  executionMode: executionModeSchema,
  question: z.string().nullable(),
  questionMessageId: uuidSchema.nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  planRevision: z.number().int().positive().nullable(),
  stopRequestedAt: isoTimestampSchema.nullable(),
  stoppedAt: isoTimestampSchema.nullable(),
  /** Runtime proof the worker and its background work ended; empty until a stop completes. */
  stopEvidence: z.record(z.string(), z.unknown()),
  /** The latest owner command for this task, so the UI can show a pending stop or start. */
  lastOperation: taskOperationSummarySchema.nullable(),
  version: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskCommandDataSchema = z.object({
  operation: taskOperationSummarySchema,
  task: taskSummarySchema,
});

export type TaskCommandData = z.infer<typeof taskCommandDataSchema>;

export const artifactTypeSchema = z.enum([
  'diff',
  'check_report',
  'pull_request',
  'attachment',
  'log',
  'other',
]);

export const artifactSummarySchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema.nullable(),
  conversationId: uuidSchema.nullable(),
  type: artifactTypeSchema,
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: isoTimestampSchema,
});

export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactListDataSchema = z.object({
  artifacts: z.array(artifactSummarySchema),
});

export type ArtifactListData = z.infer<typeof artifactListDataSchema>;
