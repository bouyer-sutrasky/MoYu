/**
 * Repository-level reuse of one Git copy.
 *
 * A full remote clone used to happen inside every ticket's launch prepare
 * command. That is the wrong boundary: the repository is the same for every
 * ticket, a slow link makes each launch pay the whole transfer, and a timeout
 * can leave a half-written workspace that the next launch treats as prepared.
 *
 * This module owns a bare mirror per repository profile under the supervisor's
 * worktree root. It is prepared asynchronously when the repository is added
 * (or retried from the repository panel), reports the phase Git itself prints,
 * and only commits the copy atomically after its bare/HEAD checks pass. Task
 * workspaces then clone from this local copy and fetch the frozen commit only
 * when it is missing; the remote is no longer on the first-task path.
 *
 * The copy is written under the repository's own profile directory and chowned
 * to the runtime identity when one is configured, so another repository cannot
 * read it and the task prepare command (which runs as that identity) can.
 */
import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { SupervisorConfig } from './config';
import type { SupervisorLogger } from './logger';
import { chownTree, pathExists } from './provision';
import type { InstanceRow, RepositoryRow, SupervisorStore } from './store';

/** Machine-readable preparation phases; the platform maps them to Chinese. */
export type GitPhase =
  | 'connecting'
  | 'receiving'
  | 'resolving'
  | 'finalizing'
  | 'verifying'
  | 'ready';

export const GIT_PHASES: readonly GitPhase[] = [
  'connecting',
  'receiving',
  'resolving',
  'finalizing',
  'verifying',
  'ready',
];

/** The cache directory is hidden so it never collides with a ticket worktree. */
export const GIT_CACHE_DIRECTORY = '.repository.git';

export function gitCachePath(worktreeRoot: string, profile: string): string {
  return join(worktreeRoot, profile, GIT_CACHE_DIRECTORY);
}

/** The managed clone URL. Tests replace it with a local bare repository. */
export function githubCloneUrl(fullName: string): string {
  return `ssh://git@ssh.github.com:443/${fullName}.git`;
}

interface GitCacheOptions {
  /** Test seam: the remote a repository is cloned from. */
  remoteUrl?: (repository: RepositoryRow) => string;
  /** Test seam: overrides the wall clock used in the reported rows. */
  now?: () => Date;
  /** Test seam: extra Git environment, such as allowing a local `ext::` helper. */
  env?: Record<string, string>;
  /** Test seam: observes/stubs the process spawns used by one preparation. */
  spawn?: GitSpawn;
}

/** The narrow spawn shape this module needs; `child_process.spawn` satisfies it. */
export type GitSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface Progress {
  phase: GitPhase;
  percent: number | null;
  detail: string | null;
}

interface GitRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

const MAX_DETAIL = 500;
const MAX_OUTPUT = 64 * 1024;
const PROGRESS_INTERVAL_MS = 400;

function tail(text: string): string {
  return text.slice(-MAX_OUTPUT);
}

export function sanitizeGitDetail(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/token[=:]\s*\S+/gi, 'token=[redacted]')
    .replace(/ssh:\/\/[^@\s]+@/gi, 'ssh://[redacted]@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL);
}

/**
 * Turns Git's `--progress` stderr into a coarse phase and the transfer
 * percentage Git reported. No percentage is invented: when the line has none
 * the previous value is kept, and a phase change without a percentage clears it.
 */
