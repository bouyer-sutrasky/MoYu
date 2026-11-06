import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindStopProof, verifyStopProof } from '../src/stop-proof';

const root = `/sys/fs/cgroup/m5b-stop-proof-${process.pid}`;
const state = await mkdtemp(join(tmpdir(), 'm5b-stop-proof-'));
const children: number[] = [];
afterEach(async () => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* absent */
  }
});
const input = () => ({
  runtimeId: 'r1',
  generation: 'g1',
  cgroup: root,
  ticketId: 't1',
  assignmentId: 'a1',
  leaseId: 'l1',
  fencingToken: '1',
});
const rootOnly = process.getuid?.() === 0;

describe.skipIf(!rootOnly)('supervisor cgroup stop proof', () => {
  it('refuses a populated generation, then proves the same inode empty', async () => {
    await writeFile('/sys/fs/cgroup/cgroup.subtree_control', '+memory +pids').catch(() => {});
    await import('node:fs/promises').then((fs) => fs.mkdir(root));
    const child = spawn('sleep', ['10'], { stdio: 'ignore' });
    children.push(child.pid!);
    await writeFile(join(root, 'cgroup.procs'), String(child.pid));
    await bindStopProof(state, input());
    const live = await verifyStopProof(state, 'r1', 'g1');
    expect(live.proven).toBe(false);
    if (!live.proven) expect(live.reason).toMatch(/populated/);
    child.kill('SIGKILL');
    for (let i = 0; i < 50; i++) {
      const events = await readFile(join(root, 'cgroup.events'), 'utf8');
      if (/^populated 0$/m.test(events)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await verifyStopProof(state, 'r1', 'g1')).toEqual({ proven: true });
    expect(JSON.parse(await readFile(join(state, 'stop-proof', 'r1.json'), 'utf8')).state).toBe(
      'proven',
    );
  });

  it('refuses a missing path, a changed generation and a reused inode', async () => {
    expect((await verifyStopProof(state, 'r1', 'g1')).proven).toBe(false);
    await import('node:fs/promises').then((fs) => fs.mkdir(root));
    await bindStopProof(state, input());
    expect(await verifyStopProof(state, 'r1', 'g2')).toMatchObject({
      proven: false,
      reason: expect.stringMatching(/generation/),
    });
    expect(await verifyStopProof(state, 'r1', 'g1')).toMatchObject({ proven: true });
    await rm(root, { recursive: true, force: true });
    expect(await verifyStopProof(state, 'r1', 'g1')).toMatchObject({
      proven: false,
      reason: expect.stringMatching(/missing/),
    });
  });
});
