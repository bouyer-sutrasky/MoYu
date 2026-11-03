import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
        'MOYU_PLATFORM_URL=http://127.0.0.1:4301',
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
    ...overrides,
  };
}

test('accepts a dedicated profile linked to the patched build', async () => {
  const fixtureValue = fixture();
  const result = await assertE2EIsolation(await options(fixtureValue));
  assert.equal(result.stateDir, join(fixtureValue.home, 'state', 'm3'));
  assert.equal(result.sessionsDir, join(fixtureValue.home, 'sessions'));
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
