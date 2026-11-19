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
  activationRequestedAt: string | null;
  lastActivityAt: string | null;
  lastProgressAt: string | null;
  lastStartedAt: string | null;
  lastOnlineAt: string | null;
  lastStoppedAt: string | null;
  lastHealthAt: string | null;
  pid: number | null;
  port: number | null;
  profile: string | null;
  attemptCount: number;
  errorCode: string | null;
  errorDetail: string | null;
  gitState: 'none' | 'preparing' | 'ready' | 'failed';
  gitPhase: string | null;
  gitProgress: number | null;
  gitDetail: string | null;
  gitStartedAt: string | null;
  gitFinishedAt: string | null;
  gitAttempts: number;
  gitHead: string | null;
  updatedAt: string;
}

export interface SupervisorRepositoryRemoval {
  removed: boolean;
  alreadyRemoved: boolean;
  profile: string | null;
  paths: string[];
}

export interface SupervisorClient {
  prepare(repositoryId: string): Promise<SupervisorInstance>;
  /** Repository-level retry/refresh of the reusable Git copy. */
  prepareGit(repositoryId: string): Promise<SupervisorInstance>;
  /** Stop the instance and delete its local profile, state, Git copy and credentials. */
  remove(repositoryId: string): Promise<SupervisorRepositoryRemoval>;
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
  /**
   * One instance settings-panel call. The supervisor owns the port and relays the
   * runtime's own status, so a stale revision (409) or an invalid value (422)
   * reaches the browser unchanged.
   */
  panel(repositoryId: string, request: PanelRequest): Promise<PanelResult>;
  /** One fixed panel operation (preview, labels, policy sync, pause, checks, lists). */
  panelAction(repositoryId: string, action: PanelAction): Promise<PanelResult>;
  /** Instance Deployment snapshot; the supervisor reads it from the profile patch. */
  deployment(repositoryId: string): Promise<PanelResult>;
  /** Applies set/unset operations against a revision, then restarts the instance. */
  saveDeployment(
    repositoryId: string,
    body: { ops: unknown[]; revision: number; expectedInstanceId: string },
  ): Promise<PanelResult>;
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
/** A relayed runtime-panel call, restricted to the supervisor's allow-list. */
export type PanelRequest =
  | {
      kind: 'read';
      page: 'state' | 'settings' | 'sources' | 'models' | 'prompts' | 'policy-history';
      query?: Record<string, string>;
    }
  | { kind: 'save-settings'; block: string; body: unknown }
  | { kind: 'save-prompts'; body: unknown };

/** Fixed, server-owned panel operations; no browser-supplied path or URL. */
export type PanelAction =
  | { kind: 'prompts-preview'; body: unknown }
  | { kind: 'source-labels'; sourceId: string }
  | { kind: 'policy-sync'; sourceId: string }
  | { kind: 'executor-pause'; paused: boolean }
  | { kind: 'setup-check' }
  | { kind: 'tickets'; query: Record<string, string> }
  | { kind: 'ticket'; ticketId: string }
  | { kind: 'ticket-retry'; ticketId: string }
  | { kind: 'ticket-stop'; ticketId: string }
  | { kind: 'decisions'; query: Record<string, string> };

export interface PanelResult {
  status: number;
  body: unknown;
}

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
  /**
   * Raw relay: unlike `request`, it keeps the supervisor's status and body so the
   * browser can render a 409 revision conflict or a 422 validation failure.
   */
  const rawRequest = async (
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown,
    timeoutMs = 20_000,
  ): Promise<PanelResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.supervisorToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = { error: text.slice(0, 500) };
        }
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      return {
        status: 503,
        body: {
          error: {
            code: 'supervisor_unreachable',
            message: `The host supervisor is unreachable: ${
              error instanceof Error ? error.message.slice(0, 200) : 'unknown error'
            }`,
          },
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    deployment: (repositoryId) =>
      rawRequest(`/control/v1/instances/${repositoryId}/deployment`, 'GET'),
    saveDeployment: (repositoryId, body) =>
      rawRequest(`/control/v1/instances/${repositoryId}/deployment`, 'PUT', body, 60_000),
    panel: (repositoryId, panelRequest) => {
      const prefix = `/control/v1/instances/${repositoryId}/panel`;
      switch (panelRequest.kind) {
        case 'read': {
          const query = new URLSearchParams(panelRequest.query ?? {}).toString();
          return rawRequest(`${prefix}/${panelRequest.page}${query ? `?${query}` : ''}`, 'GET');
        }
        case 'save-settings':
          return rawRequest(
            `${prefix}/settings/${encodeURIComponent(panelRequest.block)}`,
            'PUT',
            panelRequest.body,
          );
        case 'save-prompts':
          return rawRequest(`${prefix}/prompts`, 'PUT', panelRequest.body);
      }
    },
    panelAction: (repositoryId, action) => {
      const prefix = `/control/v1/instances/${repositoryId}/panel-action`;
      switch (action.kind) {
        case 'prompts-preview':
          return rawRequest(`${prefix}/prompts/preview`, 'POST', action.body);
        case 'source-labels':
          return rawRequest(
            `${prefix}/sources/${encodeURIComponent(action.sourceId)}/labels`,
            'POST',
            {},
          );
        case 'policy-sync':
          return rawRequest(
            `${prefix}/policy-sync/${encodeURIComponent(action.sourceId)}`,
            'POST',
            {},
          );
        case 'executor-pause':
          return rawRequest(`${prefix}/executor/pause`, 'POST', { paused: action.paused });
        case 'setup-check':
          return rawRequest(`${prefix}/setup/check`, 'POST', {}, 60_000);
        case 'tickets': {
          const query = new URLSearchParams(action.query).toString();
          return rawRequest(`${prefix}/tickets${query ? `?${query}` : ''}`, 'GET');
        }
        case 'ticket':
          return rawRequest(`${prefix}/tickets/${encodeURIComponent(action.ticketId)}`, 'GET');
        case 'ticket-retry':
          return rawRequest(
            `${prefix}/tickets/${encodeURIComponent(action.ticketId)}/retry`,
            'POST',
            {},
            60_000,
          );
        case 'ticket-stop':
          return rawRequest(
            `${prefix}/tickets/${encodeURIComponent(action.ticketId)}/stop`,
            'POST',
            {},
            60_000,
          );
        case 'decisions': {
          const query = new URLSearchParams(action.query).toString();
          return rawRequest(`${prefix}/decisions${query ? `?${query}` : ''}`, 'GET');
        }
      }
    },
    prepare: (repositoryId) => request(`/control/v1/instances/${repositoryId}/prepare`, 'POST', {}),
    prepareGit: (repositoryId) =>
      request(`/control/v1/instances/${repositoryId}/git/prepare`, 'POST', {}),
    remove: (repositoryId) =>
      request<SupervisorRepositoryRemoval>(
        `/control/v1/instances/${repositoryId}/remove`,
        'POST',
        undefined,
        120_000,
      ),
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
