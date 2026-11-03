/**
 * Isolation guard for the M3 E2E harness. It runs before the harness deletes or
 * reconfigures anything, so a typo or an environment inherited from the
 * bootstrap instance cannot destroy the wrong DSH home or point the test at a
 * production port.
 *
 * The checks are about identity, not just names: the target profile must link
 * to a built dsh-superagent artifact that contains the MoYu Bridge, the DSH home
 * and every cleanup target must be real paths inside that home (symlinked
 * parents are refused), and the instance env file is parsed once and validated
 * against the already-validated home/profile/ports before it reaches the child.
 */
import { createConnection } from 'node:net';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { URL } from 'node:url';

export const BOOTSTRAP_HOME = '/root/.dsh';
export const BOOTSTRAP_PORT = 3082;
export const PRODUCTION_PORT = 4300;
export const BRIDGE_MARKER = 'moyu-bridge/1';
export const INSTANCE_ENV_KEYS = new Set([
  'MOYU_PLATFORM_URL',
  'MOYU_PLATFORM_TOKEN',
  'MOYU_BRIDGE_TOKEN',
  'MOYU_BRIDGE_HOST',
  'MOYU_BRIDGE_PORT',
]);

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

/** Parses the instance env file once, rejecting duplicate or unexpected keys. */
export function readInstanceEnv(envFile) {
  const values = new Map();
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) fail(`malformed instance env line: ${trimmed}`);
    const key = trimmed.slice(0, index).trim();
    if (!INSTANCE_ENV_KEYS.has(key)) {
      fail(
        `instance env file must not set ${key}; only ${[...INSTANCE_ENV_KEYS].join(', ')} are allowed`,
      );
    }
    if (values.has(key)) fail(`instance env file repeats ${key}`);
    values.set(key, trimmed.slice(index + 1).trim());
  }
  return Object.fromEntries(values);
}

function validatePlatformUrl(value, apiPort) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`MOYU_PLATFORM_URL is not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== apiPort) {
    fail(
      `MOYU_PLATFORM_URL must point at this isolated API http://127.0.0.1:${apiPort}, got ${value}`,
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    fail(`MOYU_PLATFORM_URL must be the API origin, got ${value}`);
  }
}

/**
 * Rejects any symbolic link from the isolated home down to a cleanup target,
 * including links whose destination is still inside the same home. Resolving
 * through such a link would let `rmSync(target, {recursive:true})` delete a
 * different profile's state. Every existing component must be a real directory
 * (or the leaf a real file); only a not-yet-created leaf is allowed.
 */
