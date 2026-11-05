import type { ApiConfig } from '../config';

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
        throw new Error(payload.error?.message ?? `supervisor request failed (${response.status})`);
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
  };
}
