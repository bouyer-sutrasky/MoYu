/**
 * Loopback proxy from the supervisor to one instance's management panel.
 *
 * The browser never reaches a runtime port, and the API never forwards an
 * arbitrary path. Only the endpoints in these allow-lists can be called, and
 * the port always comes from `repository_instances` for a repository the
 * caller has already authorised.
 */
import { setTimeout as delay } from 'node:timers/promises';

export interface PanelResult {
  status: number;
  body: unknown;
}

/** Settings blocks the runtime accepts: the three fixed blocks, pause, and any source id. */
const SETTINGS_BLOCK = /^(policy|eval|executor|pause|source:[a-z][a-z0-9-]*)$/;

export function isSettingsBlock(block: string): boolean {
  return SETTINGS_BLOCK.test(block);
}

/** Read-only panel endpoints that the settings UI needs. */
export const PANEL_READ_PATHS: ReadonlySet<string> = new Set([
  '/state',
  '/settings',
  '/sources',
  '/policy/history',
  '/models',
  '/prompts',
]);

/** Write endpoints, keyed by the path shape they accept. */
export const PANEL_PROMPTS_PATH = '/prompts';

export async function panelCall(input: {
  port: number;
  path: string;
  method?: 'GET' | 'PUT' | 'POST';
  body?: unknown;
  timeoutMs?: number;
}): Promise<PanelResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  const method = input.method ?? 'GET';
  try {
    const response = await fetch(`http://127.0.0.1:${input.port}/orchestrator/api${input.path}`, {
      method,
      headers: {
        'x-orchestrator-request': '1',
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { error: text.slice(0, 500) };
      }
    }
    return { status: response.status, body };
  } catch (error) {
    return {
      status: 503,
      body: {
        error: `runtime panel unreachable: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Message text of a panel error, for the supervisor log. */
export function panelErrorText(result: PanelResult): string {
  const body = result.body;
  if (typeof body === 'string') return body.slice(0, 300);
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error.slice(0, 300);
    if (Array.isArray(record.issues)) return JSON.stringify(record.issues).slice(0, 300);
  }
  return `panel responded ${result.status}`;
}

export { delay };
