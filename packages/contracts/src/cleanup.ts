import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';

/**
 * Worktree cleanup is a destructive edge, so the client only ever holds a
 * server-issued preview. Execution names that preview run; the API resolves
 * paths itself through the host supervisor and re-checks every safety rule.
 */
export const cleanupRetentionDaysDefault = 7;

export const cleanupRunModeSchema = z.enum(['preview', 'execute']);
export const cleanupRunStatusSchema = z.enum([
  'preview',
  'running',
  'completed',
  'partial',
  'failed',
]);
export const cleanupItemStateSchema = z.enum([
  'planned',
  'removed',
  'skipped',
  'failed',
  'already_cleaned',
]);

export type CleanupRunMode = z.infer<typeof cleanupRunModeSchema>;
export type CleanupRunStatus = z.infer<typeof cleanupRunStatusSchema>;
export type CleanupItemState = z.infer<typeof cleanupItemStateSchema>;

export const cleanupItemSchema = z.object({
  id: uuidSchema,
  ticketId: z.string().min(1),
  conversationId: uuidSchema.nullable(),
  repositoryId: uuidSchema,
  repositoryName: z.string().min(1),
  profile: z.string().nullable(),
  /** Real path reported by the host supervisor; null when no directory was found. */
  directory: z.string().nullable(),
  state: cleanupItemStateSchema,
  eligible: z.boolean(),
  /** Why this item will be removed or why it is skipped. */
  reason: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().nullable(),
  modifiedAt: isoTimestampSchema.nullable(),
  detail: z.record(z.string(), z.unknown()),
});

export type CleanupItem = z.infer<typeof cleanupItemSchema>;

export const cleanupRunSummarySchema = z.object({
  candidates: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  alreadyCleaned: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  bytesFreed: z.number().int().nonnegative(),
});

export type CleanupRunSummary = z.infer<typeof cleanupRunSummarySchema>;

export const cleanupRunSchema = z.object({
  id: uuidSchema,
  mode: cleanupRunModeSchema,
  status: cleanupRunStatusSchema,
  retentionDays: z.number().int().positive(),
  /** The preview this execution was confirmed from; null for a preview run. */
  previewOfRunId: uuidSchema.nullable(),
  summary: cleanupRunSummarySchema,
  error: z.string().nullable(),
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
  items: z.array(cleanupItemSchema),
});

export type CleanupRun = z.infer<typeof cleanupRunSchema>;

export const cleanupPreviewInputSchema = z
  .object({
    repositoryId: uuidSchema.optional(),
  })
  .strict();

export type CleanupPreviewInput = z.infer<typeof cleanupPreviewInputSchema>;

export const cleanupPreviewDataSchema = z.object({
  run: cleanupRunSchema,
});

export type CleanupPreviewData = z.infer<typeof cleanupPreviewDataSchema>;

export const cleanupExecuteInputSchema = z
  .object({
    /** The preview run the person explicitly confirmed. */
    runId: uuidSchema,
  })
  .strict();

export type CleanupExecuteInput = z.infer<typeof cleanupExecuteInputSchema>;

export const cleanupExecuteDataSchema = z.object({
  run: cleanupRunSchema,
  /** True when the same preview was already executed; the stored result is returned. */
  duplicate: z.boolean(),
});

export type CleanupExecuteData = z.infer<typeof cleanupExecuteDataSchema>;

export const cleanupRunsDataSchema = z.object({
  runs: z.array(cleanupRunSchema),
});

export type CleanupRunsData = z.infer<typeof cleanupRunsDataSchema>;

export const cleanupRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type CleanupRunsQuery = z.infer<typeof cleanupRunsQuerySchema>;
