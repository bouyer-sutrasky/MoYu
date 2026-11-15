import { spawn } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  repositoryCheckCommandsSchema,
  reviewCheckRunSchema,
  type ReviewCheckRun,
  type ReviewFile,
} from '@moyu/contracts';

import type { SupervisorConfig } from './config';
import type { SupervisorStore } from './store';

/**
 * Host-side review inspection for one ticket worktree.
 *
 * The supervisor is the only process the platform lets near the instance
 * filesystem, and this module is deliberately read-mostly: it resolves the
 * ticket directory from the supervisor's own configuration, runs `git` there to
 * read the real worktree diff, and — only when the platform explicitly asks —
 * runs the fixed check commands from configuration. No path, command or option
 * is ever accepted from a browser.
 */

export interface ResolvedWorktree {
  state: 'available' | 'cleaned' | 'unavailable';
  directory: string | null;
  reason: string | null;
  /** The instance profile whose worktree root was inspected. */
  profile: string | null;
}

export interface ChangesPayload {
  state: 'available' | 'cleaned' | 'unavailable';
  reason: string | null;
  directory: string | null;
  branch: string | null;
  commit: string | null;
  commitSubject: string | null;
  committedAt: string | null;
  files: ReviewFile[];
  additions: number;
  deletions: number;
  filesOmitted: number;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const GIT_TIMEOUT_MS = 20_000;

/**
 * The separate identity a check command runs as. `setpriv` applies it before
 * exec: the supervisor is unprivileged and its unit grants only CAP_SETUID and
 * CAP_SETGID, so the child ends up as this uid/gid and cannot use the caps
 * again. `home` is the check user's writable HOME, not the supervisor's.
 */
export interface CheckIdentity {
  uid: number;
  gid: number;
  home: string;
  setpriv: string;
}

/**
 * Why this identity cannot isolate a check child from the supervisor, or null
 * when it can. uid/gid 0 and the supervisor's own uid/gid are refused: either
 * one would let repository-controlled code read the supervisor's environment
 * and credentials, which is the point of the separate identity.
 */
export function checkIdentityProblem(identity: CheckIdentity): string | null {
  if (identity.uid === 0 || identity.gid === 0) {
    return '检查子进程不能以 root 身份运行';
  }
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && identity.uid === uid) {
    return '检查子进程 uid 必须不同于 supervisor';
  }
  if (gid !== undefined && identity.gid === gid) {
    return '检查子进程 gid 必须不同于 supervisor';
  }
  return null;
}

/** Runs a command without a shell, bounded in time and output, and never throws. */
export async function runCommand(
  argv: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxBytes?: number;
    env?: NodeJS.ProcessEnv;
    /** Start the child as its own process-group leader, so a timeout can kill the tree. */
    ownProcessGroup?: boolean;
    /** Run through setpriv as this uid/gid; failures surface as a non-zero command. */
    identity?: CheckIdentity;
  },
): Promise<CommandResult> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const command = options.identity
    ? [
        options.identity.setpriv,
        '--reuid',
        String(options.identity.uid),
        '--regid',
        String(options.identity.gid),
        '--init-groups',
        '--no-new-privs',
        // The supervisor's ambient caps are inherited across this exec; without
        // these the child keeps CAP_SETUID/CAP_SETGID after the uid switch and
        // could become another user (including the supervisor) again.
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--',
        ...argv,
      ]
    : argv;
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: options.ownProcessGroup ?? false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // A shell command leaves grandchildren behind; killing the group (the
      // child is its leader) takes them too. The direct kill stays as a
      // fallback for a group that has already gone.
      if (options.ownProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs);
    const collect = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8');
      const available = maxBytes - (stdout.length + stderr.length);
      if (available <= 0) return;
      const slice = text.slice(0, available);
      if (target === 'stdout') stdout += slice;
      else stderr += slice;
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * The environment a git child gets. It is a minimum, not the supervisor's own:
 * `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_*`, `GIT_DIR` and any other inherited
 * `GIT_*` value would otherwise let the launching environment point a
 * read-only inspection at a helper or a different repository, and the global
 * and system git config are dropped so only this process decides behaviour.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Switches that keep a read-only diff from running anything the task
 * repository configures. `--no-ext-diff` drops `diff.external`,
 * `GIT_EXTERNAL_DIFF` and attribute `diff.<driver>.command`; `--no-textconv`
 * drops `diff.<driver>.textconv`; the attributes override keeps a host-level
 * attributes file out. `-c diff.external=` must not be used instead: git reads
 * the empty value as an (empty) command and the diff dies.
 */
