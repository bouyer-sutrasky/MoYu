import { workspaceEventSchema, type WorkspaceEvent } from '@moyu/contracts';
import type { Event } from '@moyu/db';

/** Validates a durable event row against the shared discriminated event contract. */
export function eventToWorkspaceEvent(row: Event): WorkspaceEvent | null {
  const parsed = workspaceEventSchema.safeParse({
    id: row.id,
    seq: row.seq.toString(),
    type: row.type,
    repositoryId: row.repositoryId ?? undefined,
    conversationId: row.conversationId ?? undefined,
    taskId: row.taskId ?? undefined,
    occurredAt: row.occurredAt.toISOString(),
    data: row.payload,
  });
  return parsed.success ? parsed.data : null;
}
