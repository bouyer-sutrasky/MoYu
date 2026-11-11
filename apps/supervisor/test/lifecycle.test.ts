import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SupervisorConfig } from '../src/config';
import type { SupervisorLogger } from '../src/logger';
import { InstanceManager } from '../src/manager';
import {
  CGROUP_ROOT,
  cgroupBoundary,
  ensureCgroup,
  identifyProcess,
  movePidToCgroup,
  removeCgroup,
  stopProcessTree,
} from '../src/process';
import type { InstanceRow, SupervisorStore } from '../src/store';

interface FakeStore {
  row: InstanceRow;
  updates: Array<Record<string, unknown>>;
  getInstance(): Promise<InstanceRow>;
  listInstances(): Promise<InstanceRow[]>;
  updateInstance(_id: string, patch: Record<string, unknown>): Promise<void>;
  syncRepositoryStatus(): Promise<void>;
  recordProgress(): Promise<void>;
}

function baseRow(patch: Partial<InstanceRow> = {}): InstanceRow {
  return {
    repositoryId: 'repo-1',
    fullName: 'Bouyer12/repo-1',
    defaultBranch: 'main',
    state: 'online',
    desiredState: 'online',
    reasonCode: 'listening',
    reasonDetail: null,
    waitingFor: null,
    queuePriority: 0,
    wakeRequestedAt: null,
    lastActivityAt: null,
    lastProgressAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    lastHealthAt: null,
    pid: null,
    port: null,
    bridgePort: null,
    profile: 'probe',
    ownership: {},
    attemptCount: 1,
    errorCode: null,
    errorDetail: null,
    memoryCurrentBytes: null,
    memoryPeakBytes: null,
    memoryLimitBytes: null,
    memoryEvents: {},
    resourceState: 'ok',
    resourceDetail: null,
    resourceCheckedAt: null,
    updatedAt: new Date(0),
    ...patch,
  };
}

function fakeStore(row: InstanceRow): FakeStore {
  const store: FakeStore = {
    row,
    updates: [],
    getInstance: async () => store.row,
    listInstances: async () => [store.row],
    updateInstance: async (_id, patch) => {
      store.updates.push(patch);
      store.row = { ...store.row, ...patch } as InstanceRow;
    },
    syncRepositoryStatus: async () => undefined,
    recordProgress: async () => undefined,
  };
  return store;
}

const config = {
  host: '127.0.0.1',
  port: 4490,
  token: 'test-token',
  databaseUrl: 'postgres://user@127.0.0.1/db',
  instancesConfigPath: '/tmp/instances.json',
  pinned: new Map(),
  portRange: { start: 3401, end: 3499 },
  dshBin: '/usr/bin/dsh',
  dshHome: '/tmp',
  platformUrl: 'http://127.0.0.1:4300',
  credentialsDir: '/tmp',
  instanceEnvDir: '/tmp',
  logDir: '/tmp',
  worktreeRoot: '/tmp',
  profilePrefix: 'm5',
  maxOnline: 2,
  memoryTargetMb: 4096,
  memoryBudgetMb: 6144,
  memoryHardLimitMb: 8192,
  memoryReserveMb: 1024,
  memoryHysteresisMb: 256,
  instanceMemoryMaxMb: 3072,
  instanceMemoryHighMb: 2560,
  memoryPressureAvg10: 10,
  resourceSampleIntervalMs: 15_000,
  maxStartAttempts: 3,
  tickIntervalMs: 2000,
  startTimeoutMs: 120_000,
  stopTimeoutMs: 3000,
  executorModel: 'commandcode/deepseek-v4.1-flash',
  githubCli: '/usr/bin/gh',
  githubAllowedUsers: ['sutrasky'],
  githubAccount: 'Bouyer12',
  githubCommitEmail: 'agent@example.com',
} as unknown as SupervisorConfig;

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => logger,
} as unknown as SupervisorLogger;

const spawned: number[] = [];

/** A cgroup root fresh for this test, so no other state is touched. */
function freshRoot(label: string): string | null {
  const setup = ensureCgroup(label);
  return setup.ok ? setup.path : null;
}

function spawnPlain(): { pid: number } {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  if (!child.pid) throw new Error('no pid');
  child.unref();
  spawned.push(child.pid);
  return { pid: child.pid };
}

function spawnIn(cgroup: string): { pid: number } {
  const { pid } = spawnPlain();
  if (!movePidToCgroup(cgroup, pid)) throw new Error('could not move the process');
  return { pid };
}

