import type { ReviewChanges, ReviewCheckRun } from '@moyu/contracts';

import type { ApiConfig } from '../config';

/**
 * A non-2xx answer from the supervisor control API. The original status is kept
 * so a repository-configuration refusal (422) is not flattened into a generic
 * "runtime unavailable" error at the platform boundary.
 */
export class SupervisorRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SupervisorRequestError';
  }
}

export interface SupervisorInstance {
  repositoryId: string;
  state: 'sleeping' | 'starting' | 'online' | 'stopping' | 'fault';
  desiredState: 'sleeping' | 'online';
  reasonCode: string;
  reasonDetail: string | null;
  waitingFor: string | null;
  queuePriority: number;
  wakeRequestedAt: string | null;
  lastActivityAt: string | null;
  lastProgressAt: string | null;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  lastHealthAt: string | null;
  pid: number | null;
  port: number | null;
  profile: string | null;
  attemptCount: number;
  errorCode: string | null;
  errorDetail: string | null;
  updatedAt: string;
}

export interface SupervisorClient {
  prepare(repositoryId: string): Promise<SupervisorInstance>;
  wake(
    repositoryId: string,
    reason: 'new_task' | 'reply' | 'manual' | 'retry',
  ): Promise<{ accepted: boolean; duplicate: boolean; instance: SupervisorInstance }>;
  sleep(
    repositoryId: string,
    manual: boolean,
  ): Promise<{ accepted: boolean; duplicate: boolean; instance: SupervisorInstance }>;
  touch(repositoryId: string): Promise<SupervisorInstance>;
  reviewChanges(repositoryId: string, ticketId: string): Promise<SupervisorChanges>;
  reviewChecks(
    repositoryId: string,
    ticketId: string,
  ): Promise<{ worktree: SupervisorWorktree; runs: ReviewCheckRun[] }>;
  cleanupInspect(repositoryId: string, ticketId: string): Promise<SupervisorCleanupInspection>;
  cleanupDelete(repositoryId: string, ticketId: string): Promise<SupervisorCleanupRemoval>;
  cleanupTrash(repositoryId: string): Promise<SupervisorTrashResult>;
}

/** Host-side worktree inspection payload, as the supervisor reports it. */
export interface SupervisorWorktree {
  state: 'available' | 'cleaned' | 'unavailable';
  directory: string | null;
  reason: string | null;
  profile: string | null;
}

export interface SupervisorChanges extends Omit<ReviewChanges, 'collectedAt'> {
  directory: string | null;
}

/** The host supervisor's real-path inspection of one ticket worktree. */
export interface SupervisorCleanupInspection {
  ticketId: string;
  state: 'available' | 'cleaned' | 'unavailable';
  reason: string | null;
  directory: string | null;
  profile: string | null;
  branch: string | null;
  commit: string | null;
  upstream: string | null;
  ahead: number | null;
  dirty: boolean;
  dirtyEntries: number;
  unpushed: boolean;
  unpushedCommits: number | null;
  occupied: boolean;
  occupiedBy: Array<{ pid: number; command: string }>;
  locked: boolean;
  sizeBytes: number | null;
  fileCount: number;
  modifiedAt: string | null;
  eligible: boolean;
  reasons: string[];
}

export interface SupervisorCleanupRemoval {
  state: 'removed' | 'already_cleaned' | 'quarantined';
  directory: string | null;
  trashPath: string | null;
  bytesFreed: number;
  reason: string;
  pruned: boolean;
  pruneError: string | null;
}

export interface SupervisorTrashResult {
  removed: number;
  bytesFreed: number;
  failures: Array<{ path: string; error: string }>;
}

/**
 * Loopback client for the host supervisor. It sends a repository id and a fixed
 * action only; the supervisor resolves profile, state, port, worktree and
 * credentials from its own configuration.
 */
export function createSupervisorClient(config: ApiConfig): SupervisorClient | null {
  if (!config.supervisorUrl || !config.supervisorToken) return null;
  const base = config.supervisorUrl.replace(/\/+$/, '');
  const request = async <T>(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    timeoutMs = 10_000,
    acceptStatuses: number[] = [200],
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.supervisorToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: T;
        error?: { message?: string };
      };
      if ((!response.ok && !acceptStatuses.includes(response.status)) || !payload.data) {
        throw new SupervisorRequestError(
          response.ok ? 502 : response.status,
          payload.error?.message ?? `supervisor request failed (${response.status})`,
        );
      }
      return payload.data;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    prepare: (repositoryId) => request(`/control/v1/instances/${repositoryId}/prepare`, 'POST', {}),
    wake: (repositoryId, reason) =>
      request(`/control/v1/instances/${repositoryId}/wake`, 'POST', {
        reason,
        priority: reason === 'reply' ? 10 : reason === 'retry' ? 5 : 20,
      }),
    sleep: (repositoryId, manual) =>
      request(
        `/control/v1/instances/${repositoryId}/sleep`,
        'POST',
        { manual },
        40_000,
        [200, 409],
      ),
    touch: (repositoryId) => request(`/control/v1/instances/${repositoryId}/touch`, 'POST', {}),
    reviewChanges: (repositoryId, ticketId) =>
      request(`/control/v1/instances/${repositoryId}/review/changes`, 'POST', { ticketId }),
    reviewChecks: (repositoryId, ticketId) =>
      request(
        `/control/v1/instances/${repositoryId}/review/checks`,
        'POST',
        { ticketId },
        // A check run is long by nature; the supervisor bounds each command.
        960_000,
      ),
    cleanupInspect: (repositoryId, ticketId) =>
      request(`/control/v1/instances/${repositoryId}/cleanup/inspect`, 'POST', { ticketId }),
    cleanupDelete: (repositoryId, ticketId) =>
      request(`/control/v1/instances/${repositoryId}/cleanup/delete`, 'POST', { ticketId }),
    cleanupTrash: (repositoryId) =>
      request(`/control/v1/instances/${repositoryId}/cleanup/trash`, 'POST', {}),
  };
}
