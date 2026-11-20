import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mergeQueuedWake } from '../src/manager';
import {
  CGROUP_ROOT,
  cgroupBoundary,
  cgroupEmpty,
  cgroupEmptyAt,
  cgroupPids,
  cgroupTree,
  cgroupTreeAt,
  cleanupVerifiedCgroup,
  childPids,
  collectOwnership,
  descendants,
  ensureCgroup,
  movePidToCgroup,
  openCgroupObject,
  ownedByRoot,
  portOwners,
  removeCgroup,
  identifyProcess,
  isTransientPolling,
  pidAlive,
  portFree,
  retainedDescendants,
  retainedIdentities,
  stopProcessTree,
  waitForPortClosed,
} from '../src/process';
import { applyInstanceMemoryLimit, limitsFromConfig } from '../src/resources';

const children: ChildProcess[] = [];

function spawnDetached(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timed out');
}

/**
 * Creates a real per-instance cgroup when the host has a writable cgroup v2
 * hierarchy; GitHub-hosted runners do, the isolated acceptance host proves the
 * full cold-start path (see scripts/m5b/cgroup-lifecycle-probe.sh).
 */
function createCgroup(label: string): string | null {
  const setup = ensureCgroup(label);
  return setup.ok ? setup.path : null;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && pidAlive(child.pid)) {
      await stopProcessTree(child.pid, 3000);
    }
  }
});

