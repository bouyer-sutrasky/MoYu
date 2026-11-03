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
  version: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type TaskSummary = z.infer<typeof taskSummarySchema>;

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
