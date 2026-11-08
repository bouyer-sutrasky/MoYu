/**
 * Isolation guard for the M5-B on-site matrix harness.
 *
 * The matrix runs untrusted, model-authored commands as the dedicated
 * `m5bmatrix` identity on a host that also runs the production bootstrap and
 * the shared m5b profile. Two rules keep that safe and are enforced here:
 *
 * 1. The test identity must have no write permission on host configuration
 *    (the bootstrap DSH homes, the shared gh/token configuration, SSH keys).
 *    `auditHost`/`assertNoHostWrite` compute that from owner/group/mode bits,
 *    including the fact that a writable *parent directory* lets an identity
 *    replace the file inside it.
 * 2. Privileged bootstrap files (supervisor token, seeded session token,
 *    bridge credentials, the staged runtime profile) are written only into
 *    directories whose ownership and mode were verified, and never through a
 *    symbolic link. The run root is root-owned so the test identity cannot
 *    rename or replace the directories that hold them.
 *
 * The module is also a small CLI (`node guard.mjs <command>`) so the shell
 * harness uses exactly the checks the tests exercise. It never prints secret
 * file content; `redact` is used wherever a value might carry a token.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export class IsolationGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IsolationGuardError';
  }
}

function fail(message) {
  throw new IsolationGuardError(message);
}

export const RUN_ROOT_MODE = 0o755;
export const PRIVATE_DIR_MODE = 0o700;
export const SHARED_CONFIG_DIR_MODE = 0o750;
export const SECRET_FILE_MODE = 0o600;
export const SHARED_CONFIG_FILE_MODE = 0o640;

/** Parents a run root may live under. Everything else is host configuration. */
export const ALLOWED_RUN_PARENTS = Object.freeze(['/tmp', '/var/tmp', '/srv/m5b']);

function allowedRunParents() {
  return [...ALLOWED_RUN_PARENTS, realpathSync(tmpdir())];
}

/** Host configuration the matrix may read/traverse but must never write. */
export const HOST_READ_ONLY_PATHS = Object.freeze([
  '/root',
  '/root/.ssh',
  '/root/.dsh',
  '/root/.dsh-m5',
  '/root/.config',
  '/root/.config/gh-agent',
  '/root/.local',
  '/root/.local/bin',
  '/root/src',
  '/root/src/upstream',
  '/opt/moyu-node24',
  '/etc',
]);

/** Host files that hold a shared credential; readable only by their owner. */
export const HOST_SECRET_PATHS = Object.freeze([
  '/root/.ssh/sa_agent',
  '/root/.ssh/sa_agent2',
  '/root/.ssh/id_ed25519',
  '/root/.config/gh-agent/hosts.yml',
  '/root/.dsh/.credentials.yaml',
  '/root/.dsh-m5/.credentials.yaml',
  '/root/.dsh-m5/instances.json',
]);

export const DEFAULT_LAYOUT = Object.freeze({
  protected: 'protected',
  config: 'config',
  scratch: 'tmp',
  credentials: 'credentials',
  instanceEnv: 'instance-env',
  instanceLogs: 'instance-logs',
  worktrees: 'worktrees',
  dshHome: 'dsh-home',
  stage: 'stage',
  logs: 'logs',
});

export function resolveUser(name, { passwd = '/etc/passwd', group = '/etc/group' } = {}) {
  const rows = readFileSync(passwd, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(':'));
  const row = rows.find((fields) => fields[0] === name);
  if (!row) fail(`unknown identity: ${name}`);
  const uid = Number(row[2]);
  const gid = Number(row[3]);
  const gids = new Set([gid]);
  for (const line of readFileSync(group, 'utf8').split('\n')) {
    if (!line) continue;
    const fields = line.split(':');
    const members = (fields[3] ?? '').split(',').filter(Boolean);
    if (members.includes(name)) gids.add(Number(fields[2]));
  }
  return { name, uid, gid, gids: [...gids].sort((a, b) => a - b) };
}

export function identityWith({ uid, gid, gids = [] }) {
  return { uid, gid, gids: [...new Set([gid, ...gids])].sort((a, b) => a - b) };
}