const DIFF_ISOLATION_FLAGS = ['--no-ext-diff', '--no-textconv'] as const;

export async function git(directory: string, args: string[]): Promise<CommandResult> {
  // `core.fsmonitor` may name a program the task repository provides, and both
  // `status` and `diff` refresh the index; a plain scan is all this needs.
  return runCommand(['git', '-c', 'core.fsmonitor=false', ...args], {
    cwd: directory,
    timeoutMs: GIT_TIMEOUT_MS,
    env: gitEnvironment(),
  });
}

/** A `git diff` that cannot execute a task-repository helper. */
async function gitDiff(directory: string, args: string[]): Promise<CommandResult> {
  return git(directory, [
    '-c',
    'core.attributesFile=/dev/null',
    'diff',
    ...DIFF_ISOLATION_FLAGS,
    ...args,
  ]);
}

/**
 * True when `child` is strictly below `parent`. Both arguments are real paths.
 * Comparing `relative` segments, rather than string prefixes, keeps
 * `/root/src/aaa-evil` from counting as a child of `/root/src/aaa`.
 */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolves one ticket's workspace directory. The executor names it
 * `<ticket-name>-<first 12 characters of the ticket id>`, so the id is a stable
 * suffix and the supervisor never trusts a path supplied by the caller.
 *
 * Everything is resolved with `realpath` before use: the boundary is
 * `worktreeRoot` itself, and a ticket directory (or the profile directory, or
 * any link in between) that resolves outside that boundary is refused rather
 * than stat-ed. The returned directory is the resolved path, so later git
 * calls cannot be redirected by a link that changes underneath.
 */
export function locateTicketWorktree(input: {
  worktreeRoot: string;
  profile: string | null;
  ticketId: string;
}): ResolvedWorktree {
  if (!input.profile) {
    return {
      state: 'unavailable',
      directory: null,
      reason: '该仓库还没有运行时实例记录，无法定位执行目录。',
      profile: null,
    };
  }
  const configuredRoot = join(input.worktreeRoot, input.profile);
  if (!existsSync(configuredRoot)) {
    return {
      state: 'cleaned',
      directory: null,
      reason: `执行根目录 ${configuredRoot} 不存在；实例尚未创建工作目录或已被清理。`,
      profile: input.profile,
    };
  }

  let boundary: string;
  let root: string;
  try {
    boundary = realpathSync(input.worktreeRoot);
    root = realpathSync(configuredRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: 'cleaned',
        directory: null,
        reason: `执行根目录 ${configuredRoot} 不存在；实例尚未创建工作目录或已被清理。`,
        profile: input.profile,
      };
    }
    return {
      state: 'unavailable',
      directory: null,
      reason: `无法解析执行根目录的真实路径：${error instanceof Error ? error.message : String(error)}`,
      profile: input.profile,
    };
  }
  if (!isStrictlyInside(boundary, root)) {
    return {
      state: 'unavailable',
      directory: null,
      reason: `执行根目录 ${configuredRoot} 解析后超出允许的边界（${boundary}），拒绝读取。`,
      profile: input.profile,
    };
  }

  const suffix = `-${input.ticketId.slice(0, 12)}`;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    return {
      state: 'unavailable',
      directory: null,
      reason: `执行根目录不可读：${error instanceof Error ? error.message : String(error)}`,
      profile: input.profile,
    };
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const candidate = join(root, entry);
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!isStrictlyInside(root, resolved)) {
      return {
        state: 'unavailable',
        directory: null,
        reason: `执行目录 ${candidate} 解析到允许边界之外，拒绝读取。`,
        profile: input.profile,
      };
    }
    try {
      if (!statSync(resolved).isDirectory()) continue;
      if (!existsSync(join(resolved, '.git'))) continue;
    } catch {
      continue;
    }
    matches.push(resolved);
  }
  if (matches.length === 0) {
    return {
      state: 'cleaned',
      directory: null,
      reason: '该任务的执行目录已不存在（工作目录已清理，或运行时尚未创建工作目录）。',
      profile: input.profile,
    };
  }
  if (matches.length > 1) {
    return {
      state: 'unavailable',
      directory: null,
      reason: '同一 ticket id 匹配到多个执行目录，拒绝猜测使用哪一个。',
      profile: input.profile,
    };
  }
  return {
    state: 'available',
    directory: matches[0]!,
    reason: null,
    profile: input.profile,
  };
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [rawAdd, rawDel, ...rest] = line.split('\t');
    const file = rest.join('\t').trim();
    if (!file) continue;
    const additions = rawAdd === '-' ? 0 : Number(rawAdd);
    const deletions = rawDel === '-' ? 0 : Number(rawDel);
    result.set(file, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return result;
}

