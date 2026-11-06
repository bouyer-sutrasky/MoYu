import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindStopProof, verifyStopProof, type StopProofIdentity } from '../src/stop-proof';

const real = `/sys/fs/cgroup/m5b-stop-proof-${process.pid}`;
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
    await rm(real, { recursive: true, force: true });
  } catch {
    /* absent */
  }
});
const identity: StopProofIdentity = {
  runtimeId: 'r1',
  generation: 'g1',
  ticketId: 't1',
  assignmentId: 'a1',
  leaseId: 'l1',
  fencingToken: '1',
};
const input = (path: string) => ({ ...identity, cgroup: path });
const rootOnly = process.getuid?.() === 0;

async function fakeCgroup(path: string, populated: 0 | 1) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'cgroup.events'), `populated ${populated}\n`);
}

describe('supervisor cgroup stop proof binding', () => {
  it('is idempotent only for the same complete identity and refuses a conflicting rebind', async () => {
    const path = join(state, 'fake-a');
    await fakeCgroup(path, 0);
    await bindStopProof(state, input(path));
    await bindStopProof(state, input(path));
    const other = {
      ...identity,
      ticketId: 't2',
      assignmentId: 'a2',
      leaseId: 'l2',
      fencingToken: '2',
    };
    await expect(bindStopProof(state, { ...other, cgroup: path })).rejects.toThrow(
      /another unproven/,
    );
    expect(await verifyStopProof(state, other)).toMatchObject({
      proven: false,
      reason: expect.stringMatching(/binding/),
    });
    expect(await verifyStopProof(state, identity)).toMatchObject({ proven: true });
  });

  it('refuses a corrupted record, a reused inode and a missing path', async () => {
    const path = join(state, 'fake-b');
    await fakeCgroup(path, 0);
    await writeFile(join(state, 'stop-proof', 'bad.json'), '{');
    await expect(
      bindStopProof(state, { ...identity, runtimeId: 'bad', cgroup: path }),
    ).rejects.toThrow(/unreadable/);
    await bindStopProof(state, { ...identity, runtimeId: 'reuse', cgroup: path });
    await rename(path, `${path}-old`);
    await fakeCgroup(path, 0);
    expect(await verifyStopProof(state, { ...identity, runtimeId: 'reuse' })).toMatchObject({
      proven: false,
      reason: expect.stringMatching(/reused/),
    });
    await rm(path, { recursive: true, force: true });
    expect(await verifyStopProof(state, { ...identity, runtimeId: 'reuse' })).toMatchObject({
      proven: false,
      reason: expect.stringMatching(/missing/),
    });
  });
});

describe.skipIf(!rootOnly)('supervisor cgroup stop proof with a real group', () => {
  it('refuses a populated generation, then proves the same inode empty', async () => {
    await mkdir(real);
    const child = spawn('sleep', ['10'], { stdio: 'ignore' });
    children.push(child.pid!);
    await writeFile(join(real, 'cgroup.procs'), String(child.pid));
    await bindStopProof(state, { ...identity, runtimeId: 'real', cgroup: real });
    const live = await verifyStopProof(state, { ...identity, runtimeId: 'real' });
    expect(live.proven).toBe(false);
    if (!live.proven) expect(live.reason).toMatch(/populated/);
    child.kill('SIGKILL');
    for (let i = 0; i < 50; i++) {
      if (/^populated 0$/m.test(await readFile(join(real, 'cgroup.events'), 'utf8'))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await verifyStopProof(state, { ...identity, runtimeId: 'real' })).toEqual({
      proven: true,
    });
    expect(JSON.parse(await readFile(join(state, 'stop-proof', 'real.json'), 'utf8')).state).toBe(
      'proven',
    );
  });
});