function effectiveBits(stat, identity) {
  if (stat.uid === identity.uid) return { role: 'owner', bits: (stat.mode >> 6) & 7 };
  if (identity.gids.includes(stat.gid)) return { role: 'group', bits: (stat.mode >> 3) & 7 };
  return { role: 'other', bits: stat.mode & 7 };
}

function modeOf(stat) {
  return stat.mode & 0o7777;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Resolves a path without requiring it to exist; refuses a symlinked leaf chain. */
export function isInside(parent, child) {
  const base = resolve(parent) + sep;
  return resolve(child) === resolve(parent) || resolve(child).startsWith(base);
}

export function assertNotHostPath(path, label) {
  for (const hostPath of HOST_READ_ONLY_PATHS) {
    if (isInside(hostPath, path)) fail(`${label} is inside host configuration: ${path}`);
  }
}

/**
 * Every component from `anchor` down to `target` must be a real directory
 * (or, for the leaf, a real file). Symbolic links are refused: a replacement
 * in the middle of a privileged path would redirect a write somewhere else.
 */
export function assertNoSymlinkPath(anchor, target, label) {
  const root = resolve(anchor);
  const leaf = resolve(target);
  if (!isInside(root, leaf)) fail(`${label} escapes ${root}: ${leaf}`);
  let cursor = root;
  for (const part of relative(root, leaf).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') return leaf;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      fail(`${label} traverses a symbolic link at ${cursor}; refusing to write there`);
    }
  }
  return leaf;
}

function assertAllowedRunRoot(runDir) {
  const run = resolve(runDir);
  if (!isAbsolute(runDir)) fail('the matrix run root must be an absolute path');
  if (run === '/' || run === '/tmp' || run === '/var/tmp') fail(`unsafe run root: ${run}`);
  assertNotHostPath(run, 'the matrix run root');
  if (!existsSync(dirname(run))) fail(`the run root parent does not exist: ${dirname(run)}`);
  const parent = realpathSync(dirname(run));
  if (!allowedRunParents().some((allowed) => isInside(allowed, parent))) {
    fail(`the matrix run root must live under ${ALLOWED_RUN_PARENTS.join(', ')}, got ${parent}`);
  }
  return { run, parent };
}

/**
 * Creates or adopts the run root as a root-owned directory the test identity
 * cannot write. An existing matrix-owned root (from a pre-guard run) is
 * adopted by chowning it back; any other owner is refused.
 */
export function prepareRunRoot(runDir, { uid = process.getuid(), adoptUids = [uid] } = {}) {
  const { run, parent } = assertAllowedRunRoot(runDir);
  assertNoSymlinkPath(parent, run, 'the matrix run root');
  let stat = null;
  try {
    stat = lstatSync(run);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!stat) {
    mkdirSync(run, { mode: RUN_ROOT_MODE });
    chmodSync(run, RUN_ROOT_MODE);
  } else {
    if (stat.isSymbolicLink()) fail(`the matrix run root is a symbolic link: ${run}`);
    if (!stat.isDirectory()) fail(`the matrix run root is not a directory: ${run}`);
    if (stat.uid !== uid) {
      if (![...adoptUids, uid].includes(stat.uid)) {
        fail(`the matrix run root is owned by uid ${stat.uid}, expected ${uid}: ${run}`);
      }
      chownSync(run, uid, stat.gid);
      stat = lstatSync(run);
    }
    chmodSync(run, RUN_ROOT_MODE);
  }
  const verified = statSync(run);
  if (verified.uid !== uid) fail(`could not take ownership of the matrix run root: ${run}`);
  if ((modeOf(verified) & 0o022) !== 0) fail(`the matrix run root is group/other writable: ${run}`);
  return { path: run, mode: modeOf(verified), uid: verified.uid, gid: verified.gid };
}

/**
 * Creates or verifies one harness directory. `privateMode` marks the directory
 * as holding privileged bootstrap files: it must be 0700 and owned by `uid`,
 * and root-owned directories additionally drop group access entirely.
 */