function statusFor(
  code: string,
): { status: ReviewFile['status']; previousPath: string | null } | null {
  const kind = code[0];
  switch (kind) {
    case 'A':
      return { status: 'added', previousPath: null };
    case 'M':
      return { status: 'modified', previousPath: null };
    case 'D':
      return { status: 'deleted', previousPath: null };
    case 'R':
      return { status: 'renamed', previousPath: null };
    case 'C':
      return { status: 'copied', previousPath: null };
    case 'T':
      return { status: 'type_changed', previousPath: null };
    case '?':
      return { status: 'untracked', previousPath: null };
    case 'U':
      return { status: 'modified', previousPath: null };
    default:
      return null;
  }
}

/**
 * Reads the real worktree diff: tracked changes against HEAD plus untracked
 * files, each with the unified patch git printed for it.
 */
export async function collectChanges(input: {
  directory: string;
  maxBytes: number;
  maxFiles: number;
}): Promise<ChangesPayload> {
  const { directory } = input;
  const base: ChangesPayload = {
    state: 'available',
    reason: null,
    directory,
    branch: null,
    commit: null,
    commitSubject: null,
    committedAt: null,
    files: [],
    additions: 0,
    deletions: 0,
    filesOmitted: 0,
  };

  const [branch, head, subject, committedAt] = await Promise.all([
    git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(directory, ['rev-parse', 'HEAD']),
    git(directory, ['log', '-1', '--format=%s']),
    git(directory, ['log', '-1', '--format=%cI']),
  ]);
  if (head.code !== 0 || !head.stdout.trim()) {
    return {
      ...base,
      state: 'unavailable',
      reason: `无法读取 worktree 的 HEAD：${(head.stderr || 'git rev-parse HEAD 失败').trim()}`,
    };
  }
  base.branch = branch.code === 0 ? branch.stdout.trim() : null;
  base.commit = head.stdout.trim();
  base.commitSubject = subject.code === 0 ? subject.stdout.trim() : null;
  base.committedAt = committedAt.code === 0 ? committedAt.stdout.trim() : null;

  const [status, numstat] = await Promise.all([
    git(directory, ['status', '--porcelain=v1', '-z']),
    gitDiff(directory, ['--numstat', 'HEAD', '--']),
  ]);
  if (status.code !== 0) {
    return {
      ...base,
      state: 'unavailable',
      reason: `无法读取 git status：${status.stderr.trim()}`,
    };
  }

  // `-z` output: `XY <path>\0` and, for renames, `XY <new>\0<old>\0`.
  const entries: { code: string; path: string; previousPath: string | null }[] = [];
  const parts = status.stdout.split('\0');
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    const parsed = statusFor(code.trim());
    if (!parsed) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      const previous = parts[index + 1] ?? null;
      index += 1;
      entries.push({ code, path: file, previousPath: previous });
    } else {
      entries.push({ code, path: file, previousPath: null });
    }
  }

  const numstatMap = parseNumstat(numstat.stdout);
  const files: ReviewFile[] = [];
  let additions = 0;
  let deletions = 0;
  let filesOmitted = 0;
  let budget = input.maxBytes;

  for (const entry of entries) {
    const parsed = statusFor(entry.code.trim());
    if (!parsed) continue;
    const counts = numstatMap.get(entry.path) ?? { additions: 0, deletions: 0 };
    additions += counts.additions;
    deletions += counts.deletions;
    if (files.length >= input.maxFiles || budget <= 0) {
      filesOmitted += 1;
      continue;
    }
    let patch: string | null = null;
    let patchTruncated = false;
    let binary = false;
    if (parsed.status === 'untracked') {
      // `git diff --no-index` exits 1 when the files differ; that is success here.
      const diff = await gitDiff(directory, [
        '--no-index',
        '--no-prefix',
        '--',
        '/dev/null',
        entry.path,
      ]);
      patch = diff.stdout;
      if (!patch && diff.stderr.trim()) {
        binary = /binary/i.test(diff.stderr);
      } else {
        binary = /Binary files .* differ/.test(diff.stdout);
      }
    } else if (parsed.status === 'deleted') {
      const diff = await gitDiff(directory, ['HEAD', '--', entry.path]);
      patch = diff.stdout;
      binary = /Binary files .* differ/.test(diff.stdout);
    } else {
      const diff = await gitDiff(directory, ['HEAD', '--', entry.path]);
      patch = diff.stdout;
      binary = /Binary files .* differ/.test(diff.stdout);
    }
    if (binary) patch = null;
    // `git diff --numstat` has no entry for an untracked file, so count its
    // added lines from the real patch rather than reporting a misleading zero.
    if (parsed.status === 'untracked' && patch !== null) {
      counts.additions = patch
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
      counts.deletions = 0;
      additions += counts.additions;
      deletions += counts.deletions;
    }
    if (patch !== null && patch.length > budget) {
      patch = patch.slice(0, budget);
      patchTruncated = true;
    }
    if (patch !== null) budget -= patch.length;
    files.push({
      path: entry.path,
      previousPath: entry.previousPath,
      status: parsed.status,
      additions: counts.additions,
      deletions: counts.deletions,
      binary,
      patch,
      patchTruncated,
    });
  }

  return { ...base, files, additions, deletions, filesOmitted };
}

