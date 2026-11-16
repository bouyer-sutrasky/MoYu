/**
 * Instance-level Deployment settings.
 *
 * Upstream edits these three machine limits through DSH's `ConfigForm`
 * (snapshot / subscribe / mutate). MoYu has no DSH plugin-manager surface, so the
 * equivalent is the instance's own profile patch file: the supervisor reads the
 * `dsh-superagent` config block, and a mutate rewrites it in place with a
 * revision so a stale editor cannot silently win.
 *
 * Only these keys can be written. `stateDir` is platform-managed and rejected.
 */

export const DEPLOYMENT_LIMITS = {
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
} as const;

export type DeploymentKey = keyof typeof DEPLOYMENT_LIMITS;

export const DEPLOYMENT_KEYS = Object.keys(DEPLOYMENT_LIMITS) as DeploymentKey[];

/**
 * Serializes Deployment read-check-write-rename for one repository inside this
 * supervisor. The supervisor is the single writer for its DSH home; a second
 * process must not edit the same profile patch without its own shared lock.
 * The map keeps the chain bounded to repositories that are actually saving.
 */
const deploymentLocks = new Map<string, Promise<unknown>>();

export function withDeploymentLock<T>(repositoryId: string, work: () => Promise<T>): Promise<T> {
  const previous = deploymentLocks.get(repositoryId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  deploymentLocks.set(repositoryId, current);
  return current.finally(() => {
    if (deploymentLocks.get(repositoryId) === current) {
      deploymentLocks.delete(repositoryId);
    }
  });
}

export interface DeploymentValue {
  promptMaxChars: number | null;
  admissionContextMaxPages: number | null;
  admissionContextTimeoutMs: number | null;
}

export type DeploymentOp =
  | { op: 'set'; path: [string, ...string[]]; value: unknown }
  | { op: 'unset'; path: [string, ...string[]] };

export interface DeploymentSnapshot {
  status: 'ready';
  writable: boolean;
  mode: 'config';
  revision: number;
  value: DeploymentValue;
  stateDir: string | null;
}

function isDeploymentKey(key: string): key is DeploymentKey {
  return Object.hasOwn(DEPLOYMENT_LIMITS, key);
}

/** FNV-1a over the patch text: stable across restarts, cheap, and changes on any edit. */
export function deploymentRevision(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 2_147_483_647;
}

interface Stanza {
  /** Index of the `- id: dsh-superagent` line. */
  start: number;
  /** Index of the last line that belongs to this list item. */
  end: number;
  /** Indent of the `config:` line. */
  configIndent: number | null;
  /** Index of the `config:` line. */
  configLine: number | null;
  /** Index of the last line that belongs to the config mapping. */
  configEnd: number;
}

/** Locate the `- id: dsh-superagent` list item and its `config:` mapping. */
export function findStanza(lines: string[]): Stanza | null {
  let start = -1;
  let itemIndent = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*-\s+id:\s*dsh-superagent\s*$/.test(line)) {
      start = index;
      itemIndent = (line.match(/^\s*/) ?? [''])[0].length;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length - 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const indent = (line.match(/^\s*/) ?? [''])[0].length;
    const blank = line.trim() === '';
    if (!blank && indent <= itemIndent && /^\s*-/.test(line)) {
      end = index - 1;
      break;
    }
  }

  let configLine: number | null = null;
  let configIndent: number | null = null;
  for (let index = start + 1; index <= end; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(\s*)config:\s*$/.exec(line);
    if (match) {
      configLine = index;
      configIndent = (match[1] ?? '').length;
      break;
    }
  }
  if (configLine === null || configIndent === null) {
    return { start, end, configIndent: null, configLine: null, configEnd: end };
  }

  let configEnd = configLine;
  for (let index = configLine + 1; index <= end; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const indent = (line.match(/^\s*/) ?? [''])[0].length;
    if (indent <= configIndent) break;
    configEnd = index;
  }
  return { start, end, configIndent, configLine, configEnd };
}

const stripQuotes = (raw: string): string => raw.replace(/^['"]|['"]$/g, '');

/** Current values of the three writable keys, plus the platform-managed stateDir. */
export function readDeployment(text: string): DeploymentSnapshot {
  const lines = text.split('\n');
  const stanza = findStanza(lines);
  const value: DeploymentValue = {
    promptMaxChars: null,
    admissionContextMaxPages: null,
    admissionContextTimeoutMs: null,
  };
  let stateDir: string | null = null;
  if (stanza?.configLine != null) {
    for (let index = stanza.configLine + 1; index <= stanza.configEnd; index += 1) {
      const line = lines[index] ?? '';
      const match = /^\s*([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1] as string;
      const raw = stripQuotes(match[2] as string);
      if (key === 'stateDir') {
        stateDir = raw;
        continue;
      }
      if (!isDeploymentKey(key)) continue;
      const parsed = Number(raw);
      value[key] = Number.isFinite(parsed) ? parsed : null;
    }
  }
  return {
    status: 'ready',
    writable: true,
    mode: 'config',
    revision: deploymentRevision(text),
    value,
    stateDir,
  };
}

export interface ApplyResult {
  text: string;
  revision: number;
  applied: DeploymentKey[];
}

/**
 * Apply `set`/`unset` operations to the writable keys.
 *
 * Rejects unknown paths, non-numeric values, out-of-range numbers and the
 * platform-managed `stateDir` before touching the file, so a bad request never
 * writes a half-edited profile.
 */
export function applyDeploymentOps(text: string, ops: DeploymentOp[]): ApplyResult {
  const lines = text.split('\n');
  const stanza = findStanza(lines);
  if (!stanza) {
    throw new Error('The profile patch has no dsh-superagent config block');
  }
  if (stanza.configLine === null || stanza.configIndent === null) {
    throw new Error('The dsh-superagent block has no config mapping');
  }

  const indent = ' '.repeat(stanza.configIndent + 2);
  const applied: DeploymentKey[] = [];
  const pending = new Map<DeploymentKey, number | null>();

  for (const op of ops) {
    const [head, ...rest] = op.path;
    if (rest.length > 0) {
      throw new Error(`Unsupported deployment path: ${op.path.join('.')}`);
    }
    if (typeof head !== 'string' || !isDeploymentKey(head)) {
      throw new Error(`Deployment key is platform-managed or unknown: ${String(head)}`);
    }
    if (op.op === 'unset') {
      pending.set(head, null);
      applied.push(head);
      continue;
    }
    const raw = op.value;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    const bounds = DEPLOYMENT_LIMITS[head];
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new Error(`${head} must be an integer`);
    }
    if (parsed < bounds.min || parsed > bounds.max) {
      throw new Error(`${head} must be between ${bounds.min} and ${bounds.max}`);
    }
    pending.set(head, parsed);
    applied.push(head);
  }

  const working = [...lines];
  for (const [key, next] of pending) {
    const current = findStanza(working);
    if (!current || current.configLine === null || current.configIndent === null) {
      throw new Error('The dsh-superagent block disappeared while editing');
    }
    const start = current.configLine + 1;
    let found = -1;
    for (let index = start; index <= current.configEnd; index += 1) {
      const trimmed = (working[index] ?? '').trimStart();
      if (trimmed.startsWith(`${key}:`)) {
        found = index;
        break;
      }
    }
    if (next === null) {
      if (found !== -1) working.splice(found, 1);
      continue;
    }
    const line = `${indent}${key}: ${next}`;
    if (found !== -1) working[found] = line;
    else working.splice(current.configEnd + 1, 0, line);
  }

  const text2 = working.join('\n');
  return { text: text2, revision: deploymentRevision(text2), applied };
}
