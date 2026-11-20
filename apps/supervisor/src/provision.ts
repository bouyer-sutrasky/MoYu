import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { SupervisorConfig } from './config';
import type { RepositoryRow, SupervisorStore } from './store';
import { portFree } from './process';

export interface PreparedInstance {
  repository: RepositoryRow;
  profile: string;
  dshPort: number;
  bridgePort: number;
  envFile: string;
  credentialsFile: string;
  bridgeToken: string;
  callbackToken: string;
  /** True only when installProfile copied a new profile directory. */
  profileCreated: boolean;
  runtimeUid?: number;
  runtimeGid?: number;
  runtimeHome?: string;
  stateDir?: string;
  checkUid?: number;
  checkGid?: number;
  checkHome?: string;
}

/**
 * Refuses a symbolic link anywhere on the path. A worker shares this process's
 * uid, so a replaced component must not be able to redirect a bootstrap write.
 */
function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  let cursor: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Refusing to follow the symbolic link ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/**
 * Creates or verifies a directory that holds instance credentials, the profile
 * or instance state: it must be a real directory owned by this process and
 * group/other must not be able to write it. The mode is repaired, never the
 * owner: a directory owned by another identity is refused rather than adopted.
 */
export function ensurePrivateDir(path: string): void {
  assertNoSymlinkComponents(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use the symbolic link ${path}`);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${path}`);
  if (stat.uid !== currentUid()) {
    throw new Error(`Refusing to use ${path}: owned by uid ${stat.uid}, expected ${currentUid()}`);
  }
  chmodSync(path, 0o700);
}

/**
 * Writes one credential or profile file into a verified private directory,
 * atomically and without ever following a symbolic link at the target. The
 * temporary file is created with `wx` and renamed over the target, so a
 * partially written token can never become the live one.
 */
export function writePrivate(path: string, content: string): void {
  const directory = dirname(resolve(path));
  ensurePrivateDir(directory);
  const target = resolve(path);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink())
      throw new Error(`Refusing to write through the symbolic link ${target}`);
    if (!stat.isFile()) throw new Error(`Refusing to replace the non-file ${target}`);
    if (stat.uid !== currentUid()) {
      throw new Error(`Refusing to replace ${target}: owned by uid ${stat.uid}`);
    }
  }
  const temporary = join(
    directory,
    `.${target.split(sep).at(-1)}.tmp-${process.pid}-${Date.now()}`,
  );
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already consumed the temporary file.
    }
    throw error;
  }
}

/** Existence check that uses lstat, not access(2): DAC_OVERRIDE does not satisfy access(2). */
export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Chown a tree without following symlinks; symlinked shared assets stay shared. */
export function chownTree(path: string, uid: number, gid: number): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    lchownSync(path, uid, gid);
    return;
  }
  chownSync(path, uid, gid);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    chownTree(join(path, entry.name), uid, gid);
  }
}

/**
 * Build a per-repository DSH home. The runtime gets its own .env, credentials,
 * sessions and caches, and can only traverse its own profile/state directories.
 * The shared dshHome remains the supervisor's control-plane root; parents are
 * made traverse-only and the per-profile entries are owned by the runtime uid.
 *
 * Every profile gets a home, including dynamically allocated profiles with no
 * pinned runtime identity. Without one, HOME/DSH_HOME fall back to the shared
 * supervisor home, where the runtime cannot read `.config/gh-agent`; the GitHub
 * account check then fails and the instance stops before it comes online.
 */
