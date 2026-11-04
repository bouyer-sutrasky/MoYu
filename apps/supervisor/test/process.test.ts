import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  descendants,
  pidAlive,
  portFree,
  stopProcessTree,
  waitForPortClosed,
} from '../src/process';

const processes: number[] = [];

afterEach(async () => {
  for (const pid of processes.splice(0)) {
    if (pidAlive(pid)) {
      await stopProcessTree(pid, 3000);
    }
  }
});

describe('supervisor process evidence', () => {
  it('reports a loopback port as free only when nothing listens on it', async () => {
    expect(await portFree(4499)).toBe(true);
    expect(await portFree(3082)).toBe(false);
    expect(await waitForPortClosed(4499, 500)).toBe(true);
  });

  it('lists a real child process and stops its detached process group', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    if (!child.pid) throw new Error('no pid');
    processes.push(child.pid);
    const grandchild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    if (!grandchild.pid) throw new Error('no grandchild pid');
    processes.push(grandchild.pid);
    // A direct child of this test process is enough to prove /proc traversal.
    expect(descendants(process.pid)).toContain(child.pid);
    expect(await stopProcessTree(child.pid, 3000)).toBe(true);
    expect(pidAlive(child.pid)).toBe(false);
  });
});
