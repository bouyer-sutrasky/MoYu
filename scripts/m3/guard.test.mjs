import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join as pathJoin, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { IsolationGuardError, assertE2EIsolation, assertInstanceIdentity } from './guard.mjs';

function fixture({ bridge = true, mode = 0o600, envPort = 3999, withEnv = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), '.dsh-guard-'));
  const profile = 'm3';
  const profileDir = join(home, 'profiles', profile);
  const build = join(home, 'build');
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  mkdirSync(join(build, 'lib'), { recursive: true });
  writeFileSync(
    join(build, 'package.json'),
    JSON.stringify({ name: 'dsh-superagent', version: '0.1.0' }),
  );
  writeFileSync(join(build, 'lib', 'index.js'), bridge ? '// moyu-bridge/1\n' : '// pristine\n');
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  symlinkSync(build, join(profileDir, 'node_modules', 'dsh-superagent'));
  const envFile = join(home, 'env');
  if (withEnv) {
    writeFileSync(
      envFile,
      [
        'MOYU_PLATFORM_URL=http://127.0.0.1:3989',
        'MOYU_PLATFORM_TOKEN=test-platform-token',
        'MOYU_BRIDGE_TOKEN=test-bridge-token',
        `MOYU_BRIDGE_PORT=${envPort}`,
      ].join('\n'),
    );
    chmodSync(envFile, mode);
  }
  return { home, profile, profileDir, envFile, build };
}

async function options(fixture, overrides = {}) {
  return {
    dshHome: fixture.home,
    profile: fixture.profile,
    dshPort: 3988,
    apiPort: 3989,
    bridgePort: 3999,
    envFile: fixture.envFile,
    processEnv: {},
    ...overrides,
  };
}

test('accepts a dedicated profile linked to the patched build', async () => {
  const fixtureValue = fixture();
  const result = await assertE2EIsolation(await options(fixtureValue));
  assert.equal(result.stateDir, join(fixtureValue.home, 'state', 'm3'));
  assert.equal(result.sessionsDir, join(fixtureValue.home, 'sessions'));
  // The harness deletes exactly these validated paths, never a resolved link target.
  assert.equal(result.stateDir, join(result.dshHome, 'state', result.profile));
  rmSync(fixtureValue.home, { recursive: true, force: true });
});

test('rejects the bootstrap home and profile', async () => {
  await assert.rejects(
    assertE2EIsolation({
      dshHome: '/root/.dsh',
      profile: 'm3',
      dshPort: 3988,
      apiPort: 3989,
      bridgePort: 3999,
      envFile: '/nonexistent',
    }),
    IsolationGuardError,
  );
  const fixtureValue = fixture();
  await assert.rejects(
    assertE2EIsolation(await options(fixtureValue, { profile: 'superagent' })),
    IsolationGuardError,
  );
  rmSync(fixtureValue.home, { recursive: true, force: true });
});

test('rejects an unpatched build and a wrong Bridge port', async () => {
  const unpatched = fixture({ bridge: false });
  await assert.rejects(assertE2EIsolation(await options(unpatched)), /no MoYu Bridge marker/);
  rmSync(unpatched.home, { recursive: true, force: true });

  const mismatched = fixture({ envPort: 4001 });
  await assert.rejects(assertE2EIsolation(await options(mismatched)), /does not match target/);
  rmSync(mismatched.home, { recursive: true, force: true });
});

test('rejects an env file with broad permissions', async () => {
  const broad = fixture({ mode: 0o644 });
  await assert.rejects(assertE2EIsolation(await options(broad)), /must be 0600/);
  rmSync(broad.home, { recursive: true, force: true });
});

test('rejects a target port that is already in use', async () => {
  const fixtureValue = fixture();
  const server = createServer();
  await new Promise((resolve) => server.listen(3989, '127.0.0.1', resolve));
  await assert.rejects(assertE2EIsolation(await options(fixtureValue)), /already in use/);
  await new Promise((resolve) => server.close(resolve));
  rmSync(fixtureValue.home, { recursive: true, force: true });
});

test('rejects instance env keys that could override the validated home/profile', async () => {
  const fixtureValue = fixture();
  writeFileSync(
    fixtureValue.envFile,
    'DSH_HOME=/root/.dsh\nMOYU_PLATFORM_URL=http://127.0.0.1:3989\n',
  );
  chmodSync(fixtureValue.envFile, 0o600);
  await assert.rejects(assertE2EIsolation(await options(fixtureValue)), /must not set DSH_HOME/);
  rmSync(fixtureValue.home, { recursive: true, force: true });
});

test('rejects an instance env pointing at the production API or a conflicting process env', async () => {
  const production = fixture();
  writeFileSync(
    production.envFile,
    'MOYU_PLATFORM_URL=http://127.0.0.1:4300\nMOYU_PLATFORM_TOKEN=x\nMOYU_BRIDGE_TOKEN=y\nMOYU_BRIDGE_PORT=3999\n',
  );
  chmodSync(production.envFile, 0o600);
  await assert.rejects(assertE2EIsolation(await options(production)), /isolated API/);
  rmSync(production.home, { recursive: true, force: true });

  const conflict = fixture();
  await assert.rejects(
    assertE2EIsolation(await options(conflict, { processEnv: { DSH_HOME: '/root/.dsh' } })),
    /DSH_HOME in the process env conflicts/,
  );
  rmSync(conflict.home, { recursive: true, force: true });
});

