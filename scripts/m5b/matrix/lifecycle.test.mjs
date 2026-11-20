import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cleanupFailedUp } from './lifecycle.mjs';

const uid = process.getuid();
const gid = process.getgid();

function fixture() {
  const run = mkdtempSync(join(tmpdir(), 'm5b-lifecycle-'));
  const protectedDir = join(run, 'protected');
  const credentialsDir = join(run, 'credentials');
  const instanceEnvDir = join(run, 'instance-env');
  for (const dir of [protectedDir, credentialsDir, instanceEnvDir]) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  writeFileSync(join(protectedDir, 'supervisor-token'), 'token\n', { mode: 0o600 });
  writeFileSync(join(protectedDir, 'seed.env'), 'export X=1\n', { mode: 0o600 });
  writeFileSync(join(credentialsDir, 'repo.json'), '{}\n', { mode: 0o600 });
  writeFileSync(join(instanceEnvDir, 'repo.env'), 'MOYU_X=1\n', { mode: 0o600 });
  return { run, protectedDir, credentialsDir, instanceEnvDir };
}

function cgroupFixture(procs) {
  const root = mkdtempSync(join(tmpdir(), 'm5b-lifecycle-cg-'));
  const instance = join(root, 'instances', 'm5b-payload');
  mkdirSync(instance, { recursive: true });
  writeFileSync(join(instance, 'cgroup.kill'), '');
  writeFileSync(join(instance, 'cgroup.procs'), procs);
  return {
    root: join(root, 'instances'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fakeExec(units, { stubborn = new Set() } = {}) {
  return (command, args) => {
    if (command !== 'systemctl') return { status: 0, stdout: '' };
    const [action, unit] = args;
    if (action === 'stop' && !stubborn.has(unit)) units.set(unit, 'inactive');
    if (action === 'reset-failed') units.set(unit, units.get(unit) ?? 'inactive');
    if (action === 'is-active') return { status: 0, stdout: `${units.get(unit) ?? 'inactive'}\n` };
    return { status: 0, stdout: '' };
  };
}

test('failed-up cleanup stops units, removes secrets and verifies an empty state', () => {
  const { run, protectedDir, credentialsDir, instanceEnvDir } = fixture();
  const units = new Map([
    ['m5bmatrix-api.service', 'active'],
    ['m5bmatrix-dispatcher.service', 'active'],
  ]);
  const result = cleanupFailedUp({
    units: [...units.keys()],
    protectedDir,
    credentialsDir,
    instanceEnvDir,
    exec: fakeExec(units),
    uid,
    user: { uid, gid },
  });
  assert.deepEqual(result.failures, []);
  for (const state of units.values()) assert.equal(state, 'inactive');
  assert.equal(
    result.actions.some(
      (action) => action.includes('removed secret') && action.includes('seed.env'),
    ),
    true,
  );
  assert.equal(
    result.actions.some((action) => action.includes('bridge credentials')),
    true,
  );
  assert.throws(() => readFileSync(join(protectedDir, 'seed.env')), /ENOENT/);
  rmSync(run, { recursive: true, force: true });
});

test('a unit that refuses to stop is reported as a cleanup failure', () => {
  const { run, protectedDir, credentialsDir, instanceEnvDir } = fixture();
  const stubborn = new Set(['m5bmatrix-api.service']);
  const units = new Map([['m5bmatrix-api.service', 'active']]);
  const result = cleanupFailedUp({
    units: [...units.keys()],
    protectedDir,
    credentialsDir,
    instanceEnvDir,
    exec: fakeExec(units, { stubborn }),
    uid,
    user: { uid, gid },
  });
  assert.equal(
    result.failures.some((failure) => failure.includes('still active')),
    true,
  );
  rmSync(run, { recursive: true, force: true });
});

test('an unremovable secret is reported and read back', () => {
  const { run, protectedDir, credentialsDir, instanceEnvDir } = fixture();
  chmodSync(protectedDir, 0o777);
  const result = cleanupFailedUp({
    units: [],
    protectedDir,
    credentialsDir,
    instanceEnvDir,
    exec: fakeExec(new Map()),
    uid,
    user: { uid, gid },
  });
  assert.equal(
    result.failures.some(
      (failure) => failure.includes('could not remove') || failure.includes('still exists'),
    ),
    true,
  );
  rmSync(run, { recursive: true, force: true });
});

test('a leftover instance cgroup process is reported after cleanup', () => {
  const { run, protectedDir, credentialsDir, instanceEnvDir } = fixture();
  const cgroup = cgroupFixture('1234\n');
  const result = cleanupFailedUp({
    units: [],
    protectedDir,
    credentialsDir,
    instanceEnvDir,
    cgroupRoot: cgroup.root,
    exec: fakeExec(new Map()),
    uid,
    user: { uid, gid },
  });
  assert.equal(
    result.failures.some((failure) => failure.includes('still has processes')),
    true,
  );
  cgroup.cleanup();
  rmSync(run, { recursive: true, force: true });
});

test('an empty instance cgroup passes the read-back', () => {
  const { run, protectedDir, credentialsDir, instanceEnvDir } = fixture();
  const cgroup = cgroupFixture('');
  const result = cleanupFailedUp({
    units: [],
    protectedDir,
    credentialsDir,
    instanceEnvDir,
    cgroupRoot: cgroup.root,
    exec: fakeExec(new Map()),
    uid,
    user: { uid, gid },
  });
  assert.deepEqual(result.failures, []);
  assert.equal(
    result.actions.some((action) => action.startsWith('cgroup.kill')),
    true,
  );
  cgroup.cleanup();
  rmSync(run, { recursive: true, force: true });
});
