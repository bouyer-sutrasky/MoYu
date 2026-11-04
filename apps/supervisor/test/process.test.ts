import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { mergeQueuedWake } from '../src/manager';
import {
  childPids,
  collectOwnership,
  descendants,
  isTransientPolling,
  pidAlive,
  portFree,
  retainedDescendants,
  stopProcessTree,
  waitForPortClosed,
} from '../src/process';

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

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

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && pidAlive(child.pid)) {
      await stopProcessTree(child.pid, 3000);
    }
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
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

  it('ignores only the known short-lived GitHub polling process', async () => {
    expect(isTransientPolling('/root/.local/bin/gh-agent api repos/x/y')).toBe(true);
    expect(isTransientPolling('gh api repos/x/y')).toBe(true);
    expect(isTransientPolling('sleep 300')).toBe(false);
    expect(isTransientPolling('/usr/bin/node server.js')).toBe(false);

    const directory = mkdtempSync(join(tmpdir(), 'moyu-gh-'));
    tempDirs.push(directory);
    const gh = join(directory, 'gh-agent');
    copyFileSync('/bin/sleep', gh);
    chmodSync(gh, 0o755);
    const polling = spawnDetached(gh, ['30']);
    if (!polling.pid) throw new Error('no polling pid');
    expect(isTransientPolling(`/tmp/${'gh-agent'} api`)).toBe(true);
    expect(retainedDescendants(process.pid).some((member) => member.pid === polling.pid)).toBe(
      false,
    );
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
