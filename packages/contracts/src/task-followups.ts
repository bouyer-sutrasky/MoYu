import { z } from 'zod';

import { conversationSummarySchema } from './conversations';
import { modelSelectionSchema, taskStateSchema } from './tasks';
import { uuidSchema } from './common';

/** The source facts a "new task from this task" action inherits explicitly, never implicitly. */
export const taskInheritanceSchema = z.object({
  fromTaskId: uuidSchema,
  fromConversationId: uuidSchema,
  fromRepositoryId: uuidSchema,
  fromState: taskStateSchema,
  /** The source task's pull request, when it delivered one; the new task never owns it. */
  pullRequest: z
    .object({ url: z.string().min(1), number: z.number().int().positive().nullable() })
    .nullable(),
  /** The latest delivery summary the source task reported, bounded for display. */
  deliverySummary: z.string().nullable(),
  baseBranch: z.string().min(1),
  baseCommit: z.string().nullable(),
  /** The old worktree is never reused; a new task always starts from the chosen base. */
  worktreeRecoverable: z.boolean(),
  worktreeNote: z.string().min(1),
  /** `closed_unmerged` starts a new task; it never reopens the old PR or resumes the old scene. */
  recovery: z.enum(['completed_new_task', 'closed_unmerged_new_task']),
  recoveryNote: z.string().min(1),
  reopensPullRequest: z.literal(false),
  reusesSourceExecution: z.literal(false),
});

export type TaskInheritance = z.infer<typeof taskInheritanceSchema>;

export const newTaskFromTaskPreviewDataSchema = z.object({
  inheritance: taskInheritanceSchema,
  /** The start point the creation form proposes; the owner still confirms it. */
  suggestedTarget: z.object({
    repositoryId: uuidSchema,
    baseBranch: z.string().min(1),
    baseCommit: z.string().nullable(),
  }),
});

export type NewTaskFromTaskPreviewData = z.infer<typeof newTaskFromTaskPreviewDataSchema>;

export const newTaskFromTaskInputSchema = z
  .object({
    repositoryId: uuidSchema,
    baseBranch: z.string().trim().min(1).max(255),
    baseCommit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/)
      .nullable()
      .optional(),
    model: modelSelectionSchema.nullable().optional(),
    /** One id per opened confirmation, so a double click creates one task. */
    clientRequestId: z.string().trim().min(1).max(128),
    /** The owner saw and accepted the target repository and start point. */
    confirmed: z.literal(true),
  })
  .strict();

export type NewTaskFromTaskInput = z.infer<typeof newTaskFromTaskInputSchema>;

export const newTaskFromTaskDataSchema = z.object({
  conversation: conversationSummarySchema,
  inheritance: taskInheritanceSchema,
  /** The new execution identity; it is never the source task's session or ticket. */
  executionIdentity: z.object({
    conversationId: uuidSchema,
    taskId: uuidSchema,
    upstreamTicketId: z.string().nullable(),
    reusesSourceSession: z.literal(false),
    startsFromCommit: z.string().nullable(),
  }),
});

export type NewTaskFromTaskData = z.infer<typeof newTaskFromTaskDataSchema>;
