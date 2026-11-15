import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';

/**
 * Review data for one task: the worktree diff, check runs and the delivery
 * (commit and pull request) the owner reviews. Everything here is collected
 * from real sources — the runtime worktree for changes and checks, GitHub for
 * the pull request state — and then stored as artifacts so a platform restart
 * does not lose it.
 */

export const reviewChangeStateSchema = z.enum([
  /** The worktree was read and its diff is shown. */
  'available',
  /** The task's worktree no longer exists because it was cleaned up. */
  'cleaned',
  /** Nothing could be read yet, with a stated reason. */
  'unavailable',
]);

export type ReviewChangeState = z.infer<typeof reviewChangeStateSchema>;

export const reviewFileStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'type_changed',
  'unknown',
]);

export type ReviewFileStatus = z.infer<typeof reviewFileStatusSchema>;

export const reviewFileSchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().nullable(),
  status: reviewFileStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  /** Unified diff for this file, as git printed it; null for a binary file. */
  patch: z.string().nullable(),
  patchTruncated: z.boolean(),
});

export type ReviewFile = z.infer<typeof reviewFileSchema>;

export const reviewChangesSchema = z.object({
  state: reviewChangeStateSchema,
  /** Why the data is missing, in owner-facing language; null when it is available. */
  reason: z.string().nullable(),
  /** When the runtime was read; null before the first collection. */
  collectedAt: isoTimestampSchema.nullable(),
  branch: z.string().nullable(),
  /** Full 40-character SHA of the worktree HEAD, never an abbreviation. */
  commit: z.string().nullable(),
  commitSubject: z.string().nullable(),
  committedAt: isoTimestampSchema.nullable(),
  files: z.array(reviewFileSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Files left out of `files` because of the collection limit. */
  filesOmitted: z.number().int().nonnegative(),
});

export type ReviewChanges = z.infer<typeof reviewChangesSchema>;

export const reviewCheckStateSchema = z.enum(['available', 'not_run', 'unavailable']);

export const reviewCheckRunSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  exitCode: z.number().int().nullable(),
  passed: z.boolean(),
  timedOut: z.boolean(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  durationMs: z.number().int().nonnegative(),
  summary: z.string(),
  /** Tail of the combined output, bounded by the runtime. */
  output: z.string(),
  outputTruncated: z.boolean(),
});

export type ReviewCheckRun = z.infer<typeof reviewCheckRunSchema>;

export const reviewChecksSchema = z.object({
  state: reviewCheckStateSchema,
  reason: z.string().nullable(),
  collectedAt: isoTimestampSchema.nullable(),
  runs: z.array(reviewCheckRunSchema),
});

export type ReviewChecks = z.infer<typeof reviewChecksSchema>;

export const reviewPullRequestStateSchema = z.enum(['open', 'closed', 'merged', 'unknown']);

export const reviewPullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  state: reviewPullRequestStateSchema,
  headSha: z.string().nullable(),
  baseBranch: z.string().nullable(),
  updatedAt: isoTimestampSchema.nullable(),
  /** Why the authoritative state could not be read; null when GitHub answered. */
  unavailableReason: z.string().nullable(),
});

export type ReviewPullRequest = z.infer<typeof reviewPullRequestSchema>;

export const taskReviewSchema = z.object({
  taskId: uuidSchema,
  conversationId: uuidSchema,
  changes: reviewChangesSchema,
  checks: reviewChecksSchema,
  pullRequest: reviewPullRequestSchema.nullable(),
});

export type TaskReview = z.infer<typeof taskReviewSchema>;

export const taskReviewDataSchema = z.object({ review: taskReviewSchema });

export type TaskReviewData = z.infer<typeof taskReviewDataSchema>;