test('rejects a symlinked state parent and leaves the other instance untouched', async () => {
  const fixtureValue = fixture();
  const victim = mkdtempSync(join(tmpdir(), 'm3-victim-'));
  mkdirSync(join(victim, 'm3'), { recursive: true });
  writeFileSync(join(victim, 'm3', 'keep.txt'), 'keep');
  symlinkSync(victim, join(fixtureValue.home, 'state'));
  await assert.rejects(
    assertE2EIsolation(await options(fixtureValue)),
    /traverses a symbolic link/,
  );
  assert.equal(readFileSync(join(victim, 'm3', 'keep.txt'), 'utf8'), 'keep');
  rmSync(fixtureValue.home, { recursive: true, force: true });
  rmSync(victim, { recursive: true, force: true });
});

test('rejects state/<profile> linked to another profile in the same home', async () => {
  const fixtureValue = fixture();
  const another = join(fixtureValue.home, 'state', 'another-profile');
  mkdirSync(another, { recursive: true });
  writeFileSync(join(another, 'keep.txt'), 'keep');
  symlinkSync(another, join(fixtureValue.home, 'state', 'm3'));
  await assert.rejects(
    assertE2EIsolation(await options(fixtureValue)),
    /traverses a symbolic link/,
  );
  assert.equal(readFileSync(join(another, 'keep.txt'), 'utf8'), 'keep');
  rmSync(fixtureValue.home, { recursive: true, force: true });
});

test('rejects sessions linked to another directory in the same home', async () => {
  const fixtureValue = fixture();
  const other = join(fixtureValue.home, 'other-sessions');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'keep.txt'), 'keep');
  symlinkSync(other, join(fixtureValue.home, 'sessions'));
  await assert.rejects(
    assertE2EIsolation(await options(fixtureValue)),
    /traverses a symbolic link/,
  );
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'keep');
  rmSync(fixtureValue.home, { recursive: true, force: true });
});

test('rejects a cleanup target whose parent link stays inside the same home', async () => {
  const fixtureValue = fixture();
  const otherState = join(fixtureValue.home, 'other-state');
  mkdirSync(join(otherState, 'm3'), { recursive: true });
  writeFileSync(join(otherState, 'm3', 'keep.txt'), 'keep');
  symlinkSync(otherState, join(fixtureValue.home, 'state'));
  await assert.rejects(
    assertE2EIsolation(await options(fixtureValue)),
    /traverses a symbolic link/,
  );
  assert.equal(readFileSync(join(otherState, 'm3', 'keep.txt'), 'utf8'), 'keep');
  rmSync(fixtureValue.home, { recursive: true, force: true });
});

test('rejects a profile containing path separators', async () => {
  const fixtureValue = fixture();
  await assert.rejects(
    assertE2EIsolation(await options(fixtureValue, { profile: 'm3/../../other' })),
    /single path component/,
  );
  rmSync(fixtureValue.home, { recursive: true, force: true });
});

test('the E2E script exits before any run directory for a bootstrap home or production API', () => {
  const root = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const out = mkdtempSync(pathJoin(tmpdir(), 'm3-e2e-reject-'));
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('DSH_') && !key.startsWith('MOYU_'),
    ),
  );
  const common = { ...baseEnv, E2E_OUT: out, E2E_DSH_PROFILE: 'm3' };
  if (existsSync('/root/.dsh')) {
    const bootstrap = spawnSync(process.execPath, ['scripts/m3/e2e.mjs'], {
      cwd: root,
      env: { ...common, E2E_DSH_HOME: '/root/.dsh' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.notEqual(bootstrap.status, 0);
    assert.match(`${bootstrap.stdout}${bootstrap.stderr}`, /bootstrap DSH home/);
    assert.equal(readdirSync(out).length, 0);
  }

  // Build a throwaway valid instance fixture, then ask the script for port 4300:
  // the guard must reject it before opening a database or writing a run directory.
  const fixtureValue = fixture();
  const production = spawnSync(process.execPath, ['scripts/m3/e2e.mjs'], {
    cwd: root,
    env: { ...common, E2E_DSH_HOME: fixtureValue.home, E2E_API_PORT: '4300' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.notEqual(production.status, 0);
  assert.match(`${production.stdout}${production.stderr}`, /production API port/);
  assert.equal(readdirSync(out).length, 0);
  assert.equal(existsSync(pathJoin(out, 'run')), false);
  rmSync(fixtureValue.home, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test('refuses a runtime whose stateDir is not the expected isolated profile', () => {
  assert.throws(
    () =>
      assertInstanceIdentity(
        { setup: { machine: { stateDir: '/root/.dsh/state/superagent' } } },
        '/tmp/x',
      ),
    /unexpected runtime identity/,
  );
  assert.doesNotThrow(() =>
    assertInstanceIdentity(
      { setup: { machine: { stateDir: '/tmp/.dsh-x/state/m3' } } },
      '/tmp/.dsh-x/state/m3',
    ),
  );
});