export function prepareDir(
  runDir,
  dir,
  { uid = process.getuid(), gid, mode = PRIVATE_DIR_MODE } = {},
) {
  const run = resolve(runDir);
  const target = resolve(dir);
  if (!isInside(run, target)) fail(`directory ${target} is outside the matrix run root ${run}`);
  assertNoSymlinkPath(run, target, `directory ${target}`);
  let stat = null;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!stat) {
    mkdirSync(target, { mode, recursive: false });
  } else {
    if (stat.isSymbolicLink()) fail(`directory ${target} is a symbolic link`);
    if (!stat.isDirectory()) fail(`directory ${target} is not a directory`);
    if (stat.uid !== uid) {
      if (process.getuid() !== 0) {
        fail(`directory ${target} is owned by uid ${stat.uid}, expected ${uid}`);
      }
      chownSync(target, uid, gid ?? stat.gid);
    } else if (gid !== undefined && stat.gid !== gid) {
      if (process.getuid() !== 0) fail(`directory ${target} is owned by gid ${stat.gid}`);
      chownSync(target, -1, gid);
    }
  }
  chmodSync(target, mode);
  const verified = statSync(target);
  if (verified.uid !== uid) fail(`directory ${target} ended up owned by uid ${verified.uid}`);
  if (modeOf(verified) !== mode) {
    fail(
      `directory ${target} has mode ${modeOf(verified).toString(8)}, expected ${mode.toString(8)}`,
    );
  }
  return { path: target, mode: modeOf(verified), uid: verified.uid, gid: verified.gid };
}

function assertSecuredDir(dir, { uid = 0, allowGroupRead = false } = {}) {
  const target = resolve(dir);
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    fail(`the protected directory does not exist: ${target}`);
  }
  if (stat.isSymbolicLink()) fail(`the protected directory is a symbolic link: ${target}`);
  if (!stat.isDirectory()) fail(`the protected path is not a directory: ${target}`);
  if (stat.uid !== uid)
    fail(`the protected directory is owned by uid ${stat.uid}, expected ${uid}`);
  const mode = modeOf(stat);
  if ((mode & 0o022) !== 0) fail(`the protected directory is group/other writable: ${target}`);
  if (!allowGroupRead && (mode & 0o077) !== 0) {
    fail(`the protected directory must be 0700, got ${mode.toString(8)}: ${target}`);
  }
  return { path: target, mode, uid: stat.uid, gid: stat.gid };
}

/**
 * Writes one privileged bootstrap file atomically. The directory is verified
 * on every call, a symbolic-link target is refused rather than followed, and
 * the data lands via a temporary file plus rename so a partial write never
 * becomes the live token.
 */
