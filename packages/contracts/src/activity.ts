import { z } from 'zod';

import { eventSeqSchema, isoTimestampSchema, uuidSchema } from './common';
import { taskStateSchema } from './tasks';

/**
 * A notification category the activity centre and the browser notification both
 * use. Ordinary progress is deliberately absent: only events that need a person
 * or report a terminal outcome become activity.
 */
export const activityCategorySchema = z.enum(['needs_reply', 'review', 'completed', 'failed']);

export type ActivityCategory = z.infer<typeof activityCategorySchema>;

export const ACTIVITY_CATEGORY_LABELS: Record<ActivityCategory, string> = {
  needs_reply: '需要回复',
  review: '待审阅',
  completed: '已完成',
  failed: '失败 / 受阻',
};

/**
 * One durable activity entry. `id` is the persisted event id, which is also the
 * browser-notification dedupe key across reconnect, refresh and several tabs.
 */
export const activityItemSchema = z.object({
  id: uuidSchema,
  seq: eventSeqSchema,
  category: activityCategorySchema,
  state: taskStateSchema,
  repositoryId: uuidSchema,
  repositoryName: z.string().min(1),
  conversationId: uuidSchema,
  taskId: uuidSchema.nullable(),
  title: z.string().nullable(),
  summary: z.string().min(1),
  occurredAt: isoTimestampSchema,
});

export type ActivityItem = z.infer<typeof activityItemSchema>;

/** A task that is currently occupying an execution slot; shown separately from alerts. */
export const activityRunningItemSchema = z.object({
  conversationId: uuidSchema,
  repositoryId: uuidSchema,
  repositoryName: z.string().min(1),
  taskId: uuidSchema,
  title: z.string().nullable(),
  state: taskStateSchema,
  updatedAt: isoTimestampSchema,
});

export type ActivityRunningItem = z.infer<typeof activityRunningItemSchema>;

export const activityQuerySchema = z.object({
  beforeSeq: eventSeqSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export const activityDataSchema = z.object({
  notifications: z.array(activityItemSchema),
  running: z.array(activityRunningItemSchema),
  /** Pass as `beforeSeq` for older alerts; null when no older page remains. */
  nextCursor: eventSeqSchema.nullable(),
  hasMore: z.boolean(),
});

export type ActivityData = z.infer<typeof activityDataSchema>;
