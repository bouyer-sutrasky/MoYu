import {
  appendEvent as appendDurableEvent,
  type AppendEventInput as DurableEventInput,
  type DatabaseTransaction,
} from '@moyu/db';
import type { Event } from '@moyu/db';
import type { WorkspaceEventType } from '@moyu/contracts';

export type { DatabaseTransaction };

export interface AppendEventInput extends Omit<DurableEventInput, 'type'> {
  type: WorkspaceEventType;
}

export function appendEvent(
  database: DatabaseTransaction,
  input: AppendEventInput,
): Promise<Event | null> {
  return appendDurableEvent(database, input);
}
