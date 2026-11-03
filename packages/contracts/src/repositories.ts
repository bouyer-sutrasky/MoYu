import { z } from 'zod';

import { isoTimestampSchema, uuidSchema } from './common';

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