const OUTPUT_TAIL_BYTES = 8 * 1024;

/**
 * The environment a check command gets. It is a whitelist, not the supervisor's
 * own: tokens, database URLs and any `MOYU_*` value the supervisor was launched
 * with must not reach code that a task repository can change. The keys kept are
 * what a normal `pnpm`/`node` build needs to find its toolchain and write.
 */
const CHECK_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

function checkEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  identity?: CheckIdentity,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHECK_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  if (identity) env.HOME = identity.home;
  env.LANG ??= 'C';
  env.LC_ALL ??= 'C';
  return env;
}

/**
 * Proves, as the check identity itself, that the two paths it must write are
 * writable. Without this, a missing shared-group grant shows up as an opaque
 * EACCES deep inside a build; with it, the supervisor reports the exact uid and
 * path before spending a timeout on a check that cannot succeed.
 */
async function assertCheckRuntime(identity: CheckIdentity, directory: string): Promise<void> {
  const access = await runCommand(
    ['/bin/sh', '-c', 'test -w "$1" && test -x "$1"', 'check-worktree', directory],
    {
      cwd: '/',
      timeoutMs: 5_000,
      env: checkEnvironment(process.env, identity),
      identity,
    },
  );
  if (access.code !== 0) {
    throw new Error(
      `检查身份 ${identity.uid}:${identity.gid} 无法写入工作目录 ${directory}：${
        access.stderr.trim() || `exit ${access.code ?? 'unknown'}`
      }`,
    );
  }
  const home = await runCommand(['/bin/sh', '-c', 'test -w "$HOME" && test -x "$HOME"'], {
    cwd: '/',
    timeoutMs: 5_000,
    env: checkEnvironment(process.env, identity),
    identity,
  });
  if (home.code !== 0) {
    throw new Error(`检查身份 ${identity.uid}:${identity.gid} 的 HOME 不可写：${identity.home}`);
  }
}

