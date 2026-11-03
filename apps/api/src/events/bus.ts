import { EventEmitter } from 'node:events';

import type { WorkspaceEvent } from '@moyu/contracts';

/**
 * In-process fan-out for authenticated SSE streams. Durable replay still comes
 * from the events table; this bus only wakes live connections. A session
 * revocation is emitted so open streams close immediately instead of waiting for
 * the next heartbeat.
 */
export interface AppEventBus {
  emitSessionRevoked(sessionId: string): void;
  onSessionRevoked(sessionId: string, listener: () => void): () => void;
  publishWorkspaceEvent(event: WorkspaceEvent): void;
  onWorkspaceEvent(listener: (event: WorkspaceEvent) => void): () => void;
  close(): void;
}

const SESSION_REVOKED = 'session.revoked';
const WORKSPACE_EVENT = 'workspace.event';

export function createAppEventBus(): AppEventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  return {
    emitSessionRevoked(sessionId) {
      emitter.emit(SESSION_REVOKED, sessionId);
    },
    onSessionRevoked(sessionId, listener) {
      const handler = (revokedId: string) => {
        if (revokedId === sessionId) {
          listener();
        }
      };
      emitter.on(SESSION_REVOKED, handler);
      return () => emitter.off(SESSION_REVOKED, handler);
    },
    publishWorkspaceEvent(event) {
      emitter.emit(WORKSPACE_EVENT, event);
    },
    onWorkspaceEvent(listener) {
      emitter.on(WORKSPACE_EVENT, listener);
      return () => emitter.off(WORKSPACE_EVENT, listener);
    },
    close() {
      emitter.removeAllListeners();
    },
  };
}
