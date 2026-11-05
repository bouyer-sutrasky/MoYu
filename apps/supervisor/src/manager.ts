import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import type { SupervisorConfig } from './config';
import type { SupervisorLogger } from './logger';
import { configureProfile, waitForPanel } from './panel';
import {
  collectOwnership,
  pidAlive,
  portFree,
  retainedDescendants,
  stopProcessTree,
  waitForPortClosed,
  type ProcessIdentity,
  type StoredOwnership,
} from './process';
import { instanceLogPath, parseEnvFile, prepareInstance, type PreparedInstance } from './provision';
import type { InstanceRow, SupervisorStore } from './store';

export interface WakeInput {
  priority: number;
  reason: 'new_task' | 'reply' | 'manual' | 'retry';
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
}

function storedOwnership(row: InstanceRow): StoredOwnership {
  const value = row.ownership ?? {};
  return {
    rootPid: typeof value.rootPid === 'number' ? value.rootPid : row.pid,
    pgid: typeof value.pgid === 'number' ? value.pgid : row.pid,
    members: Array.isArray(value.members) ? (value.members as StoredOwnership['members']) : [],
  };
}

function ownershipPayload(rootPid: number | null, pgid: number | null, members: ProcessIdentity[]) {
  return {
    rootPid,
    pgid,
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

  constructor(
    private readonly config: SupervisorConfig,
    private readonly store: SupervisorStore,
    private readonly logger: SupervisorLogger,
  ) {}

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
      join(this.config.dshHome, 'profiles'),
      join(this.config.dshHome, 'state'),
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    await this.withLock(async () => {
      const rows = await this.store.listInstances();
      for (const row of rows) {
        await this.reconcileRestart(row);
      }
    });
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
  private async reconcileRestart(row: InstanceRow): Promise<void> {
    const stored = storedOwnership(row);
    const snapshot = collectOwnership(row.pid ?? 0, stored);
    const live = snapshot.members;
    const rootAlive = row.pid ? pidAlive(row.pid) : false;

    if (row.state === 'online') {
      if (rootAlive) {
        const bridgeUp = row.bridgePort ? await portOpen(row.bridgePort) : false;
        await this.store.updateInstance(row.repositoryId, {
          lastHealthAt: bridgeUp ? new Date() : row.lastHealthAt,
          ownership: ownershipPayload(row.pid, snapshot.pgid, live),
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
          ownership: ownershipPayload(row.pid, snapshot.pgid, live),
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
      return instance;
    });
  }

  async wake(repositoryId: string, input: WakeInput): Promise<WakeResult> {
    return this.withLock(async () => {
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
        await this.store.updateInstance(repositoryId, {
          desiredState: 'online',
          lastActivityAt: now,
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
      const rows = await this.store.listInstances();
      for (const row of rows) {
        try {
          await this.store.recordProgress(row.repositoryId);
        } catch {
          // Progress is explanatory only; a missing row must not stop scheduling.
        }
        const stored = storedOwnership(row);
        const snapshot = collectOwnership(row.pid ?? 0, stored);
        const live = snapshot.members;
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
              ownership: ownershipPayload(row.pid, snapshot.pgid, live),
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
          ownership: ownershipPayload(row.pid, snapshot.pgid, live),
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
    const staleLock = join(this.config.dshHome, 'state', `${prepared.profile}.lock`);
    if (existsSync(staleLock)) {
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
    const env = {
      ...baseEnvironment(),
      DSH_HOME: this.config.dshHome,
      ...parseEnvFile(prepared.envFile),
    };
    let logFd: number;
    try {
      const logPath = instanceLogPath(this.config, prepared.profile);
      logFd = openSync(logPath, 'a', 0o600);
      chmodSync(logPath, 0o600);
    } catch (error) {
      await this.failInstance(instance, 'start_failed', safeError(error));
      return;
    }
    let child;
    try {
      child = spawn(this.config.dshBin, ['--profile', prepared.profile, '--no-open'], {
        cwd: this.config.dshHome,
        env,
        detached: true,
        stdio: ['ignore', logFd, logFd],
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
      await this.failInstance(instance, 'start_failed', 'spawn returned no pid');
      return;
    }
    const generation = ++this.generation;
    this.handles.set(instance.repositoryId, { pid, generation });
    await this.store.updateInstance(instance.repositoryId, {
      state: 'starting',
      desiredState: 'online',
      pid,
      port: prepared.dshPort,
      bridgePort: prepared.bridgePort,
      profile: prepared.profile,
      ownership: ownershipPayload(pid, pid, collectOwnership(pid).members),
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
    child.once('exit', () => {
      const handle = this.handles.get(instance.repositoryId);
      if (!handle || handle.generation !== generation) return;
      this.handles.delete(instance.repositoryId);
      void this.withLock(async () => {
        const row = await this.store.getInstance(instance.repositoryId);
        if (!row || !['starting', 'online'].includes(row.state)) return;
        await this.failInstance(row, 'instance_lost', 'The runtime process exited unexpectedly');
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

  private async settleStart(
    repositoryId: string,
    generation: number,
    prepared: PreparedInstance,
  ): Promise<void> {
    const ownerId = await this.store.firstOwnerId();
    const model = modelParts(this.config.executorModel);
    const prepare = [
      'git -c safe.directory="*" clone --no-tags',
      `"ssh://git@ssh.github.com:443/${prepared.repository.fullName}.git"`,
      '"$DSH_SUPERAGENT_DIR"',
      '&& git -C "$DSH_SUPERAGENT_DIR" -c advice.detachedHead=false checkout "$DSH_SUPERAGENT_WORKSPACE_BASE_COMMIT"',
      `&& git -C "$DSH_SUPERAGENT_DIR" config user.name "${this.config.githubAccount}"`,
      `&& git -C "$DSH_SUPERAGENT_DIR" config user.email "${this.config.githubCommitEmail}"`,
      '&& git -C "$DSH_SUPERAGENT_DIR" switch -c "agent/$DSH_SUPERAGENT_NAME"',
    ].join(' ');
    const worktreeDir = join(this.config.worktreeRoot, prepared.profile);
    mkdirSync(worktreeDir, { recursive: true, mode: 0o700 });
    try {
      if (this.stopped) return;
      await waitForPanel(
        prepared.dshPort,
        this.config.startTimeoutMs,
        join(this.config.dshHome, 'state', prepared.profile),
      );
      const deadline = Date.now() + this.config.startTimeoutMs;
      while (Date.now() < deadline && !(await portOpen(prepared.bridgePort))) {
        await delay(500);
      }
      if (!(await portOpen(prepared.bridgePort))) {
        throw new Error('The runtime Bridge port did not open');
      }
      if (!ownerId) throw new Error('No owner is registered for the instance policy');
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
      });
      if (this.stopped) return;
      const handle = this.handles.get(repositoryId);
      if (!handle || handle.generation !== generation) return;
      const row = await this.store.getInstance(repositoryId);
      if (!row || row.desiredState !== 'online') {
        if (row) await this.stopInstance(row, 'idle', 'idle');
        return;
      }
      await this.store.updateInstance(repositoryId, {
        state: 'online',
        desiredState: 'online',
        reasonCode: 'listening',
        reasonDetail: null,
        waitingFor: null,
        lastHealthAt: new Date(),
        errorCode: null,
        errorDetail: null,
      });
      await this.store.syncRepositoryStatus(repositoryId, 'online');
      this.logger.info(
        { event: 'supervisor.instance_online', repositoryId },
        'repository runtime is online',
      );
    } catch (error) {
      if (this.stopped) return;
      const handle = this.handles.get(repositoryId);
      if (!handle || handle.generation !== generation) return;
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
    if (snapshot.members.length > 0) {
      await this.stopInstance(instance, 'failure_cleanup', 'process_exit');
      return;
    }
    await this.store.updateInstance(instance.repositoryId, {
      state: 'fault',
      desiredState: 'sleeping',
      pid: null,
      ownership: {},
      reasonCode: code,
      reasonDetail: detail,
      waitingFor: null,
      errorCode: code,
      errorDetail: detail,
      lastStoppedAt: null,
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
    this.handles.delete(instance.repositoryId);
    this.generation += 1;
    await this.store.updateInstance(instance.repositoryId, {
      state: 'stopping',
      desiredState: 'sleeping',
      pid: instance.pid,
      ownership: ownershipPayload(pid > 1 ? pid : null, pgid, snapshot.members),
      reasonCode: 'stopping',
      reasonDetail: null,
      waitingFor,
      errorCode: null,
      errorDetail: null,
    });
    await this.store.syncRepositoryStatus(instance.repositoryId, 'stopping');
    const result = await stopProcessTree(pid, this.config.stopTimeoutMs, {
      rootPid: instance.pid,
      pgid,
      members: snapshot.members,
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
      : `Stopping is incomplete: ${remaining.length} process(es) still alive after the timeout`;
    const current = (await this.store.getInstance(instance.repositoryId)) ?? instance;
    const pendingWake = current.desiredState === 'online' && current.wakeRequestedAt !== null;
    await this.store.updateInstance(instance.repositoryId, {
      state: 'stopping',
      desiredState: pendingWake ? 'online' : 'sleeping',
      pid: instance.pid,
      ownership: ownershipPayload(pid > 1 ? pid : null, result.pgid, remaining),
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
