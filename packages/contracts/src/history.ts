import { z } from 'zod';

import { pageCursorSchema, uuidSchema } from './common';
import { conversationSummarySchema } from './conversations';
import { taskStateSchema } from './tasks';

/**
 * Owner-scoped history search. Filters are part of the cursor scope, so a cursor
 * cannot be replayed against a different keyword, repository or state filter.
 */
export const historySearchQuerySchema = z.object({
  q: z.string().max(2000).optional(),
  repositoryId: uuidSchema.optional(),
  state: z.union([taskStateSchema, z.literal('none')]).optional(),
  cursor: pageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type HistorySearchQuery = z.infer<typeof historySearchQuerySchema>;

export const historySearchItemSchema = z.object({
  conversation: conversationSummarySchema,
  repository: z.object({
    id: uuidSchema,
    fullName: z.string().min(1),
  }),
  /** Which field matched; `recent` means no keyword was supplied. */
  matched: z.enum(['title', 'message', 'recent']),
  /** The matching message body, bounded for display; null for a title-only match. */
  snippet: z.string().nullable(),
});

export type HistorySearchItem = z.infer<typeof historySearchItemSchema>;

export const historySearchDataSchema = z.object({
  items: z.array(historySearchItemSchema),
  nextCursor: pageCursorSchema.nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type HistorySearchData = z.infer<typeof historySearchDataSchema>;
