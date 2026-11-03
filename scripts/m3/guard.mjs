/**
 * Isolation guard for the M3 E2E harness. It runs before the harness deletes or
 * reconfigures anything, so a typo or an environment inherited from the
 * bootstrap instance cannot destroy the wrong DSH home or point the test at a
 * production port.
 *
 * The checks are deliberately about identity, not just names: the target
 * profile must link to a built dsh-superagent artifact that contains the MoYu
 * Bridge, and the DSH home must be a dedicated `.dsh-*` directory that is not
 * the bootstrap `/root/.dsh`.
 */
import { createConnection } from 'node:net';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export const BOOTSTRAP_HOME = '/root/.dsh';
export const BOOTSTRAP_PORT = 3082;
export const PRODUCTION_PORT = 4300;
export const BRIDGE_MARKER = 'moyu-bridge/1';

export class IsolationGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IsolationGuardError';
  }
}

function fail(message) {
  throw new IsolationGuardError(message);
}

function isInside(parent, child) {
  const base = resolve(parent) + sep;
  return resolve(child) === resolve(parent) || resolve(child).startsWith(base);
}

function portFree(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (free) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(free);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
  });
}

/** Resolves the only paths the harness may delete for this DSH home/profile. */
export function isolatedPaths(dshHome, profile) {
  const home = resolve(dshHome);
  return {
    stateDir: join(home, 'state', profile),
    sessionsDir: join(home, 'sessions'),
    profileDir: join(home, 'profiles', profile),
  };
}

/**
 * Validates the target before any deletion or reconfiguration.
 * @returns {{dshHome: string, profile: string, profileDir: string, stateDir: string, sessionsDir: string}}
 */
export async function assertE2EIsolation(options) {
  const { dshHome, profile, dshPort, apiPort, bridgePort, envFile } = options;
  if (!dshHome || !isAbsolute(dshHome)) fail('E2E_DSH_HOME must be an absolute path');
  const home = resolve(dshHome);
  if (home === '/' || home === BOOTSTRAP_HOME || isInside(BOOTSTRAP_HOME, home)) {
    fail(`refusing to use the bootstrap DSH home: ${home}`);
  }
  const base = home.split(sep).filter(Boolean).at(-1) ?? '';
  if (!base.startsWith('.dsh-'))
    fail(`E2E_DSH_HOME must be a dedicated .dsh-* directory, got ${home}`);
  if (!profile || profile === 'superagent' || profile === 'dsh-tui') {
    fail(`refusing to use DSH profile ${JSON.stringify(profile)}`);
  }
  for (const [name, port] of Object.entries({ dshPort, apiPort, bridgePort })) {
    if (!Number.isInteger(port) || port <= 0) fail(`${name} must be a positive integer`);
    if (port === BOOTSTRAP_PORT) fail(`${name} ${port} is the bootstrap port`);
    if (port === PRODUCTION_PORT) fail(`${name} ${port} is the production API port`);
  }
  if (new Set([dshPort, apiPort, bridgePort]).size !== 3)
    fail('DSH, API and Bridge ports must differ');

  const paths = isolatedPaths(home, profile);
  for (const path of [paths.stateDir, paths.sessionsDir]) {
    if (!isInside(home, path)) fail(`target path escapes the isolated DSH home: ${path}`);
  }
  if (!existsSync(paths.profileDir)) fail(`profile directory does not exist: ${paths.profileDir}`);

  const link = join(paths.profileDir, 'node_modules', 'dsh-superagent');
  if (!existsSync(link)) fail(`profile has no dsh-superagent installation: ${link}`);
  let linked;
  try {
    linked = realpathSync(link);
  } catch {
    fail(`profile dsh-superagent link is broken: ${link}`);
  }
  if (isInside(BOOTSTRAP_HOME, linked))
    fail(`profile links to the bootstrap installation: ${linked}`);
  const packageJson = join(linked, 'package.json');
  const entry = join(linked, 'lib', 'index.js');
  if (!existsSync(packageJson) || !existsSync(entry))
    fail(`linked artifact is incomplete: ${linked}`);
  let packageName = '';
  try {
    packageName = JSON.parse(readFileSync(packageJson, 'utf8')).name;
  } catch {
    fail(`linked artifact package.json is unreadable: ${packageJson}`);
  }
  if (packageName !== 'dsh-superagent')
    fail(`linked package is not dsh-superagent: ${packageName}`);
  if (!readFileSync(entry, 'utf8').includes(BRIDGE_MARKER)) {
    fail(`linked dsh-superagent build has no MoYu Bridge marker: ${entry}`);
  }

  if (!envFile || !existsSync(envFile)) fail(`instance env file is missing: ${envFile}`);
  const mode = statSync(envFile).mode & 0o777;
  if (mode !== 0o600) fail(`instance env file must be 0600, got ${mode.toString(8)}: ${envFile}`);
  const env = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
  for (const name of [
    'MOYU_PLATFORM_URL',
    'MOYU_PLATFORM_TOKEN',
    'MOYU_BRIDGE_TOKEN',
    'MOYU_BRIDGE_PORT',
  ]) {
    if (!env[name]) fail(`instance env file lacks ${name}`);
  }
  if (Number(env.MOYU_BRIDGE_PORT) !== bridgePort) {
    fail(`instance Bridge port ${env.MOYU_BRIDGE_PORT} does not match target ${bridgePort}`);
  }
  for (const [name, port] of Object.entries({ dshPort, apiPort })) {
    if (!(await portFree(port))) fail(`${name} ${port} is already in use; refusing to disturb it`);
  }
  return { dshHome: home, profile, ...paths };
}

/** Verifies that the panel state we just reached belongs to the expected isolated machine/profile. */
export function assertInstanceIdentity(state, expectedStateDir) {
  const actual = state?.setup?.machine?.stateDir;
  if (!actual) fail('panel state has no machine stateDir');
  if (resolve(actual) !== resolve(expectedStateDir)) {
    fail(`unexpected runtime identity: stateDir ${actual}, expected ${expectedStateDir}`);
  }
}