function assertNoSymlinkPath(realHome, target, label) {
  const lexical = resolve(target);
  if (!isInside(realHome, lexical)) fail(`${label} escapes the isolated DSH home: ${lexical}`);
  let cursor = realHome;
  for (const part of relative(realHome, lexical).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        fail(`${label} traverses a symbolic link at ${cursor}; refusing to clean it`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return lexical;
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
 * Validates the target and the instance configuration before any deletion or
 * reconfiguration. Returns the verified paths and the whitelisted child env.
 */
export async function assertE2EIsolation(options) {
  const {
    dshHome,
    profile,
    dshPort,
    apiPort,
    bridgePort,
    envFile,
    processEnv = process.env,
  } = options;
  if (!dshHome || !isAbsolute(dshHome)) fail('E2E_DSH_HOME must be an absolute path');
  const home = resolve(dshHome);
  if (!existsSync(home)) fail(`E2E_DSH_HOME does not exist: ${home}`);
  if (lstatSync(home).isSymbolicLink()) {
    fail(`E2E_DSH_HOME must not be a symbolic link: ${home}`);
  }
  const realHome = realpathSync(home);
  if (
    home === '/' ||
    home === BOOTSTRAP_HOME ||
    realHome === BOOTSTRAP_HOME ||
    isInside(BOOTSTRAP_HOME, home) ||
    isInside(BOOTSTRAP_HOME, realHome)
  ) {
    fail(`refusing to use the bootstrap DSH home: ${home}`);
  }
  const base = realHome.split(sep).filter(Boolean).at(-1) ?? '';
  if (!base.startsWith('.dsh-'))
    fail(`E2E_DSH_HOME must be a dedicated .dsh-* directory, got ${realHome}`);

  if (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..') {
    fail(`DSH profile must be a single path component, got ${JSON.stringify(profile)}`);
  }
  if (profile === 'superagent' || profile === 'dsh-tui') {
    fail(`refusing to use DSH profile ${JSON.stringify(profile)}`);
  }
  if (processEnv.DSH_HOME && resolve(processEnv.DSH_HOME) !== home) {
    fail(`DSH_HOME in the process env conflicts with the validated home: ${processEnv.DSH_HOME}`);
  }
  if (processEnv.DSH_PROFILE && processEnv.DSH_PROFILE !== profile) {
    fail(
      `DSH_PROFILE in the process env conflicts with the validated profile: ${processEnv.DSH_PROFILE}`,
    );
  }
  for (const [name, port] of Object.entries({ dshPort, apiPort, bridgePort })) {
    if (!Number.isInteger(port) || port <= 0) fail(`${name} must be a positive integer`);
    if (port === BOOTSTRAP_PORT) fail(`${name} ${port} is the bootstrap port`);
    if (port === PRODUCTION_PORT) fail(`${name} ${port} is the production API port`);
  }
  if (new Set([dshPort, apiPort, bridgePort]).size !== 3)
    fail('DSH, API and Bridge ports must differ');

  const paths = isolatedPaths(realHome, profile);
  const stateDir = assertNoSymlinkPath(realHome, paths.stateDir, 'state directory');
  const sessionsDir = assertNoSymlinkPath(realHome, paths.sessionsDir, 'sessions directory');
  const profileDir = assertNoSymlinkPath(realHome, paths.profileDir, 'profile directory');
  if (!existsSync(profileDir)) fail(`profile directory does not exist: ${profileDir}`);

  const link = join(profileDir, 'node_modules', 'dsh-superagent');
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
  const env = readInstanceEnv(envFile);
  for (const name of [
    'MOYU_PLATFORM_URL',
    'MOYU_PLATFORM_TOKEN',
    'MOYU_BRIDGE_TOKEN',
    'MOYU_BRIDGE_PORT',
  ]) {
    if (!env[name]) fail(`instance env file lacks ${name}`);
  }
  validatePlatformUrl(env.MOYU_PLATFORM_URL, apiPort);
  if (env.MOYU_BRIDGE_HOST && env.MOYU_BRIDGE_HOST !== '127.0.0.1') {
    fail(`MOYU_BRIDGE_HOST must be 127.0.0.1, got ${env.MOYU_BRIDGE_HOST}`);
  }
  if (Number(env.MOYU_BRIDGE_PORT) !== bridgePort) {
    fail(`instance Bridge port ${env.MOYU_BRIDGE_PORT} does not match target ${bridgePort}`);
  }
  if (processEnv.MOYU_PLATFORM_URL && processEnv.MOYU_PLATFORM_URL !== env.MOYU_PLATFORM_URL) {
    fail(
      `MOYU_PLATFORM_URL in the process env conflicts with the instance: ${processEnv.MOYU_PLATFORM_URL}`,
    );
  }
  if (processEnv.MOYU_BRIDGE_PORT && Number(processEnv.MOYU_BRIDGE_PORT) !== bridgePort) {
    fail(
      `MOYU_BRIDGE_PORT in the process env conflicts with the target: ${processEnv.MOYU_BRIDGE_PORT}`,
    );
  }
  for (const [name, port] of Object.entries({ dshPort, apiPort, bridgePort })) {
    if (!(await portFree(port))) fail(`${name} ${port} is already in use; refusing to disturb it`);
  }
  return { dshHome: realHome, profile, stateDir, sessionsDir, profileDir, env };
}

/** Verifies that the panel state we just reached belongs to the expected isolated machine/profile. */
export function assertInstanceIdentity(state, expectedStateDir) {
  const actual = state?.setup?.machine?.stateDir;
  if (!actual) fail('panel state has no machine stateDir');
  if (resolve(actual) !== resolve(expectedStateDir)) {
    fail(`unexpected runtime identity: stateDir ${actual}, expected ${expectedStateDir}`);
  }
}
