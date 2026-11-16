import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
  checkUid?: number;
  checkGid?: number;
  checkHome?: string;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Chown a tree without following symlinks; symlinked shared assets stay shared. */
function chownTree(path: string, uid: number, gid: number): void {
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
 */
function prepareRuntimeIdentity(
  config: SupervisorConfig,
  profile: string,
  profileDir: string,
  pinned: { runtimeUid?: number; runtimeGid?: number; runtimeHome?: string } | undefined,
): { runtimeUid?: number; runtimeGid?: number; runtimeHome?: string } {
  if (!pinned || pinned.runtimeUid === undefined || pinned.runtimeGid === undefined) {
    return {};
  }
  const uid = pinned.runtimeUid;
  const gid = pinned.runtimeGid;
  const home = pinned.runtimeHome ?? join(config.dshHome, 'homes', profile);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  chownSync(home, uid, gid);

  for (const name of ['.env', '.credentials.yaml', '.anonymous-user-id']) {
    const source = join(config.dshHome, name);
    if (!existsSync(source)) continue;
    const target = join(home, name);
    cpSync(source, target);
    chmodSync(target, 0o400);
    chownSync(target, uid, gid);
  }

  const ghSource = join(dirname(config.dshHome), '.config', 'gh-agent');
  if (existsSync(ghSource)) {
    const ghTarget = join(home, '.config', 'gh-agent');
    cpSync(ghSource, ghTarget, { recursive: true });
    chownTree(join(home, '.config'), uid, gid);
    chmodSync(ghTarget, 0o700);
  }

  for (const shared of ['profiles', 'state']) {
    const link = join(home, shared);
    if (!existsSync(link)) symlinkSync(join(config.dshHome, shared), link);
  }
  for (const privateDir of ['sessions', 'storages', 'logs', 'tmp', 'cache']) {
    const path = join(home, privateDir);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    chownSync(path, uid, gid);
  }

  // The runtime must be able to enter its own 0700 profile/state directories,
  // but not list or enter another repository's directories.
  chownTree(profileDir, uid, gid);
  chmodSync(profileDir, 0o700);
  const stateDir = join(config.dshHome, 'state', profile);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chownTree(stateDir, uid, gid);
  chmodSync(stateDir, 0o700);
  const lockDir = join(config.dshHome, 'state', profile + '.lock');
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  chownTree(lockDir, uid, gid);
  chmodSync(lockDir, 0o700);

  return { runtimeUid: uid, runtimeGid: gid, runtimeHome: home };
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
  if (!existsSync(profileDir)) {
    if (!config.profileTemplateDir || !existsSync(config.profileTemplateDir)) {
      throw new Error(`Profile ${profile} does not exist and the template is unavailable`);
    }
    cpSync(config.profileTemplateDir, profileDir, { recursive: true });
    created = true;
    const patchPath = join(profileDir, 'cordis.patch.yml');
    if (!existsSync(patchPath)) {
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
  if (!existsSync(join(profileDir, 'node_modules', 'dsh-superagent'))) {
    throw new Error(`Profile ${profile} has no dsh-superagent installation`);
  }

  const credentialsFile = join(config.credentialsDir, `${repository.id}.json`);
  const envFile = join(config.instanceEnvDir, `${repository.id}.env`);
  let credentials: { bridgeToken: string; callbackToken: string } | null = null;
  if (existsSync(credentialsFile)) {
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
