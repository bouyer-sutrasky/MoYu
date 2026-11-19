import {
  chmodSync,
  chownSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import type { SupervisorConfig } from './config';
import type { SupervisorLogger } from './logger';
import { configureProfile, waitForPanel } from './panel';
import {
  CGROUP_LAUNCHER,
  collectOwnership,
  ensureCgroup,
  movePidToCgroup,
  cgroupOomKilled,
  removeCgroup,
  pidAlive,
  portFree,
  retainedDescendants,
  stopProcessTree,
  waitForPortClosed,
  type ProcessIdentity,
  type StoredOwnership,
} from './process';
import { githubCloneUrl, gitCachePath, RepositoryGitCache } from './git-cache';
import { removeRepositoryPaths, repositoryRemovalPaths } from './removal';
import {
  instanceLogPath,
  instanceProcessEnvironment,
  pathExists,
  prepareInstance,
  type PreparedInstance,
} from './provision';
import {
  aggregateMemory,
  applyInstanceMemoryLimit,
  assessAdmission,
  limitsFromConfig,
  pressureAvg10,
  readHostMemory,
  readMemorySample,
  selfCgroupPath,
  type AdmissionDecision,
} from './resources';
import type { InstanceRow, SupervisorStore } from './store';

/**
 * The exact prepare command the supervisor writes into a new instance. It is
 * also the platform-managed value the settings write boundary must preserve.
 */
export function buildInstancePrepareCommand(input: {
  fullName: string;
  githubAccount: string;
  githubCommitEmail: string;
  /** The supervisor-owned mirror this repository's tasks clone from. */
  cacheDir: string;
  /** Test seam; production always uses the managed GitHub URL. */
  remoteUrl?: string;
}): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const cache = quote(input.cacheDir);
  const remote = quote(input.remoteUrl ?? githubCloneUrl(input.fullName));
  const name = quote(input.githubAccount);
  const email = quote(input.githubCommitEmail);
  // A ticket workspace is built from the repository copy, never from a fresh
  // remote clone. The frozen commit is present in the copy after preparation;
  // only when it is missing (a commit newer than the last update, or a GitHub
  // ticket whose default branch moved) is the needed object fetched. The clone
  // goes to a sibling temporary directory and is renamed into place, so an
  // interrupted launch can never leave a non-empty `$DSH_SUPERAGENT_DIR` that a
  // later launch mistakes for a prepared workspace.
  return [
    'set -e',
    'DEST="$DSH_SUPERAGENT_DIR"',
    `CACHE=${cache}`,
    `REMOTE=${remote}`,
    'COMMIT="${DSH_SUPERAGENT_WORKSPACE_BASE_COMMIT:-HEAD}"',
    'BRANCH="${DSH_SUPERAGENT_WORKSPACE_BASE_BRANCH:-HEAD}"',
    'TMP="${DEST}.preparing-$$"',
    'if [ ! -d "$CACHE" ]; then echo "仓库的 Git 副本尚未准备好（仓库准备未完成或失败），请先在仓库面板重试准备。" >&2; exit 75; fi',
    'trap \'rm -rf "$TMP"\' EXIT HUP INT TERM',
    'git -c safe.directory=\'*\' clone --no-tags --local "$CACHE" "$TMP"',
    'git -C "$TMP" remote set-url origin "$REMOTE"',
    'if ! git -C "$TMP" cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then',
    '  if [ "$BRANCH" != "HEAD" ]; then git -C "$TMP" fetch --no-tags origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"; fi',
    '  if ! git -C "$TMP" cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then git -C "$TMP" fetch --no-tags origin "$COMMIT"; fi',
    'fi',
    'git -C "$TMP" -c advice.detachedHead=false checkout "$COMMIT"',
    `git -C "$TMP" config user.name ${name}`,
    `git -C "$TMP" config user.email ${email}`,
    'git -C "$TMP" switch -c "agent/$DSH_SUPERAGENT_NAME"',
    'if [ -e "$DEST" ]; then echo "任务工作区已存在，拒绝覆盖；请用原任务继续或新建任务。" >&2; exit 74; fi',
    'trap - EXIT HUP INT TERM',
    'mv "$TMP" "$DEST"',
  ].join('\n');
}

export interface ExecutionBinding {
  ticketId: string;
  assignmentId: string;
  leaseId: string;
  fencingToken: string;
}
export interface WakeInput {
  priority: number;
  reason: 'new_task' | 'reply' | 'manual' | 'retry';
  execution?: ExecutionBinding;
}

export interface SleepResult {
  accepted: boolean;
  duplicate: boolean;
  instance: InstanceRow;
}

export interface WakeResult {
  accepted: boolean;
  duplicate: boolean;
  instance: InstanceRow;
  refused?: string;
}

function storedOwnership(row: InstanceRow): StoredOwnership {
  const value = row.ownership ?? {};
  return {
    rootPid: typeof value.rootPid === 'number' ? value.rootPid : row.pid,
    pgid: typeof value.pgid === 'number' ? value.pgid : row.pid,
    cgroup: typeof value.cgroup === 'string' ? value.cgroup : null,
    adoptedUnproven: value.adoptedUnproven === true,
    execution:
      value.execution && typeof value.execution === 'object'
        ? (value.execution as ExecutionBinding)
        : null,
    members: Array.isArray(value.members) ? (value.members as StoredOwnership['members']) : [],
  };
}

function ownershipPayload(
  rootPid: number | null,
  pgid: number | null,
  members: ProcessIdentity[],
  cgroup: string | null = null,
) {
  return {
    rootPid,
    pgid,
    cgroup,
    members: members.map((member) => ({
      pid: member.pid,
      startTime: member.startTime,
      pgid: member.pgid,
      sid: member.sid,
      command: member.command,
    })),
  };
}

/** A queued wake merges the highest priority and keeps the oldest request time. */
export function mergeQueuedWake(
  existing: { queuePriority: number; wakeRequestedAt: Date | null },
  incoming: { priority: number; at: Date },
  queued: boolean,
): { queuePriority: number; wakeRequestedAt: Date } {
  if (!queued || !existing.wakeRequestedAt) {
    return { queuePriority: incoming.priority, wakeRequestedAt: incoming.at };
  }
  return {
    queuePriority: Math.min(existing.queuePriority, incoming.priority),
    wakeRequestedAt:
      existing.wakeRequestedAt.getTime() <= incoming.at.getTime()
        ? existing.wakeRequestedAt
        : incoming.at,
  };
}

interface RuntimeHandle {
  pid: number;
  generation: number;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/token[=:]\s*\S+/gi, 'token=[redacted]')
    .slice(0, 500);
}

function baseEnvironment(): Record<string, string> {
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
  ]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key)) result[key] = value;
  }
  return result;
}