async function listenOnRandomPort(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { port: address.port, server };
}

afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    await stopProcessTree(pid, 3000);
  }
});

/**
 * The restart reconcile is the place where an unprovable boundary used to wedge
 * an instance forever. These tests drive the real manager against the real
 * process table and a recording store.
 */
describe('restart ownership convergence', () => {
  it('keeps a serving adopted runtime online instead of reporting ownership_unverified', async () => {
    const cgroup = freshRoot(`lifecycle-adopt-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    try {
      const { pid } = spawnIn(cgroup);
      const { port, server } = await listenOnRandomPort();
      try {
        const row = baseRow({
          pid,
          port: port,
          bridgePort: port,
          ownership: {
            rootPid: pid,
            pgid: pid,
            cgroup,
            cgroupInode: statSync(cgroup).ino,
            adoptedUnproven: true,
            // Verified identity (PID + start time) whose history is unproven.
            members: [identifyProcess(pid)],
          },
        });
        const store = fakeStore(row);
        const manager = new InstanceManager(config, store as unknown as SupervisorStore, logger);
        await (
          manager as unknown as { reconcileRestart(row: InstanceRow): Promise<void> }
        ).reconcileRestart(row);
        expect(store.row.state).toBe('online');
        expect(store.row.reasonCode).toBe('listening');
        expect(store.row.reasonDetail).toContain('adopted');
        expect(store.row.waitingFor).toBeNull();
        // The boundary object is recorded, so the next restart can verify it.
        expect(store.row.ownership.cgroup).toBe(cgroup);
        expect(store.row.ownership.cgroupInode).toBe(statSync(cgroup).ino);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      removeCgroup(cgroup);
    }
  });

  it('re-binds a live runtime whose boundary object disappeared', async () => {
    // Without a writable cgroup v2 hierarchy the re-bind cannot happen; the
    // isolated acceptance host proves it (scripts/m5b/cgroup-lifecycle-probe.sh).
    const host = ensureCgroup(`lifecycle-host-${process.pid}-${Date.now()}`);
    if (!host.ok || !host.path) return;
    removeCgroup(host.path);
    const gone = join(CGROUP_ROOT, `missing-${process.pid}-${Date.now()}`);
    const { pid } = spawnPlain();
    // A live runtime reported without any usable boundary: the restart must give
    // it a new, readable cgroup instead of leaving it unproven forever.
    const row = baseRow({
      pid,
      ownership: {
        rootPid: pid,
        pgid: pid,
        cgroup: gone,
        cgroupInode: 1,
        members: [identifyProcess(pid)],
      },
    });
    const store = fakeStore(row);
    const manager = new InstanceManager(config, store as unknown as SupervisorStore, logger);
    await (
      manager as unknown as { reconcileRestart(row: InstanceRow): Promise<void> }
    ).reconcileRestart(row);
    const adopted = store.row.ownership;
    expect(adopted.adoptedUnproven).toBe(true);
    expect(typeof adopted.cgroup).toBe('string');
    const boundary = cgroupBoundary(adopted.cgroup as string);
    expect(boundary.state).toBe('ok');
    expect(boundary.inode).toBe(adopted.cgroupInode);
    expect(store.row.state).toBe('online');
    removeCgroup(adopted.cgroup as string);
  });

  it('releases a row whose boundary is empty instead of leaving it stopping', async () => {
    const cgroup = freshRoot(`lifecycle-empty-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    try {
      const row = baseRow({
        pid: 4000001,
        state: 'online',
        desiredState: 'online',
        ownership: {
          rootPid: 4000001,
          pgid: 4000001,
          cgroup,
          cgroupInode: statSync(cgroup).ino,
          members: [{ pid: 4000001, startTime: '0', pgid: 4000001, sid: 4000001, command: 'gone' }],
        },
      });
      const store = fakeStore(row);
      const manager = new InstanceManager(config, store as unknown as SupervisorStore, logger);
      await (
        manager as unknown as { reconcileRestart(row: InstanceRow): Promise<void> }
      ).reconcileRestart(row);
      // The runtime is gone and its boundary is recursively empty: this is a
      // proven stop, so the slot is released instead of staying `stopping`.
      expect(store.row.state).toBe('fault');
      expect(store.row.pid).toBeNull();
      expect(store.row.reasonCode).toBe('instance_lost');
      expect(store.row.ownership).toEqual({});
    } finally {
      removeCgroup(cgroup);
    }
  });
});