describe('supervisor process evidence', () => {
  it('reports a loopback port as free only when nothing listens on it', async () => {
    expect(await portFree(4499)).toBe(true);
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not listen');
    expect(await portFree(address.port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await waitForPortClosed(address.port, 1000)).toBe(true);
  });

  it('lists a real child process and stops its detached process group', async () => {
    const child = spawnDetached('sleep', ['30']);
    if (!child.pid) throw new Error('no pid');
    expect(descendants(process.pid)).toContain(child.pid);
    const result = await stopProcessTree(child.pid, 3000);
    expect(result.stopped).toBe(true);
    expect(pidAlive(child.pid)).toBe(false);
  });

  it('never signals a reused root PID whose start time does not match', async () => {
    const child = spawnDetached('sleep', ['30']);
    if (!child.pid) throw new Error('no pid');
    const current = identifyProcess(child.pid);
    if (!current) throw new Error('no identity');
    const stale = {
      rootPid: child.pid,
      pgid: child.pid,
      members: [{ ...current, startTime: '0', command: 'stale root' }],
    };
    expect(collectOwnership(child.pid, stale).members).toEqual([]);
    const kill = vi.spyOn(process, 'kill');
    const result = await stopProcessTree(child.pid, 1000, stale);
    const signals = kill.mock.calls
      .filter(
        ([pid, signal]) => pid === child.pid && (signal === 'SIGTERM' || signal === 'SIGKILL'),
      )
      .map(([, signal]) => signal);
    kill.mockRestore();
    expect(signals).toEqual([]);
    expect(result.stopped).toBe(false);
    expect(result.unknown).toBe(true);
    expect(pidAlive(child.pid)).toBe(true);
    await stopProcessTree(child.pid, 3000);
  });

  it('does not signal a reused process group after the owned members exited', async () => {
    const victim = spawnDetached('sleep', ['30']);
    if (!victim.pid) throw new Error('no pid');
    const stale = {
      rootPid: victim.pid,
      pgid: victim.pid,
      members: [{ pid: victim.pid, startTime: '0', pgid: victim.pid, sid: victim.pid }],
    };
    expect(collectOwnership(victim.pid, stale).members).toEqual([]);
    const result = await stopProcessTree(victim.pid, 1000, stale);
    expect(result.stopped).toBe(false);
    expect(result.unknown).toBe(true);
    expect(pidAlive(victim.pid)).toBe(true);
    await stopProcessTree(victim.pid, 3000);
  });

  it('finds a setsid child through the per-instance cgroup after the root exits', async () => {
    const cgroup = createCgroup(`test-${process.pid}-${Date.now()}`);
    if (!cgroup) {
      // GitHub-hosted runners do not expose a writable cgroup v2 hierarchy.
      // The cgroup path is exercised on the isolated Linux acceptance host.
      return;
    }
    try {
      const parent = spawnDetached('sh', [
        '-c',
        'echo $$ > "$1"; shift; exec sh -c "sleep 30 & exit 0"',
        'sh',
        join(cgroup, 'cgroup.procs'),
      ]);
      if (!parent.pid) throw new Error('no parent pid');
      const rootPid = parent.pid;
      const rootIdentity = identifyProcess(rootPid);
      if (!rootIdentity) throw new Error('no root identity');
      const stored = {
        rootPid,
        pgid: rootIdentity.pgid,
        members: [rootIdentity],
        cgroup,
        cgroupInode: statSync(cgroup).ino,
      };
      await waitUntil(() => !pidAlive(rootPid), 5000);
      const snapshot = collectOwnership(rootPid, stored);
      expect(snapshot.members.some((member) => member.pid !== rootPid)).toBe(true);
      const result = await stopProcessTree(rootPid, 3000, stored);
      expect(result.stopped).toBe(true);
      expect(cgroupPids(cgroup)).toEqual([]);
    } finally {
      removeCgroup(cgroup);
    }
  });

  it('scans the full cgroup subtree and removes it after stopping nested members', async () => {
    const cgroup = createCgroup(`tree-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    try {
      const nested = join(cgroup, 'nested');
      mkdirSync(nested);
      const root = spawnDetached('sleep', ['30']);
      const child = spawnDetached('sleep', ['30']);
      if (!root.pid || !child.pid) throw new Error('no pid');
      if (!movePidToCgroup(cgroup, root.pid) || !movePidToCgroup(nested, child.pid)) {
        throw new Error('could not move test processes');
      }
      const identity = identifyProcess(root.pid);
      if (!identity) throw new Error('no identity');
      const stored = {
        rootPid: root.pid,
        pgid: root.pid,
        members: [identity],
        cgroup,
        cgroupInode: statSync(cgroup).ino,
      };
      expect(cgroupTree(cgroup).pids).toEqual(expect.arrayContaining([root.pid, child.pid]));
      const result = await stopProcessTree(root.pid, 3000, stored);
      expect(result.stopped).toBe(true);
      expect(cgroupPids(cgroup)).toEqual([]);
    } finally {
      removeCgroup(cgroup);
    }
  });

  it('treats an unreadable cgroup boundary as unknown instead of empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moyu-cgroup-unreadable-'));
    writeFileSync(join(dir, 'cgroup.procs'), '1\n');
    expect(cgroupTree(dir).ok).toBe(false);
    expect(cgroupEmpty(dir)).toEqual({ ok: false, empty: false });
  });

  it('proves an adopted generation empty instead of holding capacity forever', async () => {
    const cgroup = createCgroup(`adopt-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    try {
      const live = spawnDetached('sleep', ['30']);
      if (!live.pid) throw new Error('no pid');
      expect(movePidToCgroup(cgroup, live.pid)).toBe(true);
      const dead = 4000000;
      const stored = {
        rootPid: dead,
        pgid: dead,
        cgroup,
        cgroupInode: statSync(cgroup).ino,
        adoptedUnproven: true,
        members: [{ pid: dead, startTime: '0', pgid: dead, sid: dead, command: 'dead' }],
      };
      // A live process inside an adopted boundary cannot be called owned: the
      // pre-adoption descendants outside it are unknown, so the snapshot stays
      // unknown and a stop must not claim the generation is empty.
      const snapshot = collectOwnership(dead, stored);
      expect(snapshot.unknown).toBe(true);
      expect(snapshot.cgroup).toBe('ok');
      // Once the boundary is recursively empty nothing of this generation is
      // left to hand over: the stop is proven instead of blocking capacity
      // forever, while the residual risk (descendants that escaped before the
      // adoption) is still reported. A leftover process that still held a port
      // is caught by the caller's listener identity check.
      const proof = await stopProcessTree(dead, 1000, stored);
      expect(proof.stopped).toBe(true);
      expect(proof.boundary).toBe('ok');
      expect(proof.unknown).toBe(true);
      expect(pidAlive(live.pid)).toBe(false);
      expect(cgroupPids(cgroup)).toEqual([]);
    } finally {
      removeCgroup(cgroup);
    }
  });

  it('stops a verified root and reports an unproven boundary without a cgroup', async () => {
    const child = spawnDetached('sleep', ['30']);
    if (!child.pid) throw new Error('no pid');
    const current = identifyProcess(child.pid);
    if (!current) throw new Error('no identity');
    const stored = { rootPid: child.pid, pgid: child.pid, members: [current] };
    const result = await stopProcessTree(child.pid, 3000, stored);
    expect(result.stopped).toBe(false);
    expect(result.unknown).toBe(true);
    expect(pidAlive(child.pid)).toBe(false);
  });

  it('finds a child forked after the snapshot even when the root already exited', async () => {
    const flag = `/tmp/moyu-orphan-${process.pid}-${Date.now()}`;
    const parent = spawnDetached('sh', [
      '-c',
      'while [ ! -f "$1" ]; do sleep 0.02; done; sleep 30 & exit 0',
      'sh',
      flag,
    ]);
    if (!parent.pid) throw new Error('no parent pid');
    const rootPid = parent.pid;
    const rootIdentity = identifyProcess(rootPid);
    if (!rootIdentity) throw new Error('no root identity');
    const stored = { rootPid, pgid: rootIdentity.pgid, members: [rootIdentity] };
    writeFileSync(flag, 'go');
    try {
      await waitUntil(() => !pidAlive(rootPid), 5000);
      const snapshot = collectOwnership(rootPid, stored);
      const children = snapshot.members.filter((member) => member.pid !== rootPid);
      expect(children.length).toBeGreaterThan(0);
      const result = await stopProcessTree(rootPid, 3000, stored);
      expect(result.stopped).toBe(false);
      expect(result.unknown).toBe(true);
      await waitUntil(() => collectOwnership(rootPid, stored).members.length === 0, 3000);
    } finally {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(flag, { force: true });
      } catch {
        // Already removed.
      }
    }
  });

  it('does not report stopped when the parent exits but its child survives', async () => {
    const parent = spawnDetached('sh', ['-c', 'sleep 30 & exit 0']);
    if (!parent.pid) throw new Error('no parent pid');
    const rootPid = parent.pid;
    await waitUntil(() => !pidAlive(rootPid), 5000);
    const snapshot = collectOwnership(rootPid);
    expect(snapshot.members.length).toBeGreaterThan(0);
    const result = await stopProcessTree(rootPid, 3000);
    expect(result.stopped).toBe(true);
    expect(result.remaining).toEqual([]);
    await waitUntil(() => collectOwnership(rootPid).members.length === 0, 3000);
  });

  it('does not report stopped when the timeout expires before the child exits', async () => {
    const child = spawnDetached('sh', ['-c', 'trap "" TERM; sleep 30']);
    if (!child.pid) throw new Error('no pid');
    const result = await stopProcessTree(child.pid, 10);
    expect(result.stopped).toBe(false);
    expect(result.remaining.some((member) => member.pid === child.pid)).toBe(true);
    expect(pidAlive(child.pid)).toBe(true);
    await stopProcessTree(child.pid, 3000);
  });

  it('kills a child that ignores SIGTERM before reporting stopped', async () => {
    const child = spawnDetached('sh', ['-c', 'trap "" TERM; sleep 30']);
    if (!child.pid) throw new Error('no pid');
    const result = await stopProcessTree(child.pid, 3000);
    expect(result.stopped).toBe(true);
    expect(pidAlive(child.pid)).toBe(false);
    expect(collectOwnership(child.pid).members).toEqual([]);
  });

  it('retains a newly started service regardless of its age', async () => {
    const parent = spawnDetached('sh', ['-c', 'sleep 30; echo done']);
    if (!parent.pid) throw new Error('no pid');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const childPid = childPids(parent.pid)[0] ?? NaN;
    expect(childPid).toBeGreaterThan(1);
    const retained = retainedDescendants(parent.pid);
    expect(retained.map((member) => member.pid)).toContain(childPid);
    expect(pidAlive(childPid)).toBe(true);
  });

  it('applies the retention policy only to known GitHub polling', () => {
    const members = [
      {
        pid: 2,
        startTime: '1',
        pgid: 2,
        sid: 2,
        command: '/root/.local/bin/gh-agent api repos/x/y',
      },
      { pid: 3, startTime: '2', pgid: 3, sid: 3, command: 'gh api repos/x/y' },
      { pid: 4, startTime: '3', pgid: 4, sid: 4, command: 'sleep 300' },
      { pid: 5, startTime: '4', pgid: 5, sid: 5, command: '/usr/bin/node server.js' },
      { pid: 6, startTime: '5', pgid: 6, sid: 6, command: 'gh-agent-worker --serve' },
      { pid: 7, startTime: '6', pgid: 7, sid: 7, command: 'gh pr create --title x' },
      { pid: 8, startTime: '7', pgid: 8, sid: 8, command: 'gh api -X POST repos/x/y' },
      { pid: 9, startTime: '8', pgid: 9, sid: 9, command: 'gh issue comment 1 --body x' },
    ];
    expect(retainedIdentities(members).map((member) => member.pid)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(isTransientPolling('gh api repos/x/y')).toBe(true);
    expect(isTransientPolling('gh api -X GET repos/x/y')).toBe(true);
    expect(isTransientPolling('gh api --paginate notifications')).toBe(true);
    expect(isTransientPolling('gh issue list --repo x/y')).toBe(true);
    expect(isTransientPolling('gh pr list')).toBe(true);
    expect(isTransientPolling('gh pr create --title x')).toBe(false);
    expect(isTransientPolling('gh api -X POST repos/x/y')).toBe(false);
    expect(isTransientPolling('gh issue comment 1 --body x')).toBe(false);
  });
});

describe('cgroup cold start and restart ownership', () => {
  it('creates a missing root, enables the controllers and binds the instance', () => {
    // A blank delegated directory: only the parent exists, with the controllers
    // available but not enabled and no pre-created `instances` root. This is the
    // field case that previously needed a hand-made directory.
    let parent: string;
    try {
      parent = mkdtempSync(join('/sys/fs/cgroup', 'moyu-cold-'));
    } catch {
      // A host without a writable cgroup v2 hierarchy: the isolated probe
      // scripts/m5b/cgroup-lifecycle-probe.sh covers this path with real output.
      return;
    }
    const root = join(parent, 'instances');
    try {
      const setup = ensureCgroup(`cold-${process.pid}-${Date.now()}`, root);
      expect(setup.ok).toBe(true);
      expect(setup.step).toBeNull();
      expect(setup.path).not.toBeNull();
      expect(setup.controllers).toEqual(expect.arrayContaining(['memory', 'pids']));
      expect(typeof setup.inode).toBe('number');
      // The child really is metered and limited, not just addressable.
      const applied = applyInstanceMemoryLimit(
        setup.path as string,
        limitsFromConfig({
          memoryTargetMb: 4096,
          memoryBudgetMb: 6144,
          memoryHardLimitMb: 8192,
          memoryReserveMb: 1024,
          memoryHysteresisMb: 256,
          instanceMemoryMaxMb: 512,
          instanceMemoryHighMb: 256,
          memoryPressureAvg10: 10,
        }),
      );
      expect(applied).toEqual({ ok: true, error: null });
      expect(statSync(join(setup.path as string, 'memory.current')).isFile()).toBe(true);
      expect(cgroupBoundary(setup.path).state).toBe('ok');
      expect(cgroupBoundary(setup.path).inode).toBe(setup.inode);
      // The root itself now offers the controllers to every later generation.
      const controllers = cgroupTree(parent);
      expect(controllers.ok).toBe(true);
    } finally {
      removeCgroup(root);
      try {
        removeCgroup(parent);
      } catch {
        // rmdir of the temporary parent is best effort.
      }
    }
  });

  it('refuses a root outside the cgroup v2 mount instead of starting unmetered', () => {
    const outside = ensureCgroup('outside', join(tmpdir(), `moyu-outside-${process.pid}`));
    expect(outside.ok).toBe(false);
    expect(outside.step).toBe('root');
    expect(outside.path).toBeNull();
    expect(outside.error).toContain('must be inside');
    const mountRoot = ensureCgroup('mount-root', '/sys/fs/cgroup');
    expect(mountRoot.ok).toBe(false);
    expect(mountRoot.step).toBe('root');
    expect(mountRoot.error).toContain('refusing');
  });

  it('refuses to widen a shared systemd hierarchy it does not own', () => {
    let parent: string;
    try {
      parent = mkdtempSync(join('/sys/fs/cgroup', 'moyu-shared-'));
    } catch {
      return;
    }
    try {
      // A directory next to other units: enabling controllers here would change
      // every service below it, so the root itself must be refused.
      mkdirSync(join(parent, 'other.service'));
      const setup = ensureCgroup(`shared-${process.pid}`, join(parent, 'instances'));
      expect(setup.ok).toBe(false);
      expect(setup.step).toBe('controllers');
      expect(setup.path).toBeNull();
      expect(setup.error).toContain('not delegated to this identity');
    } finally {
      removeCgroup(join(parent, 'instances'));
      removeCgroup(join(parent, 'other.service'));
      try {
        removeCgroup(parent);
      } catch {
        // Best effort cleanup under the cgroup mount.
      }
    }
  });

  it('treats a replaced cgroup object as unproven ownership', async () => {
    const cgroup = createCgroup(`replaced-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    const child = spawnDetached('sleep', ['30']);
    try {
      if (!child.pid) throw new Error('no pid');
      expect(movePidToCgroup(cgroup, child.pid)).toBe(true);
      const identity = identifyProcess(child.pid);
      if (!identity) throw new Error('no identity');
      const fresh = collectOwnership(child.pid, {
        rootPid: child.pid,
        pgid: identity.pgid,
        cgroup,
        cgroupInode: statSync(cgroup).ino,
        members: [identity],
      });
      expect(fresh.unknown).toBe(false);
      // A different inode means the path now names another cgroup object: the
      // recorded boundary is gone even though the path still exists.
      const replaced = collectOwnership(child.pid, {
        rootPid: child.pid,
        pgid: identity.pgid,
        cgroup,
        cgroupInode: statSync(cgroup).ino + 1,
        members: [identity],
      });
      expect(replaced.unknown).toBe(true);
    } finally {
      if (child.pid) await stopProcessTree(child.pid, 3000);
      removeCgroup(cgroup);
    }
  });

  it('never touches a same-name new cgroup object holding a live foreign process', async () => {
    const cgroup = createCgroup(`replaced-live-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    const holding = createCgroup(`replaced-holding-${process.pid}-${Date.now()}`);
    if (!holding) return;
    const foreign = spawnDetached('sleep', ['30']);
    try {
      if (!foreign.pid) throw new Error('no pid');
      const oldInode = statSync(cgroup).ino;
      expect(movePidToCgroup(holding, foreign.pid)).toBe(true);
      removeCgroup(cgroup);
      // The same path now names a different object; a foreign process lives in
      // it and must never be collected, signalled or used as an empty proof.
      mkdirSync(cgroup, { recursive: true });
      expect(statSync(cgroup).ino).not.toBe(oldInode);
      expect(movePidToCgroup(cgroup, foreign.pid)).toBe(true);
      const dead = 4000003;
      const stored = {
        rootPid: dead,
        pgid: dead,
        cgroup,
        cgroupInode: oldInode,
        members: [{ pid: dead, startTime: '0', pgid: dead, sid: dead, command: 'dead' }],
      };
      const snapshot = collectOwnership(dead, stored);
      expect(snapshot.cgroupReplaced).toBe(true);
      expect(snapshot.unknown).toBe(true);
      expect(snapshot.members.some((member) => member.pid === foreign.pid)).toBe(false);
      const result = await stopProcessTree(dead, 1500, stored);
      expect(result.stopped).toBe(false);
      expect(result.unknown).toBe(true);
      expect(result.boundary).toBe('replaced');
      expect(pidAlive(foreign.pid)).toBe(true);
      expect(cgroupPids(cgroup)).toContain(foreign.pid);
    } finally {
      if (foreign.pid && pidAlive(foreign.pid)) {
        process.kill(foreign.pid, 'SIGKILL');
      }
      writeFileSync(join(cgroup, 'cgroup.kill'), '1');
      removeCgroup(cgroup);
      removeCgroup(holding);
    }
  });

  it('does not keep a dissolved boundary unknown once nothing of the generation is alive', async () => {
    const gone = join(tmpdir(), `moyu-gone-${process.pid}-${Date.now()}`);
    const child = spawnDetached('sleep', ['30']);
    if (!child.pid) throw new Error('no pid');
    const identity = identifyProcess(child.pid);
    if (!identity) throw new Error('no identity');
    const stored = {
      rootPid: child.pid,
      pgid: identity.pgid,
      cgroup: gone,
      cgroupInode: 1,
      members: [identity],
    };
    expect(cgroupBoundary(gone).state).toBe('missing');
    // A live runtime whose boundary object vanished is unknown ownership.
    expect(collectOwnership(child.pid, stored).unknown).toBe(true);
    const result = await stopProcessTree(child.pid, 3000, stored);
    expect(pidAlive(child.pid)).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.boundary).toBe('missing');
    // Nothing of the generation is alive, so the row must not stay wedged.
    expect(collectOwnership(child.pid, stored).unknown).toBe(false);
  });

  it('reads and proves through the opened object when the path is replaced before the read', async () => {
    const cgroup = createCgroup(`race-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    const holding = createCgroup(`race-holding-${process.pid}-${Date.now()}`);
    if (!holding) return;
    const foreign = spawnDetached('sleep', ['30']);
    try {
      if (!foreign.pid) throw new Error('no pid');
      const oldInode = statSync(cgroup).ino;
      // Verify the object, then replace the path before any member/empty read.
      const opened = openCgroupObject(cgroup, oldInode);
      expect(opened.state).toBe('ok');
      expect(opened.fd).not.toBeNull();
      expect(movePidToCgroup(holding, foreign.pid)).toBe(true);
      removeCgroup(cgroup);
      mkdirSync(cgroup, { recursive: true });
      expect(statSync(cgroup).ino).not.toBe(oldInode);
      expect(movePidToCgroup(cgroup, foreign.pid)).toBe(true);
      try {
        // The descriptor still names the generation's object. Once that object
        // was removed its pseudo-files are gone, so the read fails closed; it
        // never falls through to the same-name new object's live foreign pid.
        const tree = cgroupTreeAt(opened.fd as number);
        expect(tree.pids).not.toContain(foreign.pid);
        expect(cgroupEmptyAt(opened.fd as number).ok).toBe(false);
        expect(pidAlive(foreign.pid)).toBe(true);
      } finally {
        opened.close();
      }
      // A fresh check sees the replacement and keeps the slot instead of
      // releasing capacity on the foreign object's state.
      expect(openCgroupObject(cgroup, oldInode).state).toBe('replaced');
      const dead = 4000006;
      const result = await stopProcessTree(dead, 1000, {
        rootPid: dead,
        pgid: dead,
        cgroup,
        cgroupInode: oldInode,
        members: [{ pid: dead, startTime: '0', pgid: dead, sid: dead, command: 'dead' }],
      });
      expect(result.stopped).toBe(false);
      expect(result.unknown).toBe(true);
      expect(result.boundary).toBe('replaced');
      expect(pidAlive(foreign.pid)).toBe(true);
    } finally {
      if (foreign.pid && pidAlive(foreign.pid)) process.kill(foreign.pid, 'SIGKILL');
      writeFileSync(join(cgroup, 'cgroup.kill'), '1');
      removeCgroup(cgroup);
      removeCgroup(holding);
    }
  });

  it('skips cleanup when the path is replaced after the empty proof', async () => {
    const cgroup = createCgroup(`cleanup-race-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    const holding = createCgroup(`cleanup-holding-${process.pid}-${Date.now()}`);
    if (!holding) return;
    const foreign = spawnDetached('sleep', ['30']);
    try {
      if (!foreign.pid) throw new Error('no pid');
      const oldInode = statSync(cgroup).ino;
      // The original generation is proven empty through its verified object.
      const opened = openCgroupObject(cgroup, oldInode);
      expect(opened.state).toBe('ok');
      expect(cgroupEmptyAt(opened.fd as number).empty).toBe(true);
      opened.close();
      // Replace the path after that proof and before cleanup. The new object
      // holds a foreign process and must stay exactly as it is.
      expect(movePidToCgroup(holding, foreign.pid)).toBe(true);
      removeCgroup(cgroup);
      mkdirSync(cgroup, { recursive: true });
      const newInode = statSync(cgroup).ino;
      expect(newInode).not.toBe(oldInode);
      expect(movePidToCgroup(cgroup, foreign.pid)).toBe(true);
      const cleaned = cleanupVerifiedCgroup(cgroup, oldInode);
      expect(cleaned.state).toBe('skipped');
      expect(cleaned.detail).toContain('replaced');
      expect(statSync(cgroup).ino).toBe(newInode);
      expect(pidAlive(foreign.pid)).toBe(true);
      expect(cgroupPids(cgroup)).toContain(foreign.pid);
    } finally {
      if (foreign.pid && pidAlive(foreign.pid)) process.kill(foreign.pid, 'SIGKILL');
      writeFileSync(join(cgroup, 'cgroup.kill'), '1');
      removeCgroup(cgroup);
      removeCgroup(holding);
    }
  });

  it('retains the directory when the path is replaced after the final verification', async () => {
    const cgroup = createCgroup(`cleanup-after-${process.pid}-${Date.now()}`);
    if (!cgroup) return;
    const holding = createCgroup(`cleanup-after-holding-${process.pid}-${Date.now()}`);
    if (!holding) return;
    const foreign = spawnDetached('sleep', ['30']);
    try {
      if (!foreign.pid) throw new Error('no pid');
      const foreignPid = foreign.pid;
      const oldInode = statSync(cgroup).ino;
      expect(movePidToCgroup(holding, foreignPid)).toBe(true);
      // Replace the path after the last verification but before cleanup would
      // have acted. Cleanup must retain the old directory and never touch the
      // same-name new object or its live process.
      const cleaned = cleanupVerifiedCgroup(cgroup, oldInode, {
        afterVerify: () => {
          removeCgroup(cgroup);
          mkdirSync(cgroup, { recursive: true });
          movePidToCgroup(cgroup, foreignPid);
        },
      });
      const newInode = statSync(cgroup).ino;
      expect(cleaned.state).toBe('retained');
      expect(cleaned.detail).toContain('fd-relative');
      expect(newInode).not.toBe(oldInode);
      expect(pidAlive(foreign.pid)).toBe(true);
      expect(cgroupPids(cgroup)).toContain(foreign.pid);
    } finally {
      if (foreign.pid && pidAlive(foreign.pid)) process.kill(foreign.pid, 'SIGKILL');
      writeFileSync(join(cgroup, 'cgroup.kill'), '1');
      removeCgroup(cgroup);
      removeCgroup(holding);
    }
  });

  it('identifies the process that listens on a port and whether it is managed', async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    try {
      const owners = portOwners(address.port);
      expect(owners.map((owner) => owner.pid)).toContain(process.pid);
      const self = owners.find((owner) => owner.pid === process.pid);
      expect(self?.cgroup).not.toBeNull();
      expect(ownedByRoot({ cgroup: CGROUP_ROOT }, CGROUP_ROOT)).toBe(true);
      expect(ownedByRoot({ cgroup: `${CGROUP_ROOT}/profile-1` }, CGROUP_ROOT)).toBe(true);
      expect(
        ownedByRoot({ cgroup: '/sys/fs/cgroup/system.slice/other.service' }, CGROUP_ROOT),
      ).toBe(false);
      expect(ownedByRoot({ cgroup: null }, CGROUP_ROOT)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(portOwners(address.port)).toEqual([]);
  });
});

describe('queued wake merge', () => {
  it('keeps the highest priority and the earliest request time in both arrival orders', () => {
    const first = new Date('2026-11-05T00:00:00Z');
    const second = new Date('2026-11-05T00:00:10Z');
    const replyFirst = mergeQueuedWake(
      { queuePriority: 10, wakeRequestedAt: first },
      { priority: 20, at: second },
      true,
    );
    expect(replyFirst).toEqual({ queuePriority: 10, wakeRequestedAt: first });

    const taskFirst = mergeQueuedWake(
      { queuePriority: 20, wakeRequestedAt: first },
      { priority: 10, at: second },
      true,
    );
    expect(taskFirst).toEqual({ queuePriority: 10, wakeRequestedAt: first });
  });

  it('resets the queue for a fresh, non-queued request', () => {
    const at = new Date('2026-11-05T00:01:00Z');
    expect(
      mergeQueuedWake(
        { queuePriority: 10, wakeRequestedAt: new Date(0) },
        { priority: 20, at },
        false,
      ),
    ).toEqual({ queuePriority: 20, wakeRequestedAt: at });
  });
});

describe('pre-exec cgroup handshake', () => {
  it('does not run the command before the supervisor releases it', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'm5b-handshake-'));
    const marker = join(dir, 'started');
    const child = spawn(
      '/bin/sh',
      ['-c', 'read go <&3; exec /bin/sh -c "touch $1"', 'moyu-cgroup', marker],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(existsSync(marker)).toBe(false);
      const release = child.stdio[3] as import('node:stream').Writable | null;
      expect(release && 'end' in release).toBe(true);
      release!.end('go\n');
      await new Promise<void>((resolve, reject) => {
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.once('error', reject);
      });
      expect(existsSync(marker)).toBe(true);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already exited */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cgroup launcher only accepts a positive release', () => {
  const run = async (release: 'eof' | 'wrong' | 'go', marker: string) => {
    const { spawn } = await import('node:child_process');
    const { CGROUP_LAUNCHER } = await import('../src/process');
    const child = spawn(
      '/bin/sh',
      ['-c', CGROUP_LAUNCHER, 'moyu-cgroup', '/bin/sh', '-c', `touch ${marker}`],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      },
    );
    const pipe = child.stdio[3] as import('node:stream').Writable | null;
    if (release === 'eof') pipe!.end();
    else pipe!.end(release === 'go' ? 'go\n' : 'nope\n');
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* already exited */
    }
    return code;
  };

  it('does not execute on EOF or a wrong release, and does on the exact release', async () => {
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'm5b-launcher-'));
    try {
      const eofMarker = join(dir, 'eof'),
        wrongMarker = join(dir, 'wrong'),
        goMarker = join(dir, 'go');
      expect(await run('eof', eofMarker)).toBe(126);
      expect(existsSync(eofMarker)).toBe(false);
      expect(await run('wrong', wrongMarker)).toBe(127);
      expect(existsSync(wrongMarker)).toBe(false);
      expect(await run('go', goMarker)).toBe(0);
      expect(existsSync(goMarker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits without executing when the parent dies before release', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { CGROUP_LAUNCHER } = await import('../src/process');
    const dir = mkdtempSync(join(tmpdir(), 'm5b-parent-kill-'));
    const marker = join(dir, 'executed');
    const script = [
      "const {spawn}=require('node:child_process')",
      "const c=spawn('/bin/sh',['-c',process.env.LAUNCHER,'moyu-cgroup','/bin/sh','-c',`touch ${process.env.MARKER}`],{detached:true,stdio:['ignore','ignore','ignore','pipe']})",
      'console.log(c.pid)',
      'setInterval(()=>{},1000)',
    ].join(';');
    const parent = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, LAUNCHER: CGROUP_LAUNCHER, MARKER: marker },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise<void>((resolve) => parent.stdout!.once('data', () => resolve()));
      process.kill(parent.pid!, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(marker)).toBe(false);
    } finally {
      try {
        process.kill(parent.pid!, 'SIGKILL');
      } catch {
        /* already exited */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cgroup release pipe', () => {
  it('does not crash the supervisor when the child dies before release', async () => {
    const { spawn } = await import('node:child_process');
    const { CGROUP_LAUNCHER } = await import('../src/process');
    const child = spawn(
      '/bin/sh',
      ['-c', CGROUP_LAUNCHER, 'moyu-cgroup', '/bin/sh', '-c', 'sleep 5'],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      },
    );
    const pipe = child.stdio[3] as import('node:stream').Writable | null;
    const errors: Error[] = [];
    pipe!.on('error', (error) => errors.push(error));
    process.kill(child.pid!, 'SIGKILL');
    pipe!.end('go\n');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(errors.length).toBeLessThanOrEqual(1);
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* already exited */
    }
  });
});