export function parseGitProgress(line: string, previous: Progress): Progress | null {
  const text = line.trim();
  if (!text) return null;
  const count = /(\d{1,3})% \(\d+\/\d+\)/.exec(text);
  const percent = count ? Math.max(0, Math.min(100, Number(count[1]))) : null;
  if (
    /^Cloning into|^remote: Enumerating objects|^remote: Counting objects|^remote: Compressing objects|^Fetching|^From /i.test(
      text,
    )
  ) {
    // Counting/compressing is the server's work, not bytes transferred here:
    // the phase is real but a percentage only exists once objects arrive.
    return { phase: 'connecting', percent: null, detail: sanitizeGitDetail(text) };
  }
  if (/^Receiving objects/i.test(text)) {
    return {
      phase: percent !== null && percent >= 100 ? 'finalizing' : 'receiving',
      percent,
      detail: sanitizeGitDetail(text),
    };
  }
  if (/^Resolving deltas/i.test(text)) {
    return { phase: 'resolving', percent, detail: sanitizeGitDetail(text) };
  }
  if (/^Updating files|^Checking out files|^remote: Total/i.test(text)) {
    return { phase: 'finalizing', percent, detail: sanitizeGitDetail(text) };
  }
  // A non-progress diagnostic (an SSH warning, a server message) is kept as
  // detail so a failure can explain itself; it never moves the phase backwards.
  if (/error|fatal|warning|denied|refused|timed out|not found/i.test(text)) {
    return { ...previous, detail: sanitizeGitDetail(text) };
  }
  return null;
}

/** A short Chinese reason for the most common transport failures, with the raw tail kept. */
export function explainGitFailure(input: {
  phase: GitPhase | null;
  timedOut: boolean;
  stderr: string;
  spawnError?: string;
}): string {
  const raw = sanitizeGitDetail(tail(input.stderr));
  const phase = input.phase ? `阶段 ${input.phase}` : '阶段未知';
  if (input.timedOut) {
    return `仓库副本准备超时（${phase}）；已中止并清理未完成的临时副本，可从仓库面板重试。`;
  }
  if (input.spawnError) {
    return `无法启动 Git（${phase}）：${sanitizeGitDetail(input.spawnError)}`;
  }
  if (
    /Permission denied \(publickey\)|Host key verification failed|Authentication failed/i.test(
      input.stderr,
    )
  ) {
    return `无法用专用账号的 SSH 凭据读取仓库（${phase}，权限或 known_hosts 未配置）；可从仓库面板重试。${raw ? ` Git 输出：${raw}` : ''}`;
  }
  if (
    /Could not resolve host|Connection timed out|Connection refused|Network is unreachable/i.test(
      input.stderr,
    )
  ) {
    return `仓库准备时网络不可达（${phase}）；可从仓库面板重试。${raw ? ` Git 输出：${raw}` : ''}`;
  }
  if (/not found|does not appear to be a git repository|Repository not found/i.test(input.stderr)) {
    return `仓库地址不存在或专用账号无权访问（${phase}）；请检查仓库是否已被删除或转移。${raw ? ` Git 输出：${raw}` : ''}`;
  }
  return `仓库副本准备失败（${phase}）：${raw || 'Git 未给出输出'}`;
}

interface RunGitInput {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  identity?: { uid: number; gid: number; setpriv: string };
  onLine?: (line: string) => void;
}

/** Runs Git with a bounded timeout, its own process group, and line-oriented progress. */
async function runGit(input: RunGitInput, spawn: GitSpawn = defaultSpawn): Promise<GitRunResult> {
  const prefix = input.identity
    ? [
        input.identity.setpriv,
        '--reuid',
        String(input.identity.uid),
        '--regid',
        String(input.identity.gid),
        '--init-groups',
        '--no-new-privs',
        '--bounding-set=-all',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--',
      ]
    : [];
  const command = prefix.length > 0 ? prefix[0]! : 'git';
  const args = [...prefix.slice(1), ...input.argv];
  return await new Promise<GitRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      // A Git that ignores SIGTERM (for example while fsyncing a pack) must not
      // hold the repository preparation forever.
      setTimeout(() => kill('SIGKILL'), 10_000).unref();
    }, input.timeoutMs);
    timer.unref();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = tail(stdout + chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = tail(stderr + chunk);
      // Git writes progress updates with `\r`, diagnostics with `\n`.
      for (const line of chunk.split(/\r?\n|\r/)) input.onLine?.(line);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, stdout, stderr, spawnError: error.message });
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

class GitPreparationError extends Error {
  constructor(
    readonly code: 'timeout' | 'git_failed' | 'verify_failed',
    message: string,
  ) {
    super(message);
    this.name = 'GitPreparationError';
  }
}

function baseEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TZ',
    'SHELL',
    'TERM',
    'SSH_AUTH_SOCK',
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key)) result[key] = value;
  }
  return result;
}

/**
 * One in-flight preparation per repository. A duplicate click joins it instead
 * of starting a second clone; the caller gets the row that says `preparing`.
 */
interface ActivePreparation {
  /** Resolves with the preparing row once the reservation is durable. */
  started: Promise<InstanceRow>;
  /** The whole preparation; concurrent callers join `started`, not this. */
  job: Promise<void>;
}

export class RepositoryGitCache {
  /**
   * Reservation map written before the first await. Two callers that enter
   * `begin` together must observe the same entry, or both would increment
   * attempts and start a clone. The entry is removed only after the job
   * settles, whichever way it ends.
   */
  private readonly active = new Map<string, ActivePreparation>();

  constructor(
    private readonly config: SupervisorConfig,
    private readonly store: SupervisorStore,
    private readonly logger: SupervisorLogger,
    private readonly options: GitCacheOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private remoteUrl(repository: RepositoryRow): string {
    return this.options.remoteUrl?.(repository) ?? githubCloneUrl(repository.fullName);
  }

  cacheDir(profile: string): string {
    return gitCachePath(this.config.worktreeRoot, profile);
  }

  isPreparing(repositoryId: string): boolean {
    return this.active.has(repositoryId);
  }

  /**
   * Marks the repository as preparing and starts (or joins) the background
   * preparation. The returned row is the durable status the platform polls;
   * the work itself is not awaited.
   */
  async begin(repositoryId: string): Promise<InstanceRow> {
    const inFlight = this.active.get(repositoryId);
    if (inFlight) return inFlight.started;

    let startedRow!: (row: InstanceRow) => void;
    let failedStart!: (error: unknown) => void;
    const started = new Promise<InstanceRow>((resolve, reject) => {
      startedRow = resolve;
      failedStart = reject;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry: ActivePreparation = { started, job: Promise.resolve() };
    const job = (async () => {
      // Let `begin` install the reservation before the first asynchronous step.
      await gate;
      let repository: RepositoryRow | null = null;
      try {
        repository = await this.store.getRepository(repositoryId);
        if (!repository) throw new Error('Repository not found');
        const instance = await this.store.getInstance(repositoryId);
        if (!instance?.profile) {
          throw new Error('The repository instance is not prepared yet');
        }
        const startedAt = this.now();
        await this.store.updateInstance(repositoryId, {
          gitState: 'preparing',
          gitPhase: 'connecting',
          gitProgress: null,
          gitDetail: '正在连接远端并准备可复用的仓库副本…',
          gitStartedAt: startedAt,
          gitFinishedAt: null,
          gitAttempts: instance.gitAttempts + 1,
          gitHead: instance.gitHead,
        });
        const preparing = (await this.store.getInstance(repositoryId)) ?? instance;
        startedRow(preparing);
        await this.prepareOnce(repositoryId, repository, instance);
      } catch (error) {
        // Reject the reservation's start only when it never became durable;
        // a later preparation failure is recorded on the row by prepareOnce.
        failedStart(error);
        this.logger.error(
          {
            event: 'supervisor.git_prepare_failed',
            repository: repository?.fullName ?? repositoryId,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          },
          'repository Git copy preparation failed',
        );
      }
    })().finally(() => {
      if (this.active.get(repositoryId) === entry) this.active.delete(repositoryId);
    });
    entry.job = job;
    this.active.set(repositoryId, entry);
    release();
    return started;
  }

  /**
   * After a supervisor restart nothing may still be preparing: the child Git is
   * gone. Record that honestly instead of leaving a permanent `preparing`, and
   * remove temporary copies that can never be committed.
   */
  async recover(): Promise<void> {
    const rows = await this.store.listInstances();
    for (const row of rows) {
      if (row.gitState !== 'preparing') continue;
      if (row.profile) this.removePartialCopies(row.profile);
      await this.store.updateInstance(row.repositoryId, {
        gitState: 'failed',
        gitPhase: null,
        gitProgress: null,
        gitDetail:
          'supervisor 在仓库副本准备期间重启，准备已中止；请从仓库面板重试。已保留上一次成功副本（如有）。',
        gitFinishedAt: this.now(),
      });
      this.logger.warn(
        {
          event: 'supervisor.git_prepare_interrupted',
          repository: row.fullName,
          profile: row.profile,
        },
        'repository Git copy preparation was interrupted by a supervisor restart',
      );
    }
  }

  /** Removes `<cache>.partial-*` entries left by a killed supervisor or Git. */
  removePartialCopies(profile: string): void {
    const cache = this.cacheDir(profile);
    const parent = dirname(cache);
    try {
      for (const entry of readdirSync(parent)) {
        if (!entry.startsWith(`${GIT_CACHE_DIRECTORY}.partial-`)) continue;
        rmSync(join(parent, entry), { recursive: true, force: true });
      }
    } catch {
      // The profile directory may not exist yet; nothing to clean.
    }
  }

  private async prepareOnce(
    repositoryId: string,
    repository: RepositoryRow,
    instance: InstanceRow,
  ): Promise<void> {
    const profile = instance.profile;
    if (!profile) throw new Error('The repository instance has no profile');
    const cache = this.cacheDir(profile);
    const remote = this.remoteUrl(repository);
    const startedAt = this.now();
    let progress: Progress = { phase: 'connecting', percent: null, detail: null };
    let lastWrite = 0;
    let lastPhase: GitPhase = 'connecting';
    let lastDetail: string | null = null;
    let lastPercent: number | null = null;

    let finished = false;
    const writeProgress = async (next: Progress, force = false): Promise<void> => {
      if (finished) return;
      progress = next;
      const at = Date.now();
      if (
        !force &&
        at - lastWrite < PROGRESS_INTERVAL_MS &&
        next.phase === lastPhase &&
        next.percent === lastPercent &&
        next.detail === lastDetail
      ) {
        return;
      }
      lastWrite = at;
      lastPhase = next.phase;
      lastPercent = next.percent;
      lastDetail = next.detail;
      await this.store.updateInstance(repositoryId, {
        gitState: 'preparing',
        gitPhase: next.phase,
        gitProgress: next.percent,
        gitDetail: next.detail,
        gitStartedAt: startedAt,
      });
    };

    const pinned = this.config.pinned.get(repository.fullName);
    const identity =
      pinned?.runtimeUid !== undefined && pinned.runtimeGid !== undefined
        ? {
            uid: pinned.runtimeUid,
            gid: pinned.runtimeGid,
            setpriv: this.config.reviewCheckSetpriv,
          }
        : undefined;
    const env: NodeJS.ProcessEnv = {
      ...baseEnvironment(),
      ...(pinned?.runtimeHome ? { HOME: pinned.runtimeHome } : {}),
      ...(identity ? { USER: String(identity.uid), LOGNAME: String(identity.uid) } : {}),
      // Progress must be parseable and Git must never wait for a credential.
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      ...this.options.env,
    };
    const run = (argv: string[]): Promise<GitRunResult> =>
      runGit(
        {
          argv,
          cwd: this.config.worktreeRoot,
          env,
          timeoutMs: this.config.repoPrepareTimeoutMs,
          ...(identity ? { identity } : {}),
          onLine: (line) => {
            const parsed = parseGitProgress(line, progress);
            // Progress is best effort: a database hiccup must not fail the clone
            // that is already running, and the final state is written below.
            if (parsed) void writeProgress(parsed).catch(() => {});
          },
        },
        this.options.spawn,
      );

    let partial: string | null = null;
    try {
      const existing = pathExists(cache);
      const target = existing ? cache : (partial = `${cache}.partial-${process.pid}-${Date.now()}`);
      if (existing) {
        await writeProgress(
          { phase: 'connecting', percent: null, detail: '正在从远端更新仓库副本…' },
          true,
        );
      } else {
        rmSync(target, { recursive: true, force: true });
      }
      // A mirror's fetch refspec maps every ref, so `git fetch` both updates an
      // existing copy and reports the same progress lines a clone does.
      if (existing) await this.ensureOrigin(target, remote, run);
      const transfer = existing
        ? await run(['-C', target, 'fetch', '--prune', '--progress', 'origin'])
        : await run(['clone', '--mirror', '--progress', remote, target]);
      if (transfer.timedOut || transfer.code !== 0) {
        throw new GitPreparationError(
          transfer.timedOut ? 'timeout' : 'git_failed',
          explainGitFailure({
            phase: progress.phase,
            timedOut: transfer.timedOut,
            stderr: transfer.stderr,
            ...(transfer.spawnError ? { spawnError: transfer.spawnError } : {}),
          }),
        );
      }

      await writeProgress(
        { phase: 'verifying', percent: null, detail: '正在核对仓库副本与默认分支 HEAD…' },
        true,
      );
      const bare = await run(['-C', target, 'rev-parse', '--is-bare-repository']);
      if (bare.code !== 0 || bare.stdout.trim() !== 'true') {
        throw new GitPreparationError(
          'verify_failed',
          `仓库副本校验失败：不是 bare 仓库。${sanitizeGitDetail(tail(bare.stderr))}`,
        );
      }
      const head = await run([
        '-C',
        target,
        'rev-parse',
        '--verify',
        `refs/heads/${repository.defaultBranch}^{commit}`,
      ]);
      const commit = head.stdout.trim();
      if (head.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
        throw new GitPreparationError(
          'verify_failed',
          `仓库副本校验失败：默认分支 ${repository.defaultBranch} 不存在。`,
        );
      }
      if (partial) {
        rmSync(cache, { recursive: true, force: true });
        renameSync(partial, cache);
        partial = null;
      }
      if (identity) chownTree(cache, identity.uid, identity.gid);
      await writeProgress({ phase: 'ready', percent: 100, detail: '仓库副本已就绪。' }, true);
      finished = true;
      await this.store.updateInstance(repositoryId, {
        gitState: 'ready',
        gitPhase: 'ready',
        gitProgress: 100,
        gitDetail: '仓库副本已就绪，可用于新任务。',
        gitHead: commit,
        gitFinishedAt: this.now(),
      });
      this.logger.info(
        {
          event: 'supervisor.git_prepare_ready',
          repository: repository.fullName,
          profile,
          head: commit,
          updated: existing,
        },
        'repository Git copy is ready',
      );
    } catch (error) {
      finished = true;
      if (partial) rmSync(partial, { recursive: true, force: true });
      const detail =
        error instanceof GitPreparationError
          ? error.message
          : `仓库副本准备失败：${error instanceof Error ? error.message : String(error)}`;
      await this.store.updateInstance(repositoryId, {
        gitState: 'failed',
        gitPhase: progress.phase === 'ready' ? 'verifying' : progress.phase,
        gitProgress: progress.percent,
        gitDetail: sanitizeGitDetail(detail),
        gitFinishedAt: this.now(),
        // Keep the last verified commit; the row still tells the platform to
        // gate new work until a retry succeeds.
        gitHead: instance.gitHead,
      });
    }
  }

  /** Sets `origin` idempotently; a mirror's origin is the only remote. */
  private async ensureOrigin(
    target: string,
    remote: string,
    run: (argv: string[]) => Promise<GitRunResult>,
  ): Promise<void> {
    const set = await run(['-C', target, 'remote', 'set-url', 'origin', remote]);
    if (set.code === 0) return;
    const add = await run(['-C', target, 'remote', 'add', 'origin', remote]);
    if (add.code !== 0) {
      throw new GitPreparationError(
        'git_failed',
        explainGitFailure({
          phase: 'connecting',
          timedOut: add.timedOut,
          stderr: add.stderr,
          ...(add.spawnError ? { spawnError: add.spawnError } : {}),
        }),
      );
    }
  }
}
