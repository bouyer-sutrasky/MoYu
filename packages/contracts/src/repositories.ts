import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';
import { executionModeSchema, modelSelectionSchema } from './tasks';

export const repositoryStatusSchema = z.enum(['provisioning', 'active', 'sleeping', 'error']);

export type RepositoryStatus = z.infer<typeof repositoryStatusSchema>;

export const repositorySummarySchema = z.object({
  id: uuidSchema,
  fullName: z.string().min(1),
  githubRepositoryId: z.number().int().nullable(),
  defaultBranch: z.string().min(1),
  status: repositoryStatusSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type RepositorySummary = z.infer<typeof repositorySummarySchema>;

export const repositoryListDataSchema = z.object({
  repositories: z.array(repositorySummarySchema),
});

/**
 * Per-repository task defaults. A saved preference never changes a task that is
 * already frozen: the conversation and task copy the chosen values at creation.
 */
export const repositoryPreferencesSchema = z.object({
  executionMode: executionModeSchema,
  baseBranch: z.string().trim().min(1).max(255),
  model: modelSelectionSchema.nullable(),
});

export type RepositoryPreferences = z.infer<typeof repositoryPreferencesSchema>;

export const repositoryPreferencesInputSchema = repositoryPreferencesSchema.strict();

export type RepositoryPreferencesInput = z.infer<typeof repositoryPreferencesInputSchema>;

export const repositoryPreferencesDataSchema = z.object({
  repositoryId: uuidSchema,
  /** The stored preference, or null when the repository defaults are in use. */
  preferences: repositoryPreferencesSchema.nullable(),
  /** The values the next task would actually use, including repository defaults. */
  effective: repositoryPreferencesSchema.extend({
    source: z.enum(['saved', 'repository']),
  }),
  updatedAt: isoTimestampSchema.nullable(),
});

export type RepositoryPreferencesData = z.infer<typeof repositoryPreferencesDataSchema>;

export const repositoryBranchSchema = z.object({
  name: z.string().min(1),
  commit: z.string().nullable(),
});

export type RepositoryBranch = z.infer<typeof repositoryBranchSchema>;

/**
 * Branch availability as reported by the repository runtime. `unsupported`
 * means the runtime cannot list branches at all, so the UI must not claim that
 * a branch is missing; it can only show that availability is unverified.
 */
export const repositoryBranchListDataSchema = z.object({
  repositoryId: uuidSchema,
  status: z.enum(['ready', 'unsupported']),
  branches: z.array(repositoryBranchSchema),
  hasMore: z.boolean(),
  checkedAt: isoTimestampSchema,
});

export type RepositoryBranchListData = z.infer<typeof repositoryBranchListDataSchema>;
