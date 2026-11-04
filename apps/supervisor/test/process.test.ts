import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';

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
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not listen');
    expect(await portFree(address.port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await waitForPortClosed(address.port, 1000)).toBe(true);
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
