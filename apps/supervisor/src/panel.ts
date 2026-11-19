import { setTimeout as delay } from 'node:timers/promises';

import { mergeProfileSettings, type PanelSettingsView } from './profile-config';

export interface PanelSettings {
  blocks: Record<string, { revision: number; value: Record<string, unknown> }>;
  sources?: Array<{ id: string; revision: number; value?: Record<string, unknown> }>;
  policyVersion?: number;
}

async function request(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api${path}`, {
      method,
      headers: {
        'x-orchestrator-request': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const issues = Array.isArray(payload.issues)
        ? `: ${JSON.stringify(payload.issues).slice(0, 400)}`
        : typeof payload.error === 'string'
          ? `: ${payload.error.slice(0, 300)}`
          : '';
      throw new Error(`panel ${method} ${path} failed: ${response.status}${issues}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForPanel(
  port: number,
  timeoutMs: number,
  stateDir: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const state = await request(port, '/state', 'GET', undefined, 5000);
      const actual = (state as { setup?: { machine?: { stateDir?: string } } }).setup?.machine
        ?.stateDir;
      if (actual && actual === stateDir) return state;
      lastError = new Error(`unexpected runtime stateDir: ${String(actual)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }
  throw new Error(
    `runtime did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export interface ConfigureProfileInput {
  port: number;
  repository: string;
  ownerId: string;
  githubAllowedUsers: string[];
  githubCli: string;
  model: { provider: string; model: string; reasoningEffort?: string };
  worktreeDir: string;
  prepare: string;
  timeoutMs: number;
  /**
   * True only for the first configuration of this instance. First-run defaults
   * (GitHub polling/observation switches, worker and Eval models, Eval mode and
   * timeout, blocked commands) are written then; later starts only re-assert
   * the platform invariants and keep every owner edit.
   */
  seedDefaults: boolean;
}

/**
 * A source change makes the runtime restart its setup fiber. The restart is
 * deliberately deferred so the saving request can answer first, which means the
 * next settings write would race it and can abort an in-flight CLI account
 * probe ("was stopped before it finished"). Wait for the configured runtime
 * before sending the next block.
 */
async function waitForConfiguredRuntime(
  port: number,
  repository: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = (await request(port, '/state')) as {
        setup?: { accounts?: { repository?: string } };
        health?: { runtime?: { state?: string } };
      };
      if (
        state.setup?.accounts?.repository === repository &&
        (state.health?.runtime?.state === 'ready' || state.health?.runtime?.state === 'paused')
      ) {
        return;
      }
    } catch {
      // The setup restart briefly closes the panel; retry until the deadline.
    }
    await delay(250);
  }
  throw new Error('runtime listener did not become ready after configuration');
}

/**
 * Applies the fixed per-repository runtime configuration through the loopback
 * panel. Only the supervisor calls this: the browser never sends a repository,
 * path, model or command directly to the runtime.
 */
async function putSettings(
  port: number,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await request(port, path, 'PUT', body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A freshly started runtime registers the optional workspace Source after
      // the main plugin. Saving before that is a retryable 400, not a fault.
      if (!message.includes('Source kind is not installed') || Date.now() >= deadline) {
        throw error;
      }
      await delay(1000);
    }
  }
}

function encodeBlock(block: string): string {
  return block.replace(':', '%3A');
}

/**
 * The GitHub source carries the CLI account probe, so it must be saved before a
 * source write that schedules a deferred setup restart. Exported for the unit
 * test that pins this order.
 */
export function orderProfileBlocks<T extends { block: string }>(blocks: readonly T[]): T[] {
  return [
    ...blocks.filter((block) => block.block === 'source:github'),
    ...blocks.filter((block) => block.block !== 'source:github'),
  ];
}

export async function configureProfile(input: ConfigureProfileInput): Promise<void> {
  const readyDeadline = Date.now() + input.timeoutMs;
  let settings: PanelSettings;
  for (;;) {
    settings = (await request(input.port, '/settings')) as unknown as PanelSettings;
    const kinds = new Set((settings.sources ?? []).map((source) => source.id));
    // The optional workspace Source registers after the main plugin; saving it
    // earlier answers "not installed". Wait for both fixed kinds before writing.
    if (kinds.has('workspace') && kinds.has('github')) break;
    if (Date.now() >= readyDeadline) {
      throw new Error('The runtime did not register the workspace Source kind in time');
    }
    await delay(1000);
  }

  // Re-assert only the platform invariants and, on the first run, the defaults.
  // Everything else is the owner's configuration and is left exactly as the
  // runtime reported it, so sleep/wake/restart cannot overwrite it.
  const blocks = mergeProfileSettings(
    settings as unknown as PanelSettingsView,
    {
      repository: input.repository,
      ownerId: input.ownerId,
      githubAllowedUsers: input.githubAllowedUsers,
      githubCli: input.githubCli,
      worktreeDir: input.worktreeDir,
      prepare: input.prepare,
      model: input.model,
    },
    input.seedDefaults,
  );
  // The GitHub source carries the account probe. Save it before the workspace
  // source (which also triggers a deferred setup restart) so the probe is not
  // aborted by that restart.
  const ordered = orderProfileBlocks(blocks);
  for (const block of ordered) {
    const result = await putSettings(
      input.port,
      `/settings/${encodeBlock(block.block)}`,
      { value: block.value, revision: block.revision },
      input.timeoutMs,
    );
    if (result.restarting === true) {
      await waitForConfiguredRuntime(input.port, input.repository, input.timeoutMs);
    }
  }

  await waitForConfiguredRuntime(input.port, input.repository, input.timeoutMs);
}