async function portOpen(port: number, timeoutMs = 600): Promise<boolean> {
  const { createConnection } = await import('node:net');
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function modelParts(encoded: string): { provider: string; model: string } {
  const index = encoded.indexOf('/');
  if (index <= 0 || index === encoded.length - 1) {
    throw new Error(`EXECUTOR_MODEL must be provider/model, got ${encoded}`);
  }
  return { provider: encoded.slice(0, index), model: encoded.slice(index + 1) };
}

/**
 * Owns every repository runtime process. The platform only ever sends a
 * repository id plus a permitted lifecycle action; paths, commands, ports and
 * tokens come from this manager's fixed configuration and the repository row.
 */
export class InstanceManager {
  private readonly handles = new Map<string, RuntimeHandle>();
  private generation = 0;
  private lock: Promise<void> = Promise.resolve();
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastResourceSampleAt = 0;
  private readonly resourceBlocked = new Set<string>();

  private readonly gitCache: RepositoryGitCache;

  constructor(
    private readonly config: SupervisorConfig,
    private readonly store: SupervisorStore,
    private readonly logger: SupervisorLogger,
  ) {
    this.gitCache = new RepositoryGitCache(config, store, logger);
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async start(): Promise<void> {
    for (const directory of [
      this.config.credentialsDir,
      this.config.instanceEnvDir,
      this.config.logDir,
      this.config.worktreeRoot,
      this.config.dshHome,
      join(this.config.dshHome, 'homes'),
      join(this.config.dshHome, 'profiles'),
      join(this.config.dshHome, 'state'),
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Shared parents are traverse-only. Each runtime reaches its own
      // 0700 profile/state/worktree entry, but cannot list or enter another
      // repository's entry. The worktree root stays group-shared so a
      // per-repository check user can traverse to its own profile.
      if (
        directory === this.config.dshHome ||
        directory === join(this.config.dshHome, 'homes') ||
        directory === join(this.config.dshHome, 'profiles') ||
        directory === join(this.config.dshHome, 'state')
      ) {
        chmodSync(directory, 0o711);
      } else if (
        directory === this.config.worktreeRoot &&
        this.config.reviewCheckGid !== undefined
      ) {
        chownSync(directory, -1, this.config.reviewCheckGid);
        chmodSync(directory, 0o2775);
      } else {
        chmodSync(directory, 0o700);
      }
    }
    await this.withLock(async () => {
      const rows = await this.store.listInstances();
      for (const row of rows) {
        await this.reconcileRestart(row);
      }
    });
    // A preparation child does not survive a supervisor restart. Record the
    // interruption instead of leaving the row `preparing` for ever, so the
    // repository panel offers a real retry and new execution stays gated.
    await this.gitCache.recover();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error(
          { event: 'supervisor.tick_failed', error: safeError(error) },
          'lifecycle tick failed',
        );
      });
    }, this.config.tickIntervalMs);
    this.timer.unref();
    await this.tick();
  }

  /**
   * Converges one persisted instance after a supervisor restart. A root PID
   * that is gone is not enough to release capacity: stored descendants and the
   * old process group are checked, and a failed cleanup stays `stopping`.
   */
  /**
   * Moves an adopted runtime (and its current descendants) into a new cgroup.
   * Existing rows predate the cgroup boundary; without this migration a stop
   * after an upgrade would have no durable proof for setsid children.
   */
  private async attachCgroup(row: InstanceRow, stored: StoredOwnership): Promise<StoredOwnership> {
    if (stored.cgroup || !row.pid || !row.profile || !pidAlive(row.pid)) return stored;
    const snapshot = collectOwnership(row.pid, stored);
    const verified = snapshot.members.some((member) => member.pid === row.pid);
    if (!verified) {
      // The saved identity no longer matches this PID. Never launder an
      // unrelated process into a fresh cgroup.
      const next = { ...stored, adoptedUnproven: true };
      await this.store.updateInstance(row.repositoryId, { ownership: next });
      return next;
    }
    const cgroup = ensureCgroup(`${row.profile}-adopt-${Date.now()}`);
    if (!cgroup) {
      const next = { ...stored, adoptedUnproven: true };
      await this.store.updateInstance(row.repositoryId, { ownership: next });
      return next;
    }
    let moved = movePidToCgroup(cgroup, row.pid);
    for (const member of snapshot.members) {
      if (member.pid !== row.pid && movePidToCgroup(cgroup, member.pid)) moved = true;
    }
    if (!moved) {
      removeCgroup(cgroup);
      return stored;
    }
    const next = {
      ...stored,
      cgroup,
      // A live process adopted after the fact may already have double-forked
      // descendants that no scan can recover; a new cgroup cannot prove them.
      adoptedUnproven: true,
      members: [...(stored.members ?? []), ...snapshot.members],
    };
    await this.store.updateInstance(row.repositoryId, { ownership: next });
    return next;
  }

  /**
   * A row that still says `online` while its recorded process is gone is a lie:
   * the runtime died (typically because a supervisor restart removed the unit
   * cgroup). Requeue it instead of reporting an instance that no longer exists,
   * so the panel proxy and the settings UI stop talking to a dead port and the
   * scheduler can start it again.
   */
  /**
   * Settle a row whose recorded process is gone.
   *
   * A supervisor restart removes the unit cgroup, so the runtimes die with it. The
   * rows can be left `online` (the old lie) or `stopping`/`stop_failed` (a stop
   * that can never be confirmed). Both wedge a repository: `online` talks to a
   * dead port, and `stopping` holds an online slot forever while nothing runs.
   *
   * With the pid provably gone the stop *is* complete, so record that truth:
   * sleeping, `desiredState` preserved, and let the scheduler decide whether to
   * start it again.
   */
  private async settleDeadRuntime(row: InstanceRow): Promise<boolean> {
    if (row.state !== 'online' && row.state !== 'stopping') return false;
    if (row.pid && pidAlive(row.pid)) return false;
    const wasStopping = row.state === 'stopping';
    await this.store.updateInstance(row.repositoryId, {
      state: 'sleeping',
      desiredState: row.desiredState,
      pid: null,
      ownership: {},
      reasonCode: wasStopping ? 'stop_settled' : 'instance_lost',
      reasonDetail: wasStopping
        ? 'The recorded processes are gone, so the stop is complete; the instance is queued again if it was wanted online'
        : 'The recorded runtime process is gone (for example because a supervisor restart removed its cgroup); the instance is queued to start again',
      waitingFor: null,
      errorCode: null,
      errorDetail: null,
      ...(wasStopping ? { lastStoppedAt: new Date() } : { lastStoppedAt: null }),
    });
    await this.store.syncRepositoryStatus(row.repositoryId, 'sleeping');
    this.logger.warn(
      {
        event: wasStopping ? 'supervisor.stop_settled' : 'supervisor.instance_lost',
        repositoryId: row.repositoryId,
        pid: row.pid,
      },
      wasStopping
        ? 'recorded processes are gone; the stop is settled'
        : 'recorded runtime process is gone; requeued the instance',
    );
    return true;
  }

  private async reconcileRestart(row: InstanceRow): Promise<void> {
    let stored = storedOwnership(row);
    let snapshot = collectOwnership(row.pid ?? 0, stored);
    let live = snapshot.members;
    const rootAlive = row.pid ? pidAlive(row.pid) : false;
    if (await this.settleDeadRuntime(row)) return;
    if (!stored.cgroup && rootAlive) {
      stored = await this.attachCgroup(row, stored);
      snapshot = collectOwnership(row.pid ?? 0, stored);
      live = snapshot.members;
    }
    if (snapshot.unknown) {
      if (row.state === 'online' && row.desiredState === 'online') {
        await this.store.updateInstance(row.repositoryId, {
          reasonCode: 'ownership_unverified',
          reasonDetail:
            'The adopted runtime is serving, but its historical descendants cannot be proven; sleep will remain blocked',
          waitingFor: 'runtime',
        });
        return;
      }
      await this.store.updateInstance(row.repositoryId, {
        state: 'stopping',
        desiredState: row.desiredState,
        pid: row.pid,
        ownership: { ...stored, members: [...(stored.members ?? []), ...live] },
        reasonCode: 'stop_failed',
        reasonDetail:
          'Process ownership is unverified; capacity remains occupied until it is cleared',
        waitingFor: 'process_exit',
        errorCode: 'stop_failed',
        errorDetail: 'unverified process group/session members',
      });
      await this.store.syncRepositoryStatus(row.repositoryId, 'stopping');
      return;
    }

    if (row.state === 'online') {
      if (rootAlive) {
        const bridgeUp = row.bridgePort ? await portOpen(row.bridgePort) : false;
        await this.store.updateInstance(row.repositoryId, {
          lastHealthAt: bridgeUp ? new Date() : row.lastHealthAt,
          ownership: ownershipPayload(row.pid, snapshot.pgid, live, stored.cgroup),
          reasonCode: bridgeUp ? 'listening' : 'bridge_unreachable',
          reasonDetail: bridgeUp
            ? null
            : 'The runtime process survived the supervisor restart but its Bridge did not answer the first health check',
          waitingFor: bridgeUp ? null : 'runtime',
        });
        return;
      }
      if (live.length > 0) {
        const stopped = await this.stopInstance(row, 'restart_cleanup', 'process_exit');
        if (stopped) {
          await this.failInstance(
            row,
            'instance_lost',
            'The runtime root exited but its descendants survived; they are stopped now',
          );
        }
        return;
      }
      await this.failInstance(
        row,
        'instance_lost',
        'The supervisor restarted and could not confirm the previous runtime process',
      );
      return;
    }

    if (row.state === 'starting') {
      const bridgeUp = row.bridgePort ? await portOpen(row.bridgePort) : false;
      if (rootAlive && bridgeUp && row.desiredState === 'online') {
        await this.store.updateInstance(row.repositoryId, {
          state: 'online',
          lastHealthAt: new Date(),
          lastOnlineAt: new Date(),
          ownership: ownershipPayload(row.pid, snapshot.pgid, live, stored.cgroup),
          reasonCode: 'listening',
          reasonDetail: null,
          waitingFor: null,
        });
        await this.store.syncRepositoryStatus(row.repositoryId, 'online');
        return;
      }
      if (live.length > 0) {
        const stopped = await this.stopInstance(row, 'restart_cleanup', 'process_exit');
        if (stopped) {
          await this.failInstance(
            row,
            'instance_lost',
            'The supervisor restarted while this runtime was still starting; the process tree is stopped',
          );
        }
        return;
      }
      await this.failInstance(
        row,
        'instance_lost',
        'The supervisor restarted while this runtime was still starting',
      );
      return;
    }

    if (row.state === 'stopping') {
      await this.stopInstance(row, 'restart_stop', 'process_exit');
      return;
    }

    if (live.length > 0) {
      // A fault/sleeping row with surviving descendants keeps its capacity and
      // is reported as a stop in progress instead of being silently released.
      await this.stopInstance(row, 'restart_orphan', 'process_exit');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Wait for an in-flight tick before the caller closes the pool. Without this
    // the tick's queries run against an ended pool and the process crashes with
    // 'Cannot use a pool after calling end on the pool', which systemd reports as
    // a failed unit on every restart.
    await this.withLock(async () => undefined);
    // The supervisor does not kill running runtime processes on its own exit:
    // they are detached and the next supervisor adopts them. Explicit sleep is
    // the only path that stops a runtime.
  }

  async prepare(repositoryId: string): Promise<InstanceRow> {
    return this.withLock(async () => {
      const prepared = await prepareInstance(this.config, this.store, repositoryId);
      await this.store.syncRepositoryStatus(repositoryId, 'sleeping');
      const instance = await this.store.getInstance(repositoryId);
      if (!instance) throw new Error('Instance row was not created');
      this.logger.info(
        {
          event: 'supervisor.instance_prepared',
          repository: prepared.repository.fullName,
          profile: prepared.profile,
          dshPort: prepared.dshPort,
          bridgePort: prepared.bridgePort,
        },
        'repository instance prepared',
      );
      // The instance is usable for settings immediately, but a new task must
      // wait for the repository copy. Preparation is asynchronous and reports
      // its own phases; a failure is retried from the repository panel.
      if (instance.gitState !== 'ready') {
        await this.gitCache.begin(repositoryId).catch((error: unknown) => {
          this.logger.warn(
            {
              event: 'supervisor.git_prepare_start_failed',
              repository: prepared.repository.fullName,
              error: error instanceof Error ? error.message.slice(0, 300) : String(error),
            },
            'could not start repository Git copy preparation',
          );
        });
      }
      return (await this.store.getInstance(repositoryId)) ?? instance;
    });
  }

  /**
   * Repository-level retry of the Git copy. It deliberately bypasses the
   * `ready` short-circuit: a person may want to refresh a stale copy, and the
   * call coalesces with an in-flight preparation instead of cloning twice.
   */
  async prepareGit(repositoryId: string): Promise<InstanceRow> {
    return this.withLock(async () => {
      const repository = await this.store.getRepository(repositoryId);
      if (!repository) throw Object.assign(new Error('Repository not found'), { statusCode: 404 });
      if (repository.deletionState !== 'none') {
        throw Object.assign(new Error('该仓库正在移除或已移除，不能准备副本'), { statusCode: 409 });
      }
      await this.gitCache.begin(repositoryId);
      const instance = await this.store.getInstance(repositoryId);
      if (!instance) throw new Error('Instance row was not created');
      return instance;
    });
  }

  async wake(repositoryId: string, input: WakeInput): Promise<WakeResult> {
    return this.withLock(async () => {
      const repository = await this.store.getRepository(repositoryId);
      if (repository && repository.deletionState !== 'none') {
        throw Object.assign(new Error('该仓库正在移除或已移除，不能启动实例'), {
          statusCode: 409,
        });
      }
      let instance = await this.store.getInstance(repositoryId);
      if (!instance) {
        const prepared = await prepareInstance(this.config, this.store, repositoryId);
        this.logger.info(
          {
            event: 'supervisor.instance_prepared',
            repository: prepared.repository.fullName,
            profile: prepared.profile,
          },
          'repository instance prepared on wake',
        );
        instance = await this.store.getInstance(repositoryId);
        if (!instance) throw new Error('Instance row was not created');
        if (instance.gitState !== 'ready') {
          await this.gitCache.begin(repositoryId).catch((error: unknown) => {
            this.logger.warn(
              {
                event: 'supervisor.git_prepare_start_failed',
                repository: prepared.repository.fullName,
                error: error instanceof Error ? error.message.slice(0, 300) : String(error),
              },
              'could not start repository Git copy preparation on wake',
            );
          });
          instance = (await this.store.getInstance(repositoryId)) ?? instance;
        }
      }
      const now = new Date();
      await this.store.setLastActivity(repositoryId, now);
      const alreadyQueued =
        instance.desiredState === 'online' &&
        instance.wakeRequestedAt !== null &&
        (instance.state === 'sleeping' || instance.state === 'stopping');
      const merged = mergeQueuedWake(
        {
          queuePriority: instance.queuePriority,
          wakeRequestedAt: instance.wakeRequestedAt,
        },
        { priority: input.priority, at: now },
        alreadyQueued,
      );
      if (instance.state === 'online' || instance.state === 'starting') {
        if (input.execution) {
          const stored = storedOwnership(instance).execution;
          if (
            stored &&
            (stored.ticketId !== input.execution.ticketId ||
              stored.assignmentId !== input.execution.assignmentId ||
              stored.leaseId !== input.execution.leaseId ||
              stored.fencingToken !== input.execution.fencingToken)
          ) {
            return {
              accepted: false,
              duplicate: false,
              instance,
              refused: 'runtime is bound to another execution generation',
            };
          }
        }
        await this.store.updateInstance(repositoryId, {
          desiredState: 'online',
          lastActivityAt: now,
          ...(instance.activationRequestedAt
            ? {}
            : { activationRequestedAt: instance.wakeRequestedAt ?? now }),
          ...(instance.state === 'online'
            ? { reasonCode: 'listening', reasonDetail: null, waitingFor: null }
            : { reasonCode: 'starting', reasonDetail: null, waitingFor: null }),
        });
        return {
          accepted: true,
          duplicate: true,
          instance: (await this.store.getInstance(repositoryId)) ?? instance,
        };
      }
      await this.store.updateInstance(repositoryId, {
        desiredState: 'online',
        wakeRequestedAt: merged.wakeRequestedAt,
        activationRequestedAt: merged.wakeRequestedAt ?? now,
        queuePriority: merged.queuePriority,
        reasonCode: instance.state === 'stopping' ? 'stopping' : 'wake_queued',
        reasonDetail: null,
        waitingFor: 'capacity',
        lastActivityAt: now,
        ...(instance.state === 'fault'
          ? { state: 'sleeping', attemptCount: 0, errorCode: null, errorDetail: null }
          : {}),
      });
      this.logger.info(
        {
          event: 'supervisor.wake_requested',
          repositoryId,
          from: instance.state,
          priority: input.priority,
          reason: input.reason,
        },
        'repository wake requested',
      );
      void this.tick().catch(() => undefined);
      return {
        accepted: true,
        duplicate: alreadyQueued,
        instance: (await this.store.getInstance(repositoryId)) ?? instance,
      };
    });
  }

  /**
   * Restart one instance so a Deployment change (limits in the profile patch)
   * takes effect. Refuses while a task or owner command is active: restarting
   * would discard work the runtime may still need.
   */
  /**
   * Why a Deployment restart cannot safely stop the runtime yet. Task rows and
   * pending owner commands are not enough: a delivery can hold a live lease
   * before its task row exists, so the lease is checked too.
   */
  private async restartGate(
    repositoryId: string,
  ): Promise<{ reason: string; waitingFor: string } | null> {
    const gate = await this.store.taskGate(repositoryId);
    const lease = await this.store.activeExecutionLease(repositoryId);
    if (gate.active > 0 || gate.pendingOperations > 0 || lease) {
      const parts = [
        gate.active > 0 ? `${gate.active} active task(s)` : null,
        gate.pendingOperations > 0 ? `${gate.pendingOperations} pending operation(s)` : null,
        lease ? `an active execution lease (${lease.holderId})` : null,
      ].filter(Boolean);
      return {
        reason: `The saved Deployment limits are pending because ${parts.join(', ')} still exist; they apply after that work finishes and the instance restarts`,
        waitingFor: 'execution',
      };
    }
    return null;
  }

  /**
   * Stops the instance and deletes only this repository's local resources, then
   * forgets its runtime binding. Tasks, conversations, leases and the repository
   * row stay for history and a later re-add; the GitHub remote is never touched.
   * Refuses while a task, command, lease, preparation or retained background
   * service still holds the instance.
   */
  async removeRepository(repositoryId: string): Promise<{
    removed: boolean;
    alreadyRemoved: boolean;
    profile: string | null;
    paths: string[];
  }> {
    return this.withLock(async () => {
      const repository = await this.store.getRepository(repositoryId);
      if (!repository) {
        return { removed: true, alreadyRemoved: true, profile: null, paths: [] };
      }
      const instance = await this.store.getInstance(repositoryId);
      if (!instance?.profile) {
        await this.store.forgetRepositoryRuntime(repositoryId);
        return { removed: true, alreadyRemoved: true, profile: null, paths: [] };
      }
      if (instance.gitState === 'preparing') {
        throw Object.assign(new Error('仓库副本正在准备；完成后才能移除'), { statusCode: 409 });
      }
      const gate = await this.store.taskGate(repositoryId);
      const lease = await this.store.activeExecutionLease(repositoryId);
      if (gate.active > 0 || gate.pendingOperations > 0) {
        throw Object.assign(new Error('仍有进行中的任务或所有者命令；请等待它们结束后再移除'), {
          statusCode: 409,
        });
      }
      if (lease) {
        throw Object.assign(new Error('仍有执行租约占用这个仓库；请先释放租约'), {
          statusCode: 409,
        });
      }
      const background = instance.pid
        ? retainedDescendants(instance.pid, storedOwnership(instance))
        : [];
      if (background.length > 0) {
        throw Object.assign(
          new Error(`实例仍保留 ${background.length} 个后台进程；停止后才能移除`),
          { statusCode: 409 },
        );
      }
      if (['online', 'starting', 'stopping'].includes(instance.state)) {
        const stopped = await this.stopInstance(instance, 'repository_removed', 'idle');
        if (!stopped) {
          throw Object.assign(new Error('实例尚未完全停止；请重试移除'), { statusCode: 409 });
        }
      }

      const pinnedHome = this.config.pinned.get(repository.fullName)?.runtimeHome;
      const paths = repositoryRemovalPaths(this.config, repositoryId, instance.profile, pinnedHome);
      const result = removeRepositoryPaths(paths);
      if (result.errors.length > 0) {
        const detail = result.errors
          .map((item) => `${item.path}: ${item.error}`)
          .join('; ')
          .slice(0, 800);
        throw new Error(`本地资源清理失败：${detail}`);
      }
      await this.store.forgetRepositoryRuntime(repositoryId);
      this.logger.info(
        {
          event: 'supervisor.repository_removed',
          repositoryId,
          profile: instance.profile,
          paths: result.removed.length,
        },
        'removed a repository runtime and its local resources',
      );
      return {
        removed: true,
        alreadyRemoved: false,
        profile: instance.profile,
        paths: result.removed,
      };
    });
  }

  async restart(repositoryId: string): Promise<{ restarted: boolean; reason?: string }> {
    return this.withLock(async () => {
      const row = await this.store.getInstance(repositoryId);
      if (!row) return { restarted: false, reason: 'No instance row for this repository' };
      if (row.state !== 'online' && row.state !== 'starting') {
        return { restarted: false, reason: `The instance is ${row.state}` };
      }

      // Close the admission window before checking the gate: the dispatcher
      // locks this same repository_instances row before taking a lease, and
      // refuses to acquire while the state is not online. If there is work in
      // flight we restore `online` and let the tick retry once it is safe.
      if (row.state === 'online') {
        await this.store.updateInstance(repositoryId, {
          state: 'stopping',
          desiredState: 'online',
          reasonCode: 'restart_gate',
          reasonDetail: 'Checking that no task, command or lease is active before restarting',
          waitingFor: 'settings_restart',
        });
      }
      const blocked = await this.restartGate(repositoryId);
      if (blocked) {
        if (row.state === 'online') {
          await this.store.updateInstance(repositoryId, {
            state: 'online',
            desiredState: 'online',
            reasonCode: 'restart_pending',
            reasonDetail: blocked.reason,
            waitingFor: blocked.waitingFor,
          });
        } else {
          await this.store.updateInstance(repositoryId, {
            reasonCode: 'restart_pending',
            reasonDetail: blocked.reason,
            waitingFor: blocked.waitingFor,
          });
        }
        return { restarted: false, reason: blocked.reason };
      }

      const stopped = await this.stopInstance(row, 'settings_restart', 'manual');
      if (!stopped) {
        return {
          restarted: false,
          reason: 'The runtime did not confirm that it stopped; it will not be started again yet',
        };
      }
      await this.store.updateInstance(repositoryId, {
        desiredState: 'online',
        reasonCode: 'restarting_for_settings',
        reasonDetail: 'Restarting so the saved Deployment limits take effect',
        waitingFor: null,
      });
      this.logger.info(
        { event: 'supervisor.instance_restarting', repositoryId },
        'restarting the runtime so saved Deployment settings take effect',
      );
      return { restarted: true };
    });
  }

  async touch(repositoryId: string): Promise<InstanceRow> {
    const at = new Date();
    await this.store.setLastActivity(repositoryId, at);
    const instance = await this.store.getInstance(repositoryId);
    if (!instance) throw new Error('Instance not found');
    return instance;
  }

  /**
   * Stops a runtime only after proving there is no active work and no retained
   * background process. A status field or an idle worker alone is not enough.
   */
  async sleep(repositoryId: string, manual: boolean): Promise<SleepResult> {
    return this.withLock(async () => {
      const instance = await this.store.getInstance(repositoryId);
      if (!instance) throw new Error('Instance not found');
      if (instance.state === 'sleeping') {
        await this.store.updateInstance(repositoryId, {
          desiredState: 'sleeping',
          reasonCode: 'sleeping',
          reasonDetail: null,
          waitingFor: null,
        });
        return {
          accepted: true,
          duplicate: true,
          instance: (await this.store.getInstance(repositoryId)) ?? instance,
        };
      }
      if (instance.state === 'stopping') {
        if (instance.reasonCode === 'stop_failed') {
          const stopped = await this.stopInstance(instance, 'retry_stop', 'process_exit');
          return {
            accepted: stopped,
            duplicate: false,
            instance: (await this.store.getInstance(repositoryId)) ?? instance,
          };
        }
        return {
          accepted: false,
          duplicate: true,
          instance,
        };
      }
      if (instance.state === 'fault') {
        await this.store.updateInstance(repositoryId, {
          desiredState: 'sleeping',
          reasonCode: 'fault',
          reasonDetail: instance.reasonDetail,
          waitingFor: null,
        });
        return {
          accepted: true,
          duplicate: true,
          instance: (await this.store.getInstance(repositoryId)) ?? instance,
        };
      }
      const gate = await this.store.taskGate(repositoryId);
      const background = retainedDescendants(instance.pid ?? 0, storedOwnership(instance));
      if (gate.active > 0 || gate.pendingOperations > 0) {
        await this.store.updateInstance(repositoryId, {
          desiredState: 'online',
          reasonCode: 'sleep_refused',
          reasonDetail:
            'A task or owner command is still active; the runtime stays online until it finishes or waits for a person',
          waitingFor: 'execution',
        });
        return {
          accepted: false,
          duplicate: false,
          instance: (await this.store.getInstance(repositoryId)) ?? instance,
        };
      }
      if (background.length > 0) {
        await this.store.updateInstance(repositoryId, {
          desiredState: 'online',
          reasonCode: 'sleep_refused',
          reasonDetail: `The runtime still owns ${background.length} background process(es); stopping would discard work it may still need`,
          waitingFor: 'background_service',
        });
        return {
          accepted: false,
          duplicate: false,
          instance: (await this.store.getInstance(repositoryId)) ?? instance,
        };
      }
      this.logger.info(
        { event: 'supervisor.sleeping', repositoryId, manual },
        'stopping repository runtime',
      );
      const stopped = await this.stopInstance(instance, manual ? 'manual' : 'idle', 'idle');
      return {
        accepted: stopped,
        duplicate: false,
        instance: (await this.store.getInstance(repositoryId)) ?? instance,
      };
    });
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.withLock(async () => {
      // A wake/timer can queue a tick while shutdown is waiting for the lock.
      // Re-check after acquiring it so no query runs against an ended pool.
      if (this.stopped) return;
      const rows = await this.store.listInstances();
      await this.sampleResources(rows).catch((error) => {
        this.logger.warn(
          { event: 'supervisor.resource_sample_failed', error: safeError(error) },
          'could not sample measured memory; admission stays conservative',
        );
      });
      for (const row of rows) {
        try {
          await this.store.recordProgress(row.repositoryId);
        } catch {
          // Progress is explanatory only; a missing row must not stop scheduling.
        }
        const stored = storedOwnership(row);
        const snapshot = collectOwnership(row.pid ?? 0, stored);
        const live = snapshot.members;

        if (await this.settleDeadRuntime(row)) continue;

        if (snapshot.unknown) {
          const current = (await this.store.getInstance(row.repositoryId)) ?? row;
          if (row.state === 'online' && current.desiredState === 'online') {
            await this.store.updateInstance(row.repositoryId, {
              reasonCode: 'ownership_unverified',
              reasonDetail:
                'The runtime is serving, but its historical descendants cannot be proven; sleep will remain blocked',
              waitingFor: 'runtime',
            });
            continue;
          }
          await this.store.updateInstance(row.repositoryId, {
            state: 'stopping',
            desiredState: current.desiredState,
            pid: row.pid,
            ownership: { ...stored, members: [...(stored.members ?? []), ...live] },
            reasonCode: 'stop_failed',
            reasonDetail:
              'Process ownership is unverified; capacity remains occupied until it is cleared',
            waitingFor: 'process_exit',
            errorCode: 'stop_failed',
            errorDetail: 'unverified process group/session members',
          });
          await this.store.syncRepositoryStatus(row.repositoryId, 'stopping');
          await this.store.recordProgress(row.repositoryId);
          continue;
        }

        const rootAlive = row.pid ? pidAlive(row.pid) : false;
        const bridgeUp = row.bridgePort ? await portOpen(row.bridgePort) : false;
        this.logger.debug(
          {
            event: 'supervisor.health_check',
            repositoryId: row.repositoryId,
            pid: row.pid,
            port: row.port,
            bridgePort: row.bridgePort,
            bridgeUp,
            rootAlive,
            descendants: live.length,
          },
          'checked runtime health',
        );

        if (live.length === 0) {
          if (row.state === 'stopping') {
            if (bridgeUp) {
              // No owned process remains, but the Bridge port still accepts
              // connections. It may be an unrelated listener or a process we
              // could not identify; do not release the slot on a guess.
              const current = (await this.store.getInstance(row.repositoryId)) ?? row;
              await this.store.updateInstance(row.repositoryId, {
                state: 'stopping',
                desiredState: current.desiredState,
                pid: null,
                ownership: {},
                reasonCode: 'stop_failed',
                reasonDetail: `The Bridge port ${row.bridgePort ?? '(none)'} is still listening after the owned process tree exited`,
                waitingFor: 'process_exit',
                errorCode: 'stop_failed',
                errorDetail: 'port still listening after process exit',
              });
              await this.store.syncRepositoryStatus(row.repositoryId, 'stopping');
              continue;
            }
            await this.markSleeping(row, 'stop_completed');
          } else if (row.state === 'starting' || row.state === 'online') {
            await this.failInstance(
              row,
              'instance_lost',
              'The runtime process and all descendants exited unexpectedly',
            );
          }
          continue;
        }

        if (row.state === 'stopping') {
          if (row.reasonCode === 'stop_failed') {
            const current = (await this.store.getInstance(row.repositoryId)) ?? row;
            await this.store.updateInstance(row.repositoryId, {
              state: 'stopping',
              desiredState: current.desiredState,
              ownership: ownershipPayload(row.pid, snapshot.pgid, live, stored.cgroup),
              reasonCode: 'stop_failed',
              reasonDetail: `Stopping is incomplete: ${live.length} process(es) still alive`,
              waitingFor: 'process_exit',
              pid: row.pid,
              errorCode: 'stop_failed',
              errorDetail: 'stop did not prove every descendant exited',
            });
            continue;
          }
          await this.stopInstance(row, 'stop_retry', 'process_exit');
          continue;
        }

        if (!rootAlive) {
          const stopped = await this.stopInstance(row, 'orphan_cleanup', 'process_exit');
          if (stopped) {
            await this.failInstance(
              (await this.store.getInstance(row.repositoryId)) ?? row,
              'instance_lost',
              'The runtime root exited but its descendants survived; they are now stopped',
            );
          }
          continue;
        }

        await this.store.updateInstance(row.repositoryId, {
          ownership: ownershipPayload(row.pid, snapshot.pgid, live, stored.cgroup),
        });

        if (row.state === 'online') {
          if (!bridgeUp) {
            // A live process is not an instance failure. The worker may be busy
            // enough that the Bridge briefly cannot answer; killing it here would
            // destroy real work. Keep the process and report the unknown health
            // honestly instead of guessing that it is gone.
            await this.store.updateInstance(row.repositoryId, {
              reasonCode: 'bridge_unreachable',
              reasonDetail:
                'The runtime process is alive but its Bridge did not answer the health check; the instance is left running',
              waitingFor: 'runtime',
            });
          } else {
            await this.store.updateInstance(row.repositoryId, {
              lastHealthAt: new Date(),
              ...(row.reasonCode === 'bridge_unreachable'
                ? { reasonCode: 'online', reasonDetail: null, waitingFor: null }
                : {}),
            });
          }
        }

        // A Deployment save that found active work leaves reasonCode
        // restart_pending. Retry the restart on a later tick, never while a
        // task/command/lease is still live.
        if (row.state === 'online' && row.reasonCode === 'restart_pending') {
          const blocked = await this.restartGate(row.repositoryId);
          if (blocked) {
            await this.store.updateInstance(row.repositoryId, {
              reasonCode: 'restart_pending',
              reasonDetail: blocked.reason,
              waitingFor: blocked.waitingFor,
            });
            continue;
          }
          const stopped = await this.stopInstance(row, 'settings_restart', 'manual');
          if (stopped) {
            await this.store.updateInstance(row.repositoryId, {
              desiredState: 'online',
              reasonCode: 'restarting_for_settings',
              reasonDetail: 'Restarting so the saved Deployment limits take effect',
              waitingFor: null,
            });
            this.logger.info(
              { event: 'supervisor.instance_restarting', repositoryId: row.repositoryId },
              'restarting the runtime after the active work finished',
            );
          }
          continue;
        }

        if (row.desiredState === 'sleeping') {
          if (row.state === 'starting') {
            await this.stopInstance(row, 'idle', 'idle');
          } else if (row.state === 'online') {
            const gate = await this.store.taskGate(row.repositoryId);
            const background = retainedDescendants(row.pid ?? 0, stored);
            if (gate.active === 0 && gate.pendingOperations === 0 && background.length === 0) {
              await this.stopInstance(row, 'idle', 'idle');
            } else {
              await this.store.updateInstance(row.repositoryId, {
                desiredState: 'online',
                reasonCode: 'sleep_refused',
                reasonDetail:
                  gate.active > 0 || gate.pendingOperations > 0
                    ? 'A task or owner command is still active; an explicit sleep waits for it to finish'
                    : `The runtime still owns ${background.length} background process(es)`,
                waitingFor:
                  gate.active > 0 || gate.pendingOperations > 0
                    ? 'execution'
                    : 'background_service',
              });
            }
          }
        }
      }

      let active = await this.store.onlineInstances();
      const pending = await this.store.pendingWakeInstances();
      for (const candidate of pending) {
        const current = await this.store.getInstance(candidate.repositoryId);
        if (!current || current.desiredState !== 'online') continue;
        if (current.state === 'online' || current.state === 'starting') continue;
        if (active.length >= this.config.maxOnline) {
          const evictable = active
            .filter(
              (row) =>
                row.repositoryId !== current.repositoryId &&
                row.state === 'online' &&
                row.desiredState === 'online' &&
                row.pid,
            )
            .sort(
              (left, right) =>
                (left.lastActivityAt?.getTime() ?? 0) - (right.lastActivityAt?.getTime() ?? 0),
            );
          let evicted = false;
          for (const victim of evictable) {
            const gate = await this.store.taskGate(victim.repositoryId);
            const background = victim.pid
              ? retainedDescendants(victim.pid, storedOwnership(victim))
              : [];
            if (gate.active > 0 || gate.pendingOperations > 0 || background.length > 0) continue;
            this.logger.info(
              {
                event: 'supervisor.evict_idle',
                repositoryId: victim.repositoryId,
                forRepositoryId: current.repositoryId,
              },
              'evicting the least recently active idle instance for capacity',
            );
            await this.stopInstance(victim, 'evicted_for_capacity', 'capacity');
            active = await this.store.onlineInstances();
            evicted = true;
            break;
          }
          if (!evicted) {
            await this.store.updateInstance(current.repositoryId, {
              state: 'sleeping',
              reasonCode: 'capacity_wait',
              reasonDetail: `Both online slots are in use (${this.config.maxOnline}); this repository is queued`,
              waitingFor: 'capacity',
            });
            await this.store.syncRepositoryStatus(current.repositoryId, 'sleeping');
            continue;
          }
        }
        if (active.length >= this.config.maxOnline) {
          await this.store.updateInstance(current.repositoryId, {
            state: 'sleeping',
            reasonCode: 'capacity_wait',
            reasonDetail: `Both online slots are in use (${this.config.maxOnline}); this repository is queued`,
            waitingFor: 'capacity',
          });
          await this.store.syncRepositoryStatus(current.repositoryId, 'sleeping');
          continue;
        }
        const decision = await this.resourceDecisionFor(
          this.resourceBlocked.has(current.repositoryId),
        );
        if (!decision.admitted) {
          this.resourceBlocked.add(current.repositoryId);
          await this.store.updateInstance(current.repositoryId, {
            state: 'sleeping',
            desiredState: 'online',
            reasonCode: decision.state === 'over_budget' ? 'resource_over_budget' : 'resource_wait',
            reasonDetail: decision.reason,
            waitingFor: 'memory',
            resourceState: decision.state,
            resourceDetail: decision.reason,
            resourceCheckedAt: new Date(),
          });
          await this.store.syncRepositoryStatus(current.repositoryId, 'sleeping');
          await this.store.recordResourceSample({
            scope: 'aggregate',
            memoryCurrentBytes: decision.aggregateOk ? decision.currentBytes : null,
            hostMemAvailableBytes: decision.hostAvailableBytes,
            detail: {
              refusedFor: current.repositoryId,
              projectedBytes: decision.projectedBytes,
              estimated: !decision.aggregateOk,
              reason: decision.reason,
            },
          });
          this.logger.info(
            {
              event: 'supervisor.resource_wait',
              repositoryId: current.repositoryId,
              projectedBytes: decision.projectedBytes,
              currentBytes: decision.currentBytes,
              hostAvailableBytes: decision.hostAvailableBytes,
            },
            'new instance is waiting for aggregate memory headroom',
          );
          continue;
        }
        this.resourceBlocked.delete(current.repositoryId);
        await this.spawnInstance(current);
        active = await this.store.onlineInstances();
      }
    });
  }

  private async spawnInstance(instance: InstanceRow): Promise<void> {
    let prepared: PreparedInstance;
    try {
      prepared = await prepareInstance(this.config, this.store, instance.repositoryId);
    } catch (error) {
      await this.failInstance(instance, 'prepare_failed', safeError(error));
      return;
    }
    if (!(await portFree(prepared.dshPort)) || !(await portFree(prepared.bridgePort))) {
      await this.failInstance(
        instance,
        'port_in_use',
        `Port ${prepared.dshPort} or ${prepared.bridgePort} is already in use`,
      );
      return;
    }
    // The upstream state directory uses a proper-lockfile-style lock directory.
    // A SIGKILL can leave it behind and the next start blocks forever with
    // "Lock file is already being held". Both ports are free and the supervisor
    // owns this profile, so the lock cannot belong to a live runtime here.
    const staleLock = prepared.stateDir
      ? prepared.stateDir + '.lock'
      : join(this.config.dshHome, 'state', `${prepared.profile}.lock`);
    if (pathExists(staleLock)) {
      rmSync(staleLock, { recursive: true, force: true });
      this.logger.info(
        {
          event: 'supervisor.stale_lock_removed',
          repositoryId: instance.repositoryId,
          profile: prepared.profile,
        },
        'removed a stale runtime lock before start',
      );
    }

    const env = instanceProcessEnvironment(prepared, this.config, baseEnvironment());
    let logFd: number;
    try {
      const logPath = instanceLogPath(this.config, prepared.profile);
      logFd = openSync(logPath, 'a', 0o600);
      chmodSync(logPath, 0o600);
    } catch (error) {
      await this.failInstance(instance, 'start_failed', safeError(error));
      return;
    }
    const cgroup = ensureCgroup(`${prepared.profile}-${Date.now()}`);
    if (!cgroup) {
      closeSync(logFd);
      await this.failInstance(
        instance,
        'cgroup_unavailable',
        'The per-instance cgroup could not be created; refusing to start outside the enforced boundary',
      );
      return;
    }
    const applied = applyInstanceMemoryLimit(cgroup, limitsFromConfig(this.config));
    if (!applied.ok) {
      removeCgroup(cgroup);
      closeSync(logFd);
      await this.failInstance(
        instance,
        'memory_limit_unavailable',
        'The per-instance memory limit could not be applied; refusing to start an unmetered runtime',
      );
      return;
    }
    let child;
    let exitedBeforeRelease = false;
    try {
      const dshArgs = ['--profile', prepared.profile, '--no-open'];
      const identityPrefix =
        prepared.runtimeUid !== undefined && prepared.runtimeGid !== undefined
          ? [
              this.config.reviewCheckSetpriv ?? '/usr/bin/setpriv',
              '--reuid',
              String(prepared.runtimeUid),
              '--regid',
              String(prepared.runtimeGid),
              '--init-groups',
              '--no-new-privs',
              '--bounding-set=-all',
              '--inh-caps=-all',
              '--ambient-caps=-all',
              '--',
            ]
          : [];
      // The launcher blocks on fd 3 before exec. The supervisor moves the
      // shell (same PID after exec) into the instance cgroup, then releases
      // it; no user code can fork before the process is inside the boundary.
      // setpriv drops the runtime to its per-repository uid/gid and clears
      // every capability set before dsh is exec'd.
      child = spawn(
        '/bin/sh',
        ['-c', CGROUP_LAUNCHER, 'moyu-cgroup', ...identityPrefix, this.config.dshBin, ...dshArgs],
        {
          cwd: env.HOME,
          env,
          detached: true,
          stdio: ['ignore', logFd, logFd, 'pipe'],
        },
      );
      child.once('exit', () => {
        exitedBeforeRelease = true;
      });
      child.once('error', (error) => {
        this.handles.delete(instance.repositoryId);
        this.generation += 1;
        void this.withLock(async () => {
          try {
            const row = await this.store.getInstance(instance.repositoryId);
            if (row && ['starting', 'online', 'sleeping'].includes(row.state) && !this.stopped) {
              await this.failInstance(row, 'start_failed', safeError(error));
            }
          } catch (failure) {
            this.logger.error(
              {
                event: 'supervisor.spawn_error_handler_failed',
                repositoryId: instance.repositoryId,
                error: safeError(failure),
              },
              'could not record a spawn error',
            );
          }
        });
      });
      child.unref();
    } catch (error) {
      closeSync(logFd);
      await this.failInstance(instance, 'start_failed', safeError(error));
      return;
    }
    closeSync(logFd);
    const pid = child.pid;
    if (!pid) {
      removeCgroup(cgroup);
      await this.failInstance(instance, 'start_failed', 'spawn returned no pid');
      return;
    }
    if (!movePidToCgroup(cgroup, pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
      removeCgroup(cgroup);
      await this.failInstance(
        instance,
        'cgroup_unavailable',
        'The runtime process could not be moved into its metered cgroup; refusing to run it unmetered',
      );
      return;
    }
    const release = child.stdio[3];
    if (!release || !('write' in release)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
      removeCgroup(cgroup);
      await this.failInstance(
        instance,
        'cgroup_unavailable',
        'The runtime cgroup release pipe is unavailable',
      );
      return;
    }
    // A dead child closes the pipe before the release; writing then emits
    // EPIPE asynchronously. Record one start failure and never let it surface
    // as an unhandled 'error' that terminates the supervisor.
    release.once('error', (error) => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
      void this.withLock(async () => {
        const row = await this.store.getInstance(instance.repositoryId).catch(() => null);
        if (row && ['starting', 'online'].includes(row.state)) {
          await this.failInstance(
            row,
            'start_failed',
            `cgroup release pipe failed: ${safeError(error)}`,
          );
        }
      });
    });
    release.end('go\n');
    const generation = ++this.generation;
    this.handles.set(instance.repositoryId, { pid, generation });
    await this.store.updateInstance(instance.repositoryId, {
      state: 'starting',
      desiredState: 'online',
      pid,
      port: prepared.dshPort,
      bridgePort: prepared.bridgePort,
      profile: prepared.profile,
      ownership: ownershipPayload(pid, pid, collectOwnership(pid).members, cgroup),
      reasonCode: 'starting',
      reasonDetail: null,
      waitingFor: null,
      wakeRequestedAt: null,
      lastStartedAt: new Date(),
      attemptCount: instance.attemptCount + 1,
      errorCode: null,
      errorDetail: null,
    });
    await this.store.syncRepositoryStatus(instance.repositoryId, 'starting');
    if (exitedBeforeRelease) {
      this.handles.delete(instance.repositoryId);
      removeCgroup(cgroup);
      await this.failInstance(
        instance,
        'start_failed',
        'The runtime exited before the cgroup release',
      );
      return;
    }
    child.once('exit', () => {
      const handle = this.handles.get(instance.repositoryId);
      if (!handle || handle.generation !== generation) return;
      this.handles.delete(instance.repositoryId);
      void this.withLock(async () => {
        const row = await this.store.getInstance(instance.repositoryId);
        if (!row || !['starting', 'online'].includes(row.state)) return;
        const oom = cgroupOomKilled(storedOwnership(row).cgroup);
        await this.failInstance(
          row,
          oom ? 'oom_killed' : 'instance_lost',
          oom
            ? 'The instance cgroup recorded an OOM kill; the runtime process exited'
            : 'The runtime process exited unexpectedly',
        );
      });
    });
    this.logger.info(
      {
        event: 'supervisor.instance_spawned',
        repositoryId: instance.repositoryId,
        pid,
        profile: prepared.profile,
        dshPort: prepared.dshPort,
        bridgePort: prepared.bridgePort,
      },
      'repository runtime spawned',
    );
    void this.settleStart(instance.repositoryId, generation, prepared).catch((error) => {
      this.logger.error(
        {
          event: 'supervisor.start_settle_failed',
          repositoryId: instance.repositoryId,
          error: safeError(error),
        },
        'startup verification failed after the supervisor stopped or lost its pool',
      );
    });
  }

  /** Reads the measured aggregate and decides whether one more instance fits. */
  private async resourceDecisionFor(blockedBefore: boolean): Promise<AdmissionDecision> {
    const limits = limitsFromConfig(this.config);
    const rows = await this.store.listInstances();
    const instanceCgroups = rows
      .filter((row) => ['starting', 'online', 'stopping'].includes(row.state))
      .map((row) => storedOwnership(row).cgroup);
    const estimateBytes = Math.min(
      limits.instanceMaxBytes,
      Math.ceil(limits.targetBytes / Math.max(1, this.config.maxOnline)),
    );
    const host = readHostMemory();
    const aggregate = aggregateMemory({
      instanceCgroups,
      instanceEstimateBytes: estimateBytes,
      ...(this.config.platformCgroup ? { platformCgroup: this.config.platformCgroup } : {}),
      ...(this.config.postgresCgroup ? { postgresCgroup: this.config.postgresCgroup } : {}),
      ...(this.config.aggregateCgroup ? { aggregateCgroup: this.config.aggregateCgroup } : {}),
    });
    const pressure = pressureAvg10(
      readMemorySample(this.config.platformCgroup ?? selfCgroupPath()),
    );
    return assessAdmission({
      limits,
      aggregate,
      host,
      estimateBytes,
      pressureAvg10: pressure,
      blockedBefore,
    });
  }

  /** Persists real cgroup/host memory samples; never an estimate as a measurement. */
  private async sampleResources(rows: InstanceRow[]): Promise<void> {
    const now = Date.now();
    if (now - this.lastResourceSampleAt < this.config.resourceSampleIntervalMs) return;
    this.lastResourceSampleAt = now;
    const limits = limitsFromConfig(this.config);
    const host = readHostMemory();
    const activeRows = rows.filter((row) => ['starting', 'online', 'stopping'].includes(row.state));
    const instanceCgroups = activeRows.map((row) => storedOwnership(row).cgroup);
    const estimateBytes = Math.min(
      limits.instanceMaxBytes,
      Math.ceil(limits.targetBytes / Math.max(1, this.config.maxOnline)),
    );
    const aggregate = aggregateMemory({
      instanceCgroups,
      instanceEstimateBytes: estimateBytes,
      ...(this.config.platformCgroup ? { platformCgroup: this.config.platformCgroup } : {}),
      ...(this.config.postgresCgroup ? { postgresCgroup: this.config.postgresCgroup } : {}),
      ...(this.config.aggregateCgroup ? { aggregateCgroup: this.config.aggregateCgroup } : {}),
    });
    const pressureSample = readMemorySample(this.config.platformCgroup ?? selfCgroupPath());
    const pressure = pressureAvg10(pressureSample);
    await this.store.recordResourceSample({
      scope: 'host',
      memoryCurrentBytes: Math.max(0, host.totalBytes - host.availableBytes),
      hostMemAvailableBytes: host.availableBytes,
      detail: {
        memTotalBytes: host.totalBytes,
        swapTotalBytes: host.swapTotalBytes,
        swapFreeBytes: host.swapFreeBytes,
      },
    });
    await this.store.recordResourceSample({
      scope: 'aggregate',
      memoryCurrentBytes: aggregate.ok ? aggregate.currentBytes : null,
      hostMemAvailableBytes: host.availableBytes,
      pressure: {},
      detail: {
        estimatedInstanceBytes: aggregate.ok ? 0 : aggregate.instanceBytes,
        instanceBytes: aggregate.instanceBytes,
        platformBytes: aggregate.platformBytes,
        databaseBytes: aggregate.databaseBytes,
        supervisorBytes: aggregate.supervisorBytes,
        unknownCgroups: aggregate.unknownCgroups.length,
        measured: aggregate.ok,
        aggregateCurrentBytes: aggregate.aggregateCurrentBytes,
        aggregateLimitBytes: aggregate.aggregateLimitBytes,
        targetBytes: limits.targetBytes,
        budgetBytes: limits.budgetBytes,
        hardLimitBytes: limits.hardLimitBytes,
        pressureAvg10: pressure,
        ok: aggregate.ok,
      },
    });
    for (const row of activeRows) {
      const cgroup = storedOwnership(row).cgroup;
      const sample = readMemorySample(cgroup);
      const state = sample.ok ? (aggregate.ok ? 'ok' : 'unknown') : 'unknown';
      await this.store.updateInstance(row.repositoryId, {
        memoryCurrentBytes: sample.currentBytes,
        memoryPeakBytes: sample.peakBytes,
        memoryLimitBytes: sample.limitBytes,
        memoryEvents: sample.events,
        resourceState: row.resourceState === 'oom' ? 'oom' : state,
        resourceDetail: sample.error,
        resourceCheckedAt: new Date(),
      });
      await this.store.recordResourceSample({
        scope: 'instance',
        repositoryId: row.repositoryId,
        memoryCurrentBytes: sample.currentBytes,
        memoryPeakBytes: sample.peakBytes,
        memoryLimitBytes: sample.limitBytes,
        memoryEvents: sample.events,
        oomKillCount: sample.oomKillCount,
        hostMemAvailableBytes: host.availableBytes,
        pressure: sample.pressure,
        detail: { cgroup: Boolean(cgroup), state: row.state },
      });
    }
  }

  /**
   * Marker for the one-time default seed of an instance profile. It lives under
   * the supervisor's own instance directory, next to the runtime credentials, so
   * it never enters the worktree and follows the profile across restarts.
   */
  private profileSeededPath(profile: string): string {
    return join(this.config.instanceEnvDir, `${profile}.profile-seeded.json`);
  }

  private async settleStart(
    repositoryId: string,
    generation: number,
    prepared: PreparedInstance,
  ): Promise<void> {
    const ownerId = await this.store.firstOwnerId();
    const model = modelParts(this.config.executorModel);
    const prepare = buildInstancePrepareCommand({
      fullName: prepared.repository.fullName,
      githubAccount: this.config.githubAccount,
      githubCommitEmail: this.config.githubCommitEmail,
      cacheDir: gitCachePath(this.config.worktreeRoot, prepared.profile),
    });
    const worktreeDir = join(this.config.worktreeRoot, prepared.profile);
    // The worktree root is group-shared with the review check identity. A fresh
    // profile directory must inherit that boundary too; 0700 here made checks
    // fail before the first command even though the root is 2775.
    mkdirSync(worktreeDir, { recursive: true, mode: 0o2770 });
    const worktreeGid = prepared.checkGid ?? this.config.reviewCheckGid;
    if (worktreeGid !== undefined) {
      try {
        chownSync(worktreeDir, prepared.runtimeUid ?? -1, worktreeGid);
      } catch {
        // If the supervisor cannot hand the directory to the runtime/check
        // identity, the check refuses the run instead of silently using its
        // own uid.
      }
    }
    try {
      chmodSync(worktreeDir, 0o2770);
    } catch {
      // Best effort on filesystems without group/ACL support; the check still
      // fails closed when it cannot traverse.
    }
    try {
      if (this.stopped) return;
      await waitForPanel(
        prepared.dshPort,
        this.config.startTimeoutMs,
        prepared.stateDir ?? join(this.config.dshHome, 'state', prepared.profile),
      );
      const deadline = Date.now() + this.config.startTimeoutMs;
      while (Date.now() < deadline && !(await portOpen(prepared.bridgePort))) {
        await delay(500);
      }
      if (!(await portOpen(prepared.bridgePort))) {
        throw new Error('The runtime Bridge port did not open');
      }
      if (!ownerId) throw new Error('No owner is registered for the instance policy');
      // First-run defaults are written once per instance; every later start only
      // re-asserts the platform invariants so owner edits survive sleep/wake/restart.
      // Marker existence alone cannot distinguish a fresh profile from an old
      // profile created before the marker existed. Only a profile directory the
      // supervisor just copied from the template gets first-run defaults; an
      // existing profile keeps every value the runtime already reports.
      const seedDefaults =
        prepared.profileCreated && !pathExists(this.profileSeededPath(prepared.profile));
      await configureProfile({
        port: prepared.dshPort,
        repository: prepared.repository.fullName,
        ownerId,
        githubAllowedUsers: this.config.githubAllowedUsers,
        githubCli: this.config.githubCli,
        model: {
          ...model,
          ...(this.config.executorReasoningEffort
            ? { reasoningEffort: this.config.executorReasoningEffort }
            : {}),
        },
        worktreeDir,
        prepare,
        timeoutMs: this.config.startTimeoutMs,
        seedDefaults,
      });
      if (seedDefaults) {
        mkdirSync(dirname(this.profileSeededPath(prepared.profile)), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(
          this.profileSeededPath(prepared.profile),
          JSON.stringify({
            repositoryId,
            profile: prepared.profile,
            seededAt: new Date().toISOString(),
          }),
          { mode: 0o600 },
        );
      }
      if (this.stopped) return;
      const handle = this.handles.get(repositoryId);
      if (!handle || handle.generation !== generation) return;
      const row = await this.store.getInstance(repositoryId);
      if (!row || row.desiredState !== 'online') {
        if (row) await this.stopInstance(row, 'idle', 'idle');
        return;
      }
      const onlineAt = new Date();
      await this.store.updateInstance(repositoryId, {
        state: 'online',
        desiredState: 'online',
        reasonCode: 'listening',
        reasonDetail: null,
        waitingFor: null,
        lastHealthAt: onlineAt,
        lastOnlineAt: onlineAt,
        errorCode: null,
        errorDetail: null,
      });
      await this.store.syncRepositoryStatus(repositoryId, 'online');
      this.logger.info(
        {
          event: 'supervisor.instance_online',
          repositoryId,
          ...(row.activationRequestedAt
            ? { activationDurationMs: onlineAt.getTime() - row.activationRequestedAt.getTime() }
            : {}),
        },
        'repository runtime is online',
      );
    } catch (error) {
      if (this.stopped) return;
      const handle = this.handles.get(repositoryId);
      if (!handle || handle.generation !== generation) return;
      this.logger.error(
        { event: 'supervisor.start_verify_failed', repositoryId, error: safeError(error) },
        'runtime startup verification or profile configuration failed',
      );
      this.handles.delete(repositoryId);
      const row = (await this.store.getInstance(repositoryId)) ?? null;
      if (!row) return;
      const stopped = await this.stopInstance(row, 'start_failed', 'process_exit');
      if (stopped) {
        await this.failInstance(
          (await this.store.getInstance(repositoryId)) ?? row,
          'start_failed',
          safeError(error),
        );
      }
    }
  }

  private async failInstance(instance: InstanceRow, code: string, detail: string): Promise<void> {
    const snapshot = collectOwnership(instance.pid ?? 0, storedOwnership(instance));
    if (snapshot.members.length > 0 || snapshot.unknown) {
      await this.stopInstance(instance, 'failure_cleanup', 'process_exit');
      return;
    }
    const exhausted =
      [
        'start_failed',
        'oom_killed',
        'instance_lost',
        'cgroup_unavailable',
        'memory_limit_unavailable',
      ].includes(code) && instance.attemptCount >= this.config.maxStartAttempts;
    await this.store.updateInstance(instance.repositoryId, {
      state: 'fault',
      desiredState: 'sleeping',
      pid: null,
      ownership: {},
      reasonCode: exhausted ? 'retry_exhausted' : code,
      reasonDetail: exhausted
        ? `Stopped after ${instance.attemptCount} failed start attempts; an explicit retry is required. ${detail}`.slice(
            0,
            500,
          )
        : detail,
      waitingFor: exhausted ? 'owner' : null,
      errorCode: exhausted ? 'retry_exhausted' : code,
      errorDetail: detail,
      resourceState: code === 'oom_killed' ? 'oom' : 'ok',
      resourceDetail: code === 'oom_killed' ? detail : null,
      resourceCheckedAt: new Date(),
      lastStoppedAt: null,
      ...(exhausted ? { wakeRequestedAt: null, attemptCount: 0 } : {}),
    });
    await this.store.syncRepositoryStatus(instance.repositoryId, 'fault');
    this.logger.error(
      { event: 'supervisor.fault', repositoryId: instance.repositoryId, code, detail },
      'repository runtime failed',
    );
  }

  private async markSleeping(instance: InstanceRow, reason: string): Promise<void> {
    const current = (await this.store.getInstance(instance.repositoryId)) ?? instance;
    // A reply/start wake may arrive while the process is being stopped. That
    // intent is newer than the stop and must survive it; otherwise an accepted
    // wake is silently cancelled by the final sleeping write.
    const pendingWake = current.desiredState === 'online' && current.wakeRequestedAt !== null;
    await this.store.updateInstance(instance.repositoryId, {
      state: 'sleeping',
      desiredState: pendingWake ? 'online' : 'sleeping',
      pid: null,
      ownership: {},
      reasonCode: pendingWake
        ? 'wake_queued'
        : reason === 'evicted_for_capacity'
          ? 'evicted'
          : 'sleeping',
      reasonDetail: pendingWake
        ? 'The runtime stopped after a newer wake request arrived; starting again'
        : reason === 'evicted_for_capacity'
          ? 'Stopped to free an online slot for a waiting repository'
          : null,
      waitingFor: pendingWake ? 'capacity' : null,
      errorCode: null,
      errorDetail: null,
      lastStoppedAt: new Date(),
    });
    await this.store.syncRepositoryStatus(instance.repositoryId, 'sleeping');
    this.logger.info(
      {
        event: 'supervisor.instance_sleeping',
        repositoryId: instance.repositoryId,
        reason,
        pendingWake,
      },
      'repository runtime stopped',
    );
  }

  /**
   * Stops the runtime and every recorded descendant. It returns true only when
   * no tracked process remains and the Bridge port is closed. A timeout leaves
   * the row in `stopping` with the surviving ownership snapshot, so capacity is
   * not released and the owner can retry the stop.
   */
  private async stopInstance(
    instance: InstanceRow,
    reason: string,
    waitingFor: string | null,
  ): Promise<boolean> {
    const stored = storedOwnership(instance);
    const pid = instance.pid ?? stored.rootPid ?? 0;
    const snapshot = collectOwnership(pid, stored);
    const pgid = snapshot.pgid ?? stored.pgid ?? (pid > 1 ? pid : null);
    const beforeStop = (await this.store.getInstance(instance.repositoryId)) ?? instance;
    this.handles.delete(instance.repositoryId);
    this.generation += 1;
    await this.store.updateInstance(instance.repositoryId, {
      state: 'stopping',
      // A wake accepted before this stop (including the tick retry of a stop
      // with live members) is an owner intent, not a stop request. Keep it
      // until the process tree is actually gone; markSleeping decides later.
      desiredState: beforeStop.desiredState,
      pid: instance.pid,
      ownership: {
        ...stored,
        rootPid: instance.pid,
        pgid,
        members: [...(stored.members ?? []), ...snapshot.members],
      },
      reasonCode: 'stopping',
      reasonDetail: null,
      waitingFor,
      errorCode: null,
      errorDetail: null,
    });
    await this.store.syncRepositoryStatus(instance.repositoryId, 'stopping');
    const result = await stopProcessTree(pid, this.config.stopTimeoutMs, {
      ...stored,
      rootPid: instance.pid,
      pgid,
      members: [...(stored.members ?? []), ...snapshot.members],
    });
    const portClosed = instance.bridgePort
      ? await waitForPortClosed(instance.bridgePort, 5000)
      : true;
    if (result.stopped && portClosed) {
      await this.markSleeping(instance, reason);
      return true;
    }
    const remaining = result.remaining;
    const detail = result.stopped
      ? `The Bridge port ${instance.bridgePort ?? '(none)'} remained open after the process tree exited`
      : result.unknown
        ? 'The owned process tree exited, but the saved process group still has unverified members'
        : `Stopping is incomplete: ${remaining.length} process(es) still alive after the timeout`;
    const current = (await this.store.getInstance(instance.repositoryId)) ?? instance;
    const pendingWake = current.desiredState === 'online' && current.wakeRequestedAt !== null;
    await this.store.updateInstance(instance.repositoryId, {
      state: 'stopping',
      desiredState: pendingWake ? 'online' : 'sleeping',
      pid: instance.pid,
      ownership: {
        ...stored,
        rootPid: instance.pid,
        pgid: result.pgid ?? pgid,
        members: [...(stored.members ?? []), ...remaining],
      },
      reasonCode: 'stop_failed',
      reasonDetail: detail,
      waitingFor: 'process_exit',
      errorCode: 'stop_failed',
      errorDetail: detail,
      lastStoppedAt: null,
    });
    await this.store.syncRepositoryStatus(instance.repositoryId, 'stopping');
    this.logger.error(
      {
        event: 'supervisor.stop_failed',
        repositoryId: instance.repositoryId,
        remaining: remaining.length,
        portClosed,
      },
      'runtime stop did not prove every process exited; capacity remains occupied',
    );
    return false;
  }
}
