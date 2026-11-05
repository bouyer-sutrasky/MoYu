import { setTimeout as delay } from 'node:timers/promises';

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
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await request(port, path, 'PUT', body);
      return;
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
  const sourceRevision = (id: string) =>
    settings.sources?.find((source) => source.id === id)?.revision ?? 0;
  const blockRevision = (block: string) => settings.blocks?.[block]?.revision ?? 0;

  await putSettings(
    input.port,
    '/settings/source%3Aworkspace',
    {
      value: { enabled: true, config: { repository: input.repository } },
      revision: sourceRevision('workspace'),
    },
    input.timeoutMs,
  );
  await putSettings(
    input.port,
    '/settings/source%3Agithub',
    {
      value: {
        enabled: true,
        config: {
          repository: input.repository,
          cli: input.githubCli,
          pollSeconds: 60,
          failuresBeforeError: 3,
          observeIssues: true,
          observePulls: true,
          observeComments: true,
          observeCi: false,
        },
      },
      revision: sourceRevision('github'),
    },
    input.timeoutMs,
  );
  await request(input.port, '/settings/policy', 'PUT', {
    value: {
      rules: settings.blocks?.policy?.value?.rules ?? [],
      sources: {
        workspace: { allowed: [{ id: input.ownerId }], admission: {} },
        github: {
          allowed: input.githubAllowedUsers.map((id) => ({ id })),
          admission: {},
        },
      },
    },
    revision: blockRevision('policy'),
  });
  await request(input.port, '/settings/executor', 'PUT', {
    value: {
      model: {
        provider: input.model.provider,
        model: input.model.model,
        ...(input.model.reasoningEffort ? { reasoningEffort: input.model.reasoningEffort } : {}),
      },
      maxWorkers: 1,
      directory: input.worktreeDir,
      prepare: input.prepare,
      blockedCommands: [],
    },
    revision: blockRevision('executor'),
  });
  await request(input.port, '/settings/eval', 'PUT', {
    value: {
      mode: 'auto',
      timeoutSeconds: 300,
      model: {
        provider: input.model.provider,
        model: input.model.model,
        reasoningEffort: 'low',
      },
    },
    revision: blockRevision('eval'),
  });

  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const state = (await request(input.port, '/state')) as {
      setup?: { accounts?: { repository?: string } };
      health?: { runtime?: { state?: string } };
    };
    if (
      state.setup?.accounts?.repository === input.repository &&
      (state.health?.runtime?.state === 'ready' || state.health?.runtime?.state === 'paused')
    ) {
      return;
    }
    await delay(1000);
  }
  throw new Error('runtime listener did not become ready after configuration');
}