function prepareRuntimeIdentity(
  config: SupervisorConfig,
  profile: string,
  profileDir: string,
  pinned: { runtimeUid?: number; runtimeGid?: number; runtimeHome?: string } | undefined,
): { runtimeUid?: number; runtimeGid?: number; runtimeHome: string; stateDir: string } {
  const uid = pinned?.runtimeUid;
  const gid = pinned?.runtimeGid;
  // A pinned profile runs as its own low-privilege identity. A dynamically
  // allocated profile keeps the supervisor identity but still gets an isolated
  // home, which is the boundary the deployment configured for it.
  const privileged = uid !== undefined && gid !== undefined;
  const home = pinned?.runtimeHome ?? join(config.dshHome, 'homes', profile);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  if (privileged) chownSync(home, uid, gid);

  for (const name of ['.env', '.credentials.yaml', '.anonymous-user-id']) {
    const source = join(config.dshHome, name);
    if (!pathExists(source)) continue;
    const target = join(home, name);
    // The runtime copies are read-only. Replacing a previous copy therefore
    // needs the write permission of an already-owned 0400 file removed first.
    rmSync(target, { force: true });
    cpSync(source, target);
    chmodSync(target, 0o400);
    if (privileged) chownSync(target, uid, gid);
  }

  // `gh-agent` resolves its credentials from `$HOME/.config/gh-agent` (or an
  // explicit GH_CONFIG_DIR). Every runtime home carries its own copy so the
  // managed GitHub account check works there. Missing source configuration is
  // reported at prepare time instead of surfacing later as a stopped instance.
  const ghSource = config.githubConfigDir ?? join(dirname(config.dshHome), '.config', 'gh-agent');
  if (!pathExists(ghSource)) {
    throw new Error(
      `The GitHub CLI configuration is missing at ${ghSource}; the runtime home cannot be prepared. Configure GITHUB_CONFIG_DIR or install the agent account credentials.`,
    );
  }
  const configDir = join(home, '.config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  if (privileged) chownSync(configDir, uid, gid);
  const ghTarget = join(configDir, 'gh-agent');
  rmSync(ghTarget, { recursive: true, force: true });
  cpSync(ghSource, ghTarget, { recursive: true });
  if (privileged) chownTree(configDir, uid, gid);
  chmodSync(configDir, 0o700);
  chmodSync(ghTarget, 0o700);

  // `dsh --profile <name>` resolves the profile under `$DSH_HOME/profiles`.
  // The isolated home is a sibling of the shared profile root, so point the
  // profile lookup at the supervisor-owned tree instead of copying profiles.
  const profilesLink = join(home, 'profiles');
  if (!pathExists(profilesLink) && pathExists(join(config.dshHome, 'profiles'))) {
    symlinkSync(join(config.dshHome, 'profiles'), profilesLink, 'dir');
  }

  // Git/SSH material is per runtime home too. The shared config uses an
  // absolute IdentityFile path; rewrite it to the isolated copy so the runtime
  // can authenticate without read access to the supervisor home.
  const sshSource = join(dirname(config.dshHome), '.ssh');
  if (pathExists(sshSource)) {
    const sshTarget = join(home, '.ssh');
    rmSync(sshTarget, { recursive: true, force: true });
    cpSync(sshSource, sshTarget, { recursive: true });
    const sshConfig = join(sshTarget, 'config');
    if (pathExists(sshConfig)) {
      const rewritten = readFileSync(sshConfig, 'utf8').replaceAll(
        join(sshSource, 'id_ed25519'),
        join(sshTarget, 'id_ed25519'),
      );
      writeFileSync(sshConfig, rewritten, { mode: 0o600 });
    }
    if (privileged) chownTree(sshTarget, uid, gid);
    chmodSync(sshTarget, 0o700);
    for (const entry of readdirSync(sshTarget, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      chmodSync(join(sshTarget, entry.name), entry.name === 'known_hosts' ? 0o644 : 0o600);
    }
  }

  // The DSH state root is per repository too. It must be writable by the
  // runtime so proper-lockfile can create <stateDir>.lock without giving the
  // runtime write access to the shared state parent.
  const privateState = join(home, 'state');
  // Profiles provisioned before per-repository state used a symlink to the
  // shared state root. Remove that symlink before creating the isolated dir,
  // otherwise mkdir/chmod would follow it and modify the shared parent.
  if (pathExists(privateState) && lstatSync(privateState).isSymbolicLink()) {
    rmSync(privateState, { force: true });
  }
  mkdirSync(privateState, { recursive: true, mode: 0o700 });
  chmodSync(privateState, 0o700);
  if (privileged) chownSync(privateState, uid, gid);
  const stateDir = join(privateState, profile);
  const sharedState = join(config.dshHome, 'state', profile);
  if (!pathExists(stateDir)) {
    if (pathExists(sharedState)) {
      cpSync(sharedState, stateDir, { recursive: true });
    } else {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    }
  }
  if (privileged) chownTree(stateDir, uid, gid);
  chmodSync(stateDir, 0o700);
  rmSync(stateDir + '.lock', { recursive: true, force: true });

  // Keep the existing per-profile state for continuity, but point the profile
  // patch at the isolated copy. The shared state directory remains the
  // supervisor-controlled fallback for unpinned instances.
  const patchPath = join(profileDir, 'cordis.patch.yml');
  if (pathExists(patchPath)) {
    const patch = readFileSync(patchPath, 'utf8');
    const next = patch.replace(/^(\s*stateDir:\s*).+$/m, '$1' + stateDir);
    if (next !== patch) writePrivate(patchPath, next);
  }

  for (const privateDir of ['sessions', 'storages', 'logs', 'tmp', 'cache']) {
    const path = join(home, privateDir);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    if (privileged) chownSync(path, uid, gid);
  }

  // The runtime must be able to enter its own 0700 profile/state directories,
  // but not list or enter another repository's directories.
  if (privileged) {
    chownTree(profileDir, uid, gid);
    chmodSync(profileDir, 0o700);
  }

  return {
    ...(privileged ? { runtimeUid: uid, runtimeGid: gid } : {}),
    runtimeHome: home,
    stateDir,
  };
}

/** The managed instance environment written under `INSTANCE_ENV_DIR`. */
export function instanceEnvironment(input: {
  platformUrl: string;
  platformToken: string;
  bridgeToken: string;
  bridgePort: number;
}): string {
  return [
    `MOYU_PLATFORM_URL=${input.platformUrl}`,
    `MOYU_PLATFORM_TOKEN=${input.platformToken}`,
    `MOYU_BRIDGE_TOKEN=${input.bridgeToken}`,
    'MOYU_BRIDGE_HOST=127.0.0.1',
    `MOYU_BRIDGE_PORT=${input.bridgePort}`,
    // Managed instances always enforce execution admission; the capability
    // is advertised only when this flag is on.
    'MOYU_REQUIRE_ADMISSION=1',
    // Test-only: an isolated acceptance stack may shorten the runtime's launch-stop bound to reach the
    // `timed-out` branch deterministically. The supervisor never sets this itself and production leaves it unset.
    ...(process.env.MOYU_TEST_HOOKS === '1'
      ? [
          'MOYU_TEST_HOOKS=1',
          `MOYU_TEST_PAUSE_LAUNCH_MS=${
            /^[0-9]+$/.test(process.env.MOYU_TEST_PAUSE_LAUNCH_MS ?? '')
              ? (process.env.MOYU_TEST_PAUSE_LAUNCH_MS as string)
              : '10000'
          }`,
        ]
      : []),
    '',
  ].join('\n');
}

export function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) throw new Error(`Malformed instance env line in ${path}`);
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

/**
 * The exact environment a runtime starts with. Exported so tests cover the
 * launched environment (HOME/DSH_HOME and the per-home caches) instead of only
 * the returned provision metadata.
 */
export function instanceProcessEnvironment(
  prepared: PreparedInstance,
  config: SupervisorConfig,
  base: Record<string, string>,
): Record<string, string> {
  const runtimeHome = prepared.runtimeHome ?? config.dshHome;
  return {
    ...base,
    HOME: runtimeHome,
    DSH_HOME: runtimeHome,
    ...parseEnvFile(prepared.envFile),
    ...(prepared.runtimeHome
      ? {
          TMPDIR: join(runtimeHome, 'tmp'),
          XDG_CACHE_HOME: join(runtimeHome, 'cache'),
        }
      : {}),
  };
}

/** Creates the group-shared worktree root used by both the runtime and the checks. */
function ensureSharedWorktreeRoot(config: SupervisorConfig): void {
  mkdirSync(config.worktreeRoot, { recursive: true, mode: 0o2775 });
  try {
    if (config.reviewCheckGid !== undefined)
      chownSync(config.worktreeRoot, -1, config.reviewCheckGid);
    chmodSync(config.worktreeRoot, 0o2775);
  } catch {
    // A root the supervisor cannot chgrp stays as created; the check identity then
    // refuses the run instead of silently using the supervisor's uid.
    chmodSync(config.worktreeRoot, 0o750);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Allocates a fixed profile/port pair. A pinned mapping is the normal deployment
 * path; the sequential allocator only supports adding a repository on demand
 * from the same fixed template.
 */
async function allocate(
  config: SupervisorConfig,
  store: SupervisorStore,
  repository: RepositoryRow,
): Promise<{ profile: string; dshPort: number; bridgePort: number }> {
  const pinned = config.pinned?.get(repository.fullName);
  if (pinned) {
    return { profile: pinned.profile, dshPort: pinned.dshPort, bridgePort: pinned.bridgePort };
  }
  const existing = await store.getInstance(repository.id);
  if (existing?.profile && existing.port) {
    return {
      profile: existing.profile,
      dshPort: existing.port,
      bridgePort: existing.port + 1,
    };
  }
  if (!config.profileTemplateDir) {
    throw new Error(
      'No pinned instance mapping and no PROFILE_TEMPLATE_DIR; cannot prepare this repository',
    );
  }
  const instances = await store.listInstances();
  const used = new Set(
    instances.map((row) => row.profile).filter((value): value is string => !!value),
  );
  // A sleeping instance still owns its profile and both ports. Reserving only
  // the profile would allow another repository to take a port it still needs
  // (for example a swapped dsh/bridge pair) and overwrite its Source state.
  const usedPorts = new Set<number>();
  for (const row of instances) {
    if (row.port) usedPorts.add(row.port);
    if (row.bridgePort) usedPorts.add(row.bridgePort);
  }
  for (const instance of config.pinned.values()) {
    used.add(instance.profile);
    usedPorts.add(instance.dshPort);
    usedPorts.add(instance.bridgePort);
  }
  const pairCount = Math.floor((config.portRange.end - config.portRange.start) / 2);
  for (let index = 0; index < pairCount; index += 1) {
    const profile = `${config.profilePrefix}-${index + 1}`;
    const dshPort = config.portRange.start + index * 2;
    const bridgePort = dshPort + 1;
    if (used.has(profile)) continue;
    if (usedPorts.has(dshPort) || usedPorts.has(bridgePort)) continue;
    if (!(await portFree(dshPort)) || !(await portFree(bridgePort))) continue;
    return { profile, dshPort, bridgePort };
  }
  throw new Error('No free supervisor profile/port pair in the configured range');
}

function installProfile(
  config: SupervisorConfig,
  profile: string,
  dshPort: number,
): { profileDir: string; created: boolean } {
  const profileDir = join(config.dshHome, 'profiles', profile);
  let created = false;
  if (!pathExists(profileDir)) {
    if (!config.profileTemplateDir || !pathExists(config.profileTemplateDir)) {
      throw new Error(`Profile ${profile} does not exist and the template is unavailable`);
    }
    cpSync(config.profileTemplateDir, profileDir, { recursive: true });
    created = true;
    const patchPath = join(profileDir, 'cordis.patch.yml');
    if (!pathExists(patchPath)) {
      rmSync(profileDir, { recursive: true, force: true });
      throw new Error(`Profile template has no cordis.patch.yml: ${config.profileTemplateDir}`);
    }
    const patch = readFileSync(patchPath, 'utf8')
      .replaceAll('__DSH_PORT__', String(dshPort))
      .replaceAll('__STATE_DIR__', join(config.dshHome, 'state', profile));
    writePrivate(patchPath, patch);
    chmodSync(profileDir, 0o700);
  }
  return { profileDir, created };
}

/**
 * Prepares the credential boundary and the profile for one repository. Idempotent:
 * a repeated add request reuses the same token file and profile, so a concurrent
 * wake cannot create a second instance or rotate a token under a running worker.
 */
export async function prepareInstance(
  config: SupervisorConfig,
  store: SupervisorStore,
  repositoryId: string,
): Promise<PreparedInstance> {
  const repository = await store.getRepository(repositoryId);
  if (!repository) throw new Error('Repository not found');

  ensurePrivateDir(config.credentialsDir);
  ensurePrivateDir(config.instanceEnvDir);
  ensurePrivateDir(config.logDir);
  // The worktree root is shared with the review check identity on purpose: the
  // check user has to traverse into a ticket directory to run the repository's
  // checks. `ensurePrivateDir` would force 0700 and silently lock it out.
  ensureSharedWorktreeRoot(config);

  const { profile, dshPort, bridgePort } = await allocate(config, store, repository);
  const { profileDir, created: profileCreated } = installProfile(config, profile, dshPort);
  const pinned = config.pinned?.get(repository.fullName);
  const identity = prepareRuntimeIdentity(config, profile, profileDir, pinned);
  if (!pathExists(join(profileDir, 'node_modules', 'dsh-superagent'))) {
    throw new Error(`Profile ${profile} has no dsh-superagent installation`);
  }

  const credentialsFile = join(config.credentialsDir, `${repository.id}.json`);
  const envFile = join(config.instanceEnvDir, `${repository.id}.env`);
  let credentials: { bridgeToken: string; callbackToken: string } | null = null;
  if (pathExists(credentialsFile)) {
    const parsed = JSON.parse(readFileSync(credentialsFile, 'utf8')) as {
      bridgeToken?: string;
      callbackToken?: string;
    };
    if (parsed.bridgeToken && parsed.callbackToken) {
      credentials = { bridgeToken: parsed.bridgeToken, callbackToken: parsed.callbackToken };
    }
  }
  if (!credentials) {
    credentials = {
      bridgeToken: randomBytes(32).toString('base64url'),
      callbackToken: randomBytes(32).toString('base64url'),
    };
  }

  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  writePrivate(credentialsFile, `${JSON.stringify({ bridgeUrl, ...credentials }, null, 2)}\n`);
  writePrivate(
    envFile,
    instanceEnvironment({
      platformUrl: config.platformUrl,
      platformToken: credentials.callbackToken,
      bridgeToken: credentials.bridgeToken,
      bridgePort,
    }),
  );

  await store.setBridgeBinding(repository.id, {
    bridgeUrl,
    credentialRef: `file:${repository.id}.json`,
    callbackTokenHash: sha256(credentials.callbackToken),
  });
  await store.createInstance(repository.id, 'sleeping', 'sleeping', 'never_started', {
    profile,
    port: dshPort,
    bridgePort,
  });
  await store.updateInstance(repository.id, {
    profile,
    port: dshPort,
    bridgePort,
    reasonCode: 'sleeping',
    reasonDetail: null,
    waitingFor: null,
  });

  return {
    repository,
    profile,
    dshPort,
    bridgePort,
    envFile,
    credentialsFile,
    ...credentials,
    profileCreated,
    ...identity,
    ...(pinned?.checkUid !== undefined && pinned.checkGid !== undefined && pinned.checkHome
      ? { checkUid: pinned.checkUid, checkGid: pinned.checkGid, checkHome: pinned.checkHome }
      : {}),
  };
}

export function instanceLogPath(config: SupervisorConfig, profile: string): string {
  return join(config.logDir, `${profile}.log`);
}