export function writeSecuredFile(dir, name, content, options = {}) {
  const { uid = process.getuid(), gid, mode = SECRET_FILE_MODE, allowGroupRead = false } = options;
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    fail(`invalid bootstrap file name: ${JSON.stringify(name)}`);
  }
  assertSecuredDir(dir, { uid, allowGroupRead });
  const target = join(resolve(dir), name);
  let existing = null;
  try {
    existing = lstatSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      fail(`refusing to write through the symbolic link ${target}`);
    }
    if (!existing.isFile()) fail(`refusing to replace the non-file ${target}`);
    if (existing.uid !== uid) {
      fail(`bootstrap file ${target} is owned by uid ${existing.uid}, expected ${uid}`);
    }
  }
  const temporary = join(resolve(dir), `.${name}.tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(temporary, 'wx', SECRET_FILE_MODE);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
    chmodSync(target, mode);
    if (gid !== undefined) chownSync(target, uid, gid);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename already consumed the temporary file.
    }
    throw error;
  }
  const verified = lstatSync(target);
  if (verified.isSymbolicLink() || !verified.isFile()) {
    fail(`bootstrap file ${target} is not a regular file after writing`);
  }
  if ((modeOf(verified) & 0o077) !== 0 && !allowGroupRead) {
    fail(`bootstrap file ${target} has mode ${modeOf(verified).toString(8)}`);
  }
  return { path: target, bytes: Buffer.byteLength(content), mode: modeOf(verified) };
}

export function readSecuredFile(
  dir,
  name,
  { uid = process.getuid(), allowGroupRead = false } = {},
) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(`invalid bootstrap file name: ${JSON.stringify(name)}`);
  assertSecuredDir(dir, { uid, allowGroupRead });
  const target = join(resolve(dir), name);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) fail(`refusing to read through the symbolic link ${target}`);
  if (!stat.isFile()) fail(`not a regular bootstrap file: ${target}`);
  return readFileSync(target, 'utf8');
}

export function removeSecuredFile(
  dir,
  name,
  { uid = process.getuid(), allowGroupRead = false } = {},
) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(`invalid bootstrap file name: ${JSON.stringify(name)}`);
  assertSecuredDir(dir, { uid, allowGroupRead });
  const target = join(resolve(dir), name);
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isDirectory()) fail(`refusing to remove the directory ${target} as a bootstrap file`);
  unlinkSync(target);
  return true;
}

/**
 * Empties a directory the test identity owns (scratch state or stale bridge
 * credentials) without ever following a link out of it. `rmSync` removes a
 * symbolic link itself rather than its target, which is what we want.
 */
export function cleanOwnedDir(dir, { uid, gid }) {
  const target = resolve(dir);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) fail(`refusing to clean the symbolic link ${target}`);
  if (!stat.isDirectory()) fail(`not a directory: ${target}`);
  if (uid !== undefined && stat.uid !== uid) {
    fail(`refusing to clean ${target}: owned by uid ${stat.uid}, expected ${uid}`);
  }
  if (gid !== undefined && stat.gid !== gid) {
    fail(`refusing to clean ${target}: owned by gid ${stat.gid}, expected ${gid}`);
  }
  if ((modeOf(stat) & 0o022) !== 0) fail(`refusing to clean a writable directory: ${target}`);
  let removed = 0;
  for (const entry of readdirSync(target)) {
    rmSync(join(target, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Resolves what the identity can do to one path, walking every ancestor: a
 * writable parent is enough to replace the entry inside it, so the audit must
 * not stop at the leaf file.
 */
export function accessPath(identity, path) {
  const chain = [];
  let current = resolve(path);
  for (;;) {
    let stat = null;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (stat) {
      const { role, bits } = effectiveBits(stat, identity);
      chain.push({
        path: current,
        role,
        mode: modeOf(stat),
        symlink: stat.isSymbolicLink(),
        sticky: (modeOf(stat) & 0o1000) !== 0,
        write: (bits & 2) !== 0,
        read: (bits & 4) !== 0,
        execute: (bits & 1) !== 0,
      });
    } else {
      chain.push({ path: current, missing: true, write: false, read: false, execute: false });
    }
    if (current === '/') break;
    current = dirname(current);
  }
  const [leaf, ...ancestors] = chain;
  // A sticky ancestor lets the identity create new names but not replace an
  // entry it does not own (the `/tmp` case). Only the leaf and non-sticky
  // ancestors count as a replacement capability.
  const writable =
    chain.find((entry, index) => !entry.missing && entry.write && (index === 0 || !entry.sticky)) ??
    null;
  const reachable = ancestors.every((entry) => !entry.missing && entry.execute);
  return {
    path: resolve(path),
    chain,
    writable,
    readable: !leaf.missing && leaf.read && reachable,
    reachable,
  };
}

export function auditHost({
  identity,
  paths = HOST_READ_ONLY_PATHS,
  secretPaths = HOST_SECRET_PATHS,
}) {
  const writeViolations = [];
  for (const path of paths) {
    const access = accessPath(identity, path);
    if (access.writable) {
      writeViolations.push({ path, at: access.writable.path, role: access.writable.role });
    }
  }
  const readViolations = [];
  for (const path of secretPaths) {
    if (accessPath(identity, path).readable) readViolations.push({ path });
  }
  return { identity, writeViolations, readViolations };
}

export function assertNoHostWrite({
  identity,
  paths = HOST_READ_ONLY_PATHS,
  secretPaths = HOST_SECRET_PATHS,
}) {
  const audit = auditHost({ identity, paths, secretPaths });
  if (audit.writeViolations.length > 0) {
    const details = audit.writeViolations
      .map((entry) => `${entry.path} (write via ${entry.at}, ${entry.role})`)
      .join('; ');
    fail(`the matrix identity ${identity.name} can write host configuration: ${details}`);
  }
  if (audit.readViolations.length > 0) {
    const details = audit.readViolations.map((entry) => entry.path).join('; ');
    fail(`the matrix identity ${identity.name} can read shared credentials: ${details}`);
  }
  return audit;
}

/** Refuses a copy of the host agent key, including a renamed byte-for-byte copy. */
export function assertDedicatedSshKey({
  keyPath,
  hostKeyDir = '/root/.ssh',
  uid = process.getuid(),
  gid,
}) {
  const target = resolve(keyPath);
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    fail(`the matrix SSH key does not exist: ${target}`);
  }
  if (stat.isSymbolicLink()) fail(`the matrix SSH key is a symbolic link: ${target}`);
  if (!stat.isFile()) fail(`the matrix SSH key is not a regular file: ${target}`);
  if (stat.uid !== uid && stat.uid !== 0) {
    fail(`the matrix SSH key is owned by uid ${stat.uid}, expected ${uid} or root`);
  }
  if (gid !== undefined && stat.gid !== gid) {
    fail(`the matrix SSH key is owned by gid ${stat.gid}, expected ${gid}`);
  }
  const mode = modeOf(stat);
  if ((mode & 0o077) !== 0) fail(`the matrix SSH key must be 0600, got ${mode.toString(8)}`);
  if (
    hostKeyDir &&
    existsSync(hostKeyDir) &&
    isInside(realpathSync(hostKeyDir), realpathSync(target))
  ) {
    fail(`the matrix SSH key lives in the host key directory: ${target}`);
  }
  const digest = hashFile(target);
  if (hostKeyDir && existsSync(hostKeyDir)) {
    for (const entry of readdirSync(hostKeyDir)) {
      const candidate = join(hostKeyDir, entry);
      let candidateStat;
      try {
        candidateStat = statSync(candidate);
      } catch {
        continue;
      }
      if (!candidateStat.isFile()) continue;
      if (hashFile(candidate) === digest) {
        fail(
          `the matrix SSH key is a copy of the host key ${candidate}; provision a dedicated key instead`,
        );
      }
    }
  }
  return { path: target, sha256: digest.slice(0, 16), mode };
}

/** Refuses the shared gh-agent token configuration and requires a dedicated one. */
export function assertDedicatedGhConfig({
  configDir,
  hostsFile,
  hostConfigDirs = ['/root/.config/gh-agent'],
  uid = process.getuid(),
  requireGroupRead = true,
}) {
  const target = resolve(configDir);
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    fail(`the matrix gh config does not exist: ${target}`);
  }
  if (stat.isSymbolicLink()) fail(`the matrix gh config is a symbolic link: ${target}`);
  if (!stat.isDirectory()) fail(`the matrix gh config is not a directory: ${target}`);
  if (stat.uid !== uid && stat.uid !== 0) {
    fail(`the matrix gh config is owned by uid ${stat.uid}, expected ${uid} or root`);
  }
  for (const hostConfig of hostConfigDirs) {
    if (isInside(hostConfig, target)) {
      fail(`the matrix gh config reuses the shared gh configuration ${hostConfig}: ${target}`);
    }
  }
  if ((modeOf(stat) & 0o022) !== 0) fail(`the matrix gh config is group/other writable: ${target}`);
  if (requireGroupRead && (modeOf(stat) & 0o040) === 0) {
    fail(`the matrix gh config must be group readable for the services: ${target}`);
  }
  const hosts = resolve(hostsFile ?? join(target, 'hosts.yml'));
  let hostsStat;
  try {
    hostsStat = lstatSync(hosts);
  } catch {
    fail(`the matrix gh hosts file does not exist: ${hosts}`);
  }
  if (hostsStat.isSymbolicLink()) fail(`the matrix gh hosts file is a symbolic link: ${hosts}`);
  if (!hostsStat.isFile()) fail(`the matrix gh hosts file is missing: ${hosts}`);
  if ((modeOf(hostsStat) & 0o022) !== 0) fail(`the matrix gh hosts file is group/other writable`);
  const text = readFileSync(hosts, 'utf8');
  if (!/^\s*oauth_token:\s*\S+/m.test(text)) {
    fail(`the matrix gh hosts file carries no token: ${hosts}`);
  }
  for (const hostConfig of hostConfigDirs) {
    if (isInside(hostConfig, hosts)) fail(`the matrix gh hosts file is the shared one: ${hosts}`);
  }
  return { path: target, hosts, tokenPresent: true };
}

/**
 * Host-path facts for the precheck: never resolves file content except to hash
 * public material, and never returns a token.
 */
export function describePath(path) {
  try {
    const stat = lstatSync(path);
    return {
      path,
      exists: true,
      symlink: stat.isSymbolicLink(),
      directory: stat.isDirectory(),
      uid: stat.uid,
      gid: stat.gid,
      mode: modeOf(stat).toString(8).padStart(4, '0'),
    };
  } catch {
    return { path, exists: false };
  }
}

/** Scrubs a token-looking value before it reaches a log. */
export function redact(value) {
  return String(value)
    .replace(/(oauth_token:\s*)\S+/gi, '$1***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .replace(/(TOKEN=)\S+/gi, '$1***')
    .replace(/(gh[pousr]_[A-Za-z0-9_]{10,})/g, '***');
}

export function layoutFor(runDir, env = process.env) {
  const run = resolve(runDir ?? env.M5B_MATRIX_RUN ?? '/tmp/m5bmatrix');
  const pick = (key, fallback) => env[key] ?? join(run, fallback);
  return {
    run,
    protectedDir: pick('M5B_MATRIX_PROTECTED', DEFAULT_LAYOUT.protected),
    configDir: pick('M5B_MATRIX_CONFIG', DEFAULT_LAYOUT.config),
    scratchDir: pick('M5B_MATRIX_TMP', DEFAULT_LAYOUT.scratch),
    credentialsDir: pick('M5B_MATRIX_CREDENTIALS', DEFAULT_LAYOUT.credentials),
    instanceEnvDir: pick('M5B_MATRIX_INSTANCE_ENV', DEFAULT_LAYOUT.instanceEnv),
    instanceLogsDir: pick('M5B_MATRIX_INSTANCE_LOGS', DEFAULT_LAYOUT.instanceLogs),
    worktreesDir: pick('M5B_MATRIX_WORKTREES', DEFAULT_LAYOUT.worktrees),
    dshHome: pick('M5B_MATRIX_DSH_HOME', DEFAULT_LAYOUT.dshHome),
    stageDir: pick('M5B_MATRIX_STAGE', DEFAULT_LAYOUT.stage),
    logsDir: pick('M5B_MATRIX_LOGS', DEFAULT_LAYOUT.logs),
  };
}

/* ------------------------------------------------------------------ CLI -- */

function identityFromFlags(flags) {
  if (flags.user) return resolveUser(flags.user);
  const uid = flags.uid === undefined ? process.getuid() : Number(flags.uid);
  const gid = flags.gid === undefined ? process.getgid() : Number(flags.gid);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) fail('--uid/--gid must be integers');
  return { name: `uid:${uid}`, uid, gid, gids: [gid] };
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

export function prepareLayout(runDir, user, env = process.env) {
  const layout = layoutFor(runDir, env);
  const rootUid = process.getuid();
  prepareRunRoot(layout.run, { uid: rootUid, adoptUids: [user.uid] });
  prepareDir(layout.run, layout.protectedDir, { uid: rootUid, mode: PRIVATE_DIR_MODE });
  prepareDir(layout.run, layout.configDir, {
    uid: rootUid,
    gid: user.gid,
    mode: SHARED_CONFIG_DIR_MODE,
  });
  prepareDir(layout.run, layout.stageDir, { uid: rootUid, mode: PRIVATE_DIR_MODE });
  prepareDir(layout.run, layout.logsDir, { uid: rootUid, mode: RUN_ROOT_MODE });
  for (const dir of [
    layout.scratchDir,
    layout.credentialsDir,
    layout.instanceEnvDir,
    layout.instanceLogsDir,
    layout.worktreesDir,
    layout.dshHome,
  ]) {
    prepareDir(layout.run, dir, { uid: user.uid, gid: user.gid, mode: PRIVATE_DIR_MODE });
  }
  return layout;
}

export function checkLayout(runDir, user, env = process.env) {
  const layout = layoutFor(runDir, env);
  const rootUid = process.getuid();
  const run = prepareRunRoot(layout.run, { uid: rootUid, adoptUids: [rootUid, user.uid] });
  for (const dir of [layout.protectedDir, layout.stageDir]) {
    assertSecuredDir(dir, { uid: rootUid });
  }
  assertSecuredDir(layout.configDir, { uid: rootUid, allowGroupRead: true });
  prepareDir(layout.run, layout.logsDir, { uid: rootUid, mode: RUN_ROOT_MODE });
  for (const dir of [
    layout.scratchDir,
    layout.credentialsDir,
    layout.instanceEnvDir,
    layout.instanceLogsDir,
    layout.worktreesDir,
    layout.dshHome,
  ]) {
    prepareDir(layout.run, dir, { uid: user.uid, gid: user.gid, mode: PRIVATE_DIR_MODE });
  }
  return { run, layout };
}

function main(argv) {
  const [command, ...rest] = argv;
  const flags = parseArgs(rest);
  const env = process.env;
  const layout = layoutFor(flags.run, env);
  const user = identityFromFlags(flags);

  switch (command) {
    case 'prepare-run': {
      const layoutValue = prepareLayout(flags.run, user, env);
      console.log(
        `run_root=${layoutValue.run} mode=${RUN_ROOT_MODE.toString(8)} uid=${process.getuid()}`,
      );
      console.log(`protected=${layoutValue.protectedDir} mode=0700 uid=${process.getuid()}`);
      console.log(
        `config=${layoutValue.configDir} mode=0750 uid=${process.getuid()} gid=${user.gid}`,
      );
      console.log(
        `owned=${layoutValue.scratchDir},${layoutValue.credentialsDir},${layoutValue.dshHome} uid=${user.uid} gid=${user.gid}`,
      );
      return 0;
    }
    case 'check-run': {
      const { run } = checkLayout(flags.run, user, env);
      console.log(`run_root=${run.path} mode=${run.mode.toString(8)}`);
      console.log('layout=verified');
      return 0;
    }
    case 'prepare-pgdata': {
      if (!flags.dir) fail('--dir is required');
      const dataUser = identityFromFlags(flags);
      prepareDir(layout.run, flags.dir, {
        uid: dataUser.uid,
        gid: dataUser.gid,
        mode: PRIVATE_DIR_MODE,
      });
      console.log(`pgdata=${resolve(flags.dir)} mode=0700 uid=${dataUser.uid} gid=${dataUser.gid}`);
      return 0;
    }
    case 'write-protected': {
      if (!flags.dir || !flags.name) fail('--dir and --name are required');
      const result = writeSecuredFile(flags.dir, flags.name, readFileSync(0, 'utf8'), {
        uid: process.getuid(),
        mode: SECRET_FILE_MODE,
      });
      console.log(`wrote=${result.path} bytes=${result.bytes} mode=0600`);
      return 0;
    }
    case 'write-config': {
      if (!flags.dir || !flags.name) fail('--dir and --name are required');
      const result = writeSecuredFile(flags.dir, flags.name, readFileSync(0, 'utf8'), {
        uid: process.getuid(),
        gid: user.gid,
        mode: SHARED_CONFIG_FILE_MODE,
        allowGroupRead: true,
      });
      console.log(`wrote=${result.path} bytes=${result.bytes} mode=0640 gid=${user.gid}`);
      return 0;
    }
    case 'read-protected': {
      if (!flags.dir || !flags.name) fail('--dir and --name are required');
      process.stdout.write(readSecuredFile(flags.dir, flags.name, { uid: process.getuid() }));
      return 0;
    }
    case 'remove-protected': {
      if (!flags.dir || !flags.name) fail('--dir and --name are required');
      const removed = removeSecuredFile(flags.dir, flags.name, { uid: process.getuid() });
      console.log(removed ? `removed=${join(flags.dir, flags.name)}` : 'removed=none');
      return 0;
    }
    case 'clean-owned': {
      if (!flags.dir) fail('--dir is required');
      const removed = cleanOwnedDir(flags.dir, { uid: user.uid, gid: user.gid });
      console.log(`cleaned=${resolve(flags.dir)} entries=${removed}`);
      return 0;
    }
    case 'audit-host': {
      const paths = flags.path ? String(flags.path).split(',') : HOST_READ_ONLY_PATHS;
      const secretPaths = flags.secret ? String(flags.secret).split(',') : HOST_SECRET_PATHS;
      const audit = auditHost({ identity: user, paths, secretPaths });
      for (const path of paths) {
        const fact = describePath(path);
        console.log(`path ${fact.path} mode=${fact.mode ?? 'missing'}`);
      }
      for (const entry of audit.writeViolations) {
        console.log(`WRITE ${entry.path} via ${entry.at} (${entry.role})`);
      }
      for (const entry of audit.readViolations) console.log(`READ ${entry.path}`);
      if (audit.writeViolations.length === 0 && audit.readViolations.length === 0) {
        console.log('host_boundary=clean');
      }
      return audit.writeViolations.length === 0 && audit.readViolations.length === 0 ? 0 : 1;
    }
    case 'audit-credentials': {
      if (!flags['ssh-key'] || !flags['gh-config']) fail('--ssh-key and --gh-config are required');
      const key = assertDedicatedSshKey({
        keyPath: flags['ssh-key'],
        hostKeyDir: flags['host-key-dir'] ?? '/root/.ssh',
        uid: user.uid,
      });
      const gh = assertDedicatedGhConfig({
        configDir: flags['gh-config'],
        hostsFile: flags['gh-hosts'],
        hostConfigDirs: (flags['host-gh-config'] ?? '/root/.config/gh-agent').split(','),
        uid: user.uid,
      });
      console.log(`ssh_key=${key.path} sha256=${key.sha256} mode=${key.mode.toString(8)}`);
      console.log(`gh_config=${gh.path} hosts=${gh.hosts} token=present`);
      console.log('credentials=dedicated');
      return 0;
    }
    case 'describe': {
      if (!flags.path) fail('--path is required');
      console.log(JSON.stringify(describePath(flags.path)));
      return 0;
    }
    default:
      console.error(
        [
          'usage: node guard.mjs <command> [flags]',
          '  prepare-run --run DIR --user NAME',
          '  check-run --run DIR --user NAME',
          '  prepare-pgdata --run DIR --dir DIR [--user NAME]',
          '  write-protected --dir DIR --name NAME < content',
          '  write-config --dir DIR --name NAME --user NAME < content',
          '  read-protected --dir DIR --name NAME',
          '  remove-protected --dir DIR --name NAME',
          '  clean-owned --dir DIR --user NAME',
          '  audit-host --user NAME [--path LIST] [--secret LIST]',
          '  audit-credentials --user NAME --ssh-key PATH --gh-config DIR',
        ].join('\n'),
      );
      return 2;
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const self = resolve(fileURLToPath(import.meta.url));
if (entry === self) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof IsolationGuardError) {
      console.error(`guard: FAIL: ${redact(error.message)}`);
      process.exitCode = 1;
    } else {
      console.error(`guard: ERROR: ${redact(error?.stack ?? error)}`);
      process.exitCode = 1;
    }
  }
}