/**
 * Resolves the effective commands for one repository.
 *
 * `null`/missing in the row means "use the supervisor-wide default". Any other
 * value is repository-controlled configuration and must pass the shared
 * contract; an empty or malformed value refuses the run (422) instead of
 * falling back to the default or silently skipping the check.
 */
export function resolveCheckCommands(input: {
  repositoryCommands: unknown;
  defaultCommands: readonly string[];
}): { commands: string[]; source: 'repository' | 'default' } {
  if (input.repositoryCommands === null || input.repositoryCommands === undefined) {
    const parsed = repositoryCheckCommandsSchema.safeParse(input.defaultCommands);
    if (!parsed.success) {
      throw new Error(
        `supervisor 默认检查命令配置无效：${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    return { commands: parsed.data, source: 'default' };
  }
  const parsed = repositoryCheckCommandsSchema.safeParse(input.repositoryCommands);
  if (!parsed.success) {
    throw Object.assign(
      new Error(`仓库检查命令配置无效，拒绝执行：${parsed.error.issues[0]?.message ?? 'unknown'}`),
      { statusCode: 422 },
    );
  }
  return { commands: parsed.data, source: 'repository' };
}

/**
 * Runs the configured check commands in the ticket worktree, one by one.
 *
 * Each child gets the whitelist environment, its own process group and — when
 * an identity is configured — a `setpriv` exec into that uid/gid. The uid/gid
 * switch needs the supervisor unit's bounded CAP_SETUID/CAP_SETGID; without it
 * `setpriv` exits non-zero and the check fails instead of falling back to the
 * supervisor's identity. Production refuses to run a check without an identity
 * (`requireIsolated`), and a preflight proves the check user can write the
 * worktree and its HOME before the first command runs.
 *
 * The total budget spans every command: each child gets `min(per-command
 * timeout, remaining budget)`, and a command that starts after the budget is
 * exhausted is reported as a failed, non-executed run rather than being silently
 * dropped.
 */
export async function runChecks(input: {
  directory: string;
  commands: readonly string[];
  timeoutMs: number;
  totalTimeoutMs: number;
  identity?: CheckIdentity;
  requireIsolated?: boolean;
}): Promise<ReviewCheckRun[]> {
  const identity = input.identity;
  if (!identity) {
    if (input.requireIsolated) {
      throw new Error(
        '检查子进程身份未配置（REVIEW_CHECK_UID/GID/HOME）；拒绝以 supervisor 身份运行',
      );
    }
  } else {
    const problem = checkIdentityProblem(identity);
    if (problem) throw new Error(problem);
    if (!existsSync(identity.setpriv)) {
      throw new Error(`检查身份切换程序不存在：${identity.setpriv}`);
    }
    await assertCheckRuntime(identity, input.directory);
  }
  const deadline = Date.now() + input.totalTimeoutMs;
  const runs: ReviewCheckRun[] = [];
  for (const command of input.commands) {
    const startedAt = new Date();
    const started = process.hrtime.bigint();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const finishedAt = new Date();
      runs.push(
        reviewCheckRunSchema.parse({
          id: `${startedAt.getTime()}-${runs.length + 1}`,
          command,
          exitCode: null,
          passed: false,
          timedOut: true,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: 0,
          summary: '检查总时限已用完，命令未执行',
          output: '',
          outputTruncated: false,
        }),
      );
      continue;
    }
    const timeoutMs = Math.max(1, Math.min(input.timeoutMs, remaining));
    const result = await runCommand(['/bin/bash', '-lc', command], {
      cwd: input.directory,
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      env: checkEnvironment(process.env, identity),
      ownProcessGroup: true,
      ...(identity ? { identity } : {}),
    });
    const finishedAt = new Date();
    const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const combined = `${result.stdout}${result.stderr}`.trim();
    const passed = result.code === 0 && !result.timedOut;
    const output = combined.slice(-OUTPUT_TAIL_BYTES);
    runs.push(
      reviewCheckRunSchema.parse({
        id: `${startedAt.getTime()}-${runs.length + 1}`,
        command,
        exitCode: result.code,
        passed,
        timedOut: result.timedOut,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        summary: result.timedOut
          ? `命令在 ${Math.round(timeoutMs / 1000)} 秒超时后被终止`
          : passed
            ? '通过'
            : `失败（exit ${result.code ?? 'unknown'}）`,
        output,
        outputTruncated: combined.length > OUTPUT_TAIL_BYTES,
      }),
    );
  }
  return runs;
}

/**
 * A repository is reserved before any await, so two requests that arrive
 * together cannot both pass the gate while the worktree is being resolved.
 */
const runningChecks = new Set<string>();

export interface ReviewService {
  resolve(repositoryId: string, ticketId: string): Promise<ResolvedWorktree>;
  changes(repositoryId: string, ticketId: string): Promise<ChangesPayload>;
  checks(repositoryId: string, ticketId: string): Promise<ReviewCheckRun[]>;
}

export function createReviewService(input: {
  config: SupervisorConfig;
  store: SupervisorStore;
  logger: { info: (fields: Record<string, unknown>, message: string) => void };
}): ReviewService {
  const { config, store, logger } = input;

  const resolve = async (repositoryId: string, ticketId: string): Promise<ResolvedWorktree> => {
    const instance = await store.getInstance(repositoryId);
    return locateTicketWorktree({
      worktreeRoot: config.worktreeRoot,
      profile: instance?.profile ?? null,
      ticketId,
    });
  };

  return {
    resolve,
    async changes(repositoryId, ticketId) {
      const worktree = await resolve(repositoryId, ticketId);
      if (worktree.state !== 'available' || !worktree.directory) {
        return {
          state: worktree.state,
          reason: worktree.reason,
          directory: null,
          branch: null,
          commit: null,
          commitSubject: null,
          committedAt: null,
          files: [],
          additions: 0,
          deletions: 0,
          filesOmitted: 0,
        };
      }
      return collectChanges({
        directory: worktree.directory,
        maxBytes: config.reviewDiffMaxBytes,
        maxFiles: config.reviewMaxFiles,
      });
    },
    async checks(repositoryId, ticketId) {
      if (runningChecks.has(repositoryId)) {
        throw Object.assign(new Error('该仓库已有检查正在运行，请等它结束'), { statusCode: 409 });
      }
      runningChecks.add(repositoryId);
      try {
        const repository = await store.getRepository(repositoryId);
        if (!repository) {
          throw Object.assign(new Error('仓库不存在或尚未同步，无法运行检查'), {
            statusCode: 404,
          });
        }
        const { commands, source } = resolveCheckCommands({
          repositoryCommands: repository.checkCommands,
          defaultCommands: config.reviewCheckCommands,
        });
        const worktree = await resolve(repositoryId, ticketId);
        if (worktree.state !== 'available' || !worktree.directory) {
          throw Object.assign(new Error(worktree.reason ?? '执行目录不可用'), {
            statusCode: 409,
          });
        }
        const identity =
          config.reviewCheckUid !== undefined &&
          config.reviewCheckGid !== undefined &&
          config.reviewCheckHome !== undefined
            ? {
                uid: config.reviewCheckUid,
                gid: config.reviewCheckGid,
                home: config.reviewCheckHome,
                setpriv: config.reviewCheckSetpriv ?? '/usr/bin/setpriv',
              }
            : undefined;
        const runs = await runChecks({
          directory: worktree.directory,
          commands,
          timeoutMs: config.reviewCheckTimeoutMs,
          totalTimeoutMs: config.reviewCheckTotalTimeoutMs,
          ...(identity ? { identity } : {}),
          requireIsolated: config.nodeEnv === 'production',
        });
        logger.info(
          {
            event: 'review.checks_finished',
            repositoryId,
            ticketId,
            commandSource: source,
            commands,
            identity: identity ? { uid: identity.uid, gid: identity.gid } : null,
            results: runs.map((run) => ({
              command: run.command,
              exitCode: run.exitCode,
              passed: run.passed,
            })),
          },
          'review checks finished',
        );
        return runs;
      } finally {
        runningChecks.delete(repositoryId);
      }
    },
  };
}
