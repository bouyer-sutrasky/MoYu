import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import type { SupervisorConfig } from './config';
import type { SupervisorLogger } from './logger';
import { configureProfile, waitForPanel } from './panel';
import {
  pidAlive,
  retainedDescendants,
  portFree,
  stopProcessTree,
  waitForPortClosed,
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
        if (row.state === 'online' && row.pid && pidAlive(row.pid)) {
          // Adopt a process that survived a supervisor restart. The Bridge is
          // the authority for an online instance; a live process with a silent
          // Bridge stays online and is reported as unhealthy, never killed.
          const bridgeUp = row.bridgePort ? await portOpen(row.bridgePort) : false;
          await this.store.updateInstance(row.repositoryId, {
            lastHealthAt: bridgeUp ? new Date() : row.lastHealthAt,
            reasonCode: bridgeUp ? 'listening' : 'bridge_unreachable',
            reasonDetail: bridgeUp
              ? null
              : 'The runtime process survived the supervisor restart but its Bridge did not answer the first health check',
            waitingFor: bridgeUp ? null : 'runtime',
          });
          continue;
        }
        if (row.state === 'starting') {
          const bridgeUp = row.bridgePort ? await portOpen(row.bridgePort) : false;
          if (row.pid && pidAlive(row.pid) && bridgeUp) {
            await this.store.updateInstance(row.repositoryId, {
              state: 'online',
              lastHealthAt: new Date(),
              reasonCode: 'listening',
              reasonDetail: null,
              waitingFor: null,
            });
            await this.store.syncRepositoryStatus(row.repositoryId, 'online');
            continue;
          }
          // A half-started orphan is stopped and reported; it must not keep a
          // port or be silently counted as online.
          if (row.pid && pidAlive(row.pid)) {
            await stopProcessTree(row.pid, this.config.stopTimeoutMs);
            if (row.bridgePort) await waitForPortClosed(row.bridgePort, 5000);
          }
          await this.store.updateInstance(row.repositoryId, {
            state: 'fault',
            desiredState: 'sleeping',
            pid: null,
            reasonCode: 'instance_lost',
            reasonDetail: 'The supervisor restarted while this runtime was still starting',
            waitingFor: null,
            errorCode: 'instance_lost',
            errorDetail: 'startup interrupted by supervisor restart',
          });
          await this.store.syncRepositoryStatus(row.repositoryId, 'fault');
        } else if (row.state === 'online') {
          await this.store.updateInstance(row.repositoryId, {
            state: 'fault',
            desiredState: 'sleeping',
            pid: null,
            reasonCode: 'instance_lost',
            reasonDetail:
              'The supervisor restarted and could not confirm the previous runtime process',
            waitingFor: null,
            errorCode: 'instance_lost',
            errorDetail: 'runtime process missing after supervisor restart',
          });
          await this.store.syncRepositoryStatus(row.repositoryId, 'fault');
        } else if (row.state === 'stopping') {
          if (row.pid && pidAlive(row.pid)) {
            await stopProcessTree(row.pid, this.config.stopTimeoutMs);
            if (row.bridgePort) await waitForPortClosed(row.bridgePort, 5000);
          }
          await this.store.updateInstance(row.repositoryId, {
            state: 'sleeping',
            desiredState: 'sleeping',
            pid: null,
            reasonCode: 'sleeping',
            reasonDetail: null,
            waitingFor: null,
            lastStoppedAt: new Date(),
          });
          await this.store.syncRepositoryStatus(row.repositoryId, 'sleeping');
        }
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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // The supervisor does not kill running runtime processes on its own exit:
    // they are detached and the next supervisor adopts them. Explicit sleep is
    // the only path that stops a runtime.
  }

  async prepare(repositoryId: string): Promise<InstanceRow> {
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
        instance.state === 'sleeping';
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
        wakeRequestedAt: now,
        queuePriority: input.priority,
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
      if (instance.state === 'fault' || instance.state === 'stopping') {
        await this.store.updateInstance(repositoryId, {
          desiredState: 'sleeping',
          ...(instance.state === 'fault'
            ? { reasonCode: 'fault', reasonDetail: instance.reasonDetail, waitingFor: null }
            : {}),
        });
        return {
          accepted: true,
          duplicate: instance.state === 'stopping',
          instance: (await this.store.getInstance(repositoryId)) ?? instance,
        };
      }
      const gate = await this.store.taskGate(repositoryId);
      const background = instance.pid ? retainedDescendants(instance.pid) : [];
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
      await this.stopInstance(instance, manual ? 'manual' : 'idle', 'idle');
      return {
        accepted: true,
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
        if (!row.pid || !['starting', 'online', 'stopping'].includes(row.state)) continue;
        const alive = pidAlive(row.pid);
        const bridgeUp = row.bridgePort ? await portOpen(row.bridgePort) : false;
        this.logger.debug(
          {
            event: 'supervisor.health_check',
            repositoryId: row.repositoryId,
            pid: row.pid,
            port: row.port,
            bridgePort: row.bridgePort,
            bridgeUp,
            alive,
          },
          'checked runtime health',
        );
        if (!alive) {
          if (row.state === 'stopping') {
            await this.store.updateInstance(row.repositoryId, {
              state: 'sleeping',
              desiredState: 'sleeping',
              pid: null,
              reasonCode: 'sleeping',
              reasonDetail: null,
              waitingFor: null,
              lastStoppedAt: new Date(),
            });
            await this.store.syncRepositoryStatus(row.repositoryId, 'sleeping');
          } else {
            await this.failInstance(
              row,
              'instance_lost',
              'The runtime process exited unexpectedly',
            );
          }
          continue;
        }
        if (row.state === 'online' && !bridgeUp) {
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
        } else if (bridgeUp) {
          await this.store.updateInstance(row.repositoryId, {
            lastHealthAt: new Date(),
            ...(row.reasonCode === 'bridge_unreachable'
              ? { reasonCode: 'online', reasonDetail: null, waitingFor: null }
              : {}),
          });
        }
        if (row.desiredState === 'sleeping') {
          if (row.state === 'starting') {
            await this.stopInstance(row, 'idle', 'idle');
          } else if (row.state === 'online') {
            const gate = await this.store.taskGate(row.repositoryId);
            const background = retainedDescendants(row.pid);
            if (gate.active === 0 && gate.pendingOperations === 0 && background.length === 0) {
              await this.stopInstance(row, 'idle', 'idle');
            } else {
              await this.store.updateInstance(row.repositoryId, {
                desiredState: 'online',
                reasonCode: 'sleep_refused',
                reasonDetail:
                  gate.active > 0 || gate.pendingOperations > 0
                    ? 'A task or owner command is still active; an explicit sleep waits for it to finish'
                    : 'A retained background process still needs this runtime',
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
            const background = victim.pid ? retainedDescendants(victim.pid) : [];
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
    void this.settleStart(instance.repositoryId, generation, prepared);
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
      const handle = this.handles.get(repositoryId);
      if (!handle || handle.generation !== generation) return;
      this.handles.delete(repositoryId);
      const pid = handle.pid;
      await stopProcessTree(pid, this.config.stopTimeoutMs);
      await waitForPortClosed(prepared.bridgePort, 5000);
      const row = (await this.store.getInstance(repositoryId)) ?? null;
      if (row) await this.failInstance(row, 'start_failed', safeError(error));
    }
  }

  private async failInstance(instance: InstanceRow, code: string, detail: string): Promise<void> {
    await this.store.updateInstance(instance.repositoryId, {
      state: 'fault',
      desiredState: 'sleeping',
      pid: null,
      reasonCode: code,
      reasonDetail: detail,
      waitingFor: null,
      errorCode: code,
      errorDetail: detail,
    });
    await this.store.syncRepositoryStatus(instance.repositoryId, 'fault');
    this.logger.error(
      { event: 'supervisor.fault', repositoryId: instance.repositoryId, code, detail },
      'repository runtime failed',
    );
  }

  private async stopInstance(
    instance: InstanceRow,
    reason: string,
    waitingFor: string | null,
  ): Promise<void> {
    const pid = instance.pid;
    this.handles.delete(instance.repositoryId);
    this.generation += 1;
    await this.store.updateInstance(instance.repositoryId, {
      state: 'stopping',
      desiredState: 'sleeping',
      reasonCode: 'stopping',
      reasonDetail: null,
      waitingFor,
    });
    await this.store.syncRepositoryStatus(instance.repositoryId, 'stopping');
    let stopped = true;
    if (pid) {
      stopped = await stopProcessTree(pid, this.config.stopTimeoutMs);
      if (instance.bridgePort) {
        stopped = (await waitForPortClosed(instance.bridgePort, 5000)) && stopped;
      }
    }
    if (stopped) {
      await this.store.updateInstance(instance.repositoryId, {
        state: 'sleeping',
        desiredState: 'sleeping',
        pid: null,
        reasonCode:
          reason === 'fault' ? 'fault' : reason === 'evicted_for_capacity' ? 'evicted' : 'sleeping',
        reasonDetail:
          reason === 'evicted_for_capacity'
            ? 'Stopped to free an online slot for a waiting repository'
            : null,
        waitingFor: null,
        lastStoppedAt: new Date(),
      });
      await this.store.syncRepositoryStatus(instance.repositoryId, 'sleeping');
      this.logger.info(
        { event: 'supervisor.instance_sleeping', repositoryId: instance.repositoryId, reason },
        'repository runtime stopped',
      );
    } else {
      await this.failInstance(
        instance,
        'stop_failed',
        'The runtime process did not stop within the timeout',
      );
    }
  }
}
