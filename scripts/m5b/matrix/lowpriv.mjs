#!/usr/bin/env node
/**
 * Operations inside a directory the low-privilege test identity owns must run
 * *as that identity*, never as root: a root write (or chmod) that follows a
 * symlink the identity pre-created turns into a host-file write.
 *
 * This helper is the only writer for those paths. The caller pipes data in on
 * stdin; the helper (re-executed through `runuser` when it has to become the
 * target identity) creates a `wx` temporary file in the verified destination
 * directory and renames it over the target. `rename(2)` replaces a pre-created
 * symbolic link instead of following it, and a failed write leaves the link
 * (and anything it pointed at) untouched.
 *
 * Commands:
 *   mkdir  --user NAME --dir PATH [--mode 700]
 *   write  --user NAME --dir PATH --name NAME [--mode 600]   < content
 *   remove --user NAME --root PATH --path PATH [--path PATH ...]
 *   chmod  --user NAME --root PATH --path PATH --mode 600
 *
 * When the requested user is the current user the operation runs in-process; a
 * test can therefore exercise the exact write/rename semantics without root.
 */
import { Buffer } from 'node:buffer';
import { userInfo } from 'node:os';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class LowPrivError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LowPrivError';
  }
}

function fail(message) {
  throw new LowPrivError(message);
}

function assertRealDirectory(path, label = 'directory') {
  const target = resolve(path);
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    fail(`${label} does not exist: ${target}`);
  }
  if (stat.isSymbolicLink()) fail(`${label} is a symbolic link: ${target}`);
  if (!stat.isDirectory()) fail(`${label} is not a directory: ${target}`);
  return target;
}

export function mkdirOwned(path, { mode = 0o700 } = {}) {
  const target = resolve(path);
  let stat = null;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!stat) {
    mkdirSync(target, { recursive: false, mode });
  } else {
    assertRealDirectory(target);
  }
  chmodSync(target, mode);
  const verified = lstatSync(target);
  if (verified.isSymbolicLink() || !verified.isDirectory()) fail(`not a directory: ${target}`);
  return { path: target, mode: verified.mode & 0o777 };
}

export function writeOwnedFile(dir, name, content, { mode = 0o600 } = {}) {
  const directory = assertRealDirectory(dir);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    fail(`invalid file name: ${JSON.stringify(name)}`);
  }
  const target = join(directory, name);
  const temporary = join(
    directory,
    `.${name}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // rename replaces the directory entry: a pre-created symlink is not followed.
    renameSync(temporary, target);
    chmodSync(target, mode);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // rename already consumed the temporary file
    }
    throw error;
  }
  const verified = lstatSync(target);
  if (verified.isSymbolicLink() || !verified.isFile()) fail(`not a regular file: ${target}`);
  if ((verified.mode & 0o077) !== 0) fail(`file ${target} is group/other accessible`);
  return { path: target, bytes: Buffer.byteLength(content), mode: verified.mode & 0o777 };
}

export function removeOwnedPath(root, path) {
  const base = resolve(root);
  const target = resolve(path);
  const basePrefix = base.endsWith('/') ? base : `${base}/`;
  if (target !== base && !target.startsWith(basePrefix)) {
    fail(`refusing to remove ${target}: outside ${base}`);
  }
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  // rmSync unlinks a symbolic link itself and never recurses through it.
  rmSync(target, { recursive: stat.isDirectory(), force: true });
  return true;
}

export function chmodOwnedPath(root, path, mode) {
  const base = resolve(root);
  const target = resolve(path);
  if (!target.startsWith(`${base}/`)) fail(`refusing to chmod ${target}: outside ${base}`);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) fail(`refusing to chmod through the symbolic link ${target}`);
  chmodSync(target, mode);
  return { path: target, mode: lstatSync(target).mode & 0o777 };
}

function parseArgs(argv) {
  const flags = { path: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (key === 'path') {
      if (next === undefined) fail('--path needs a value');
      flags.path.push(next);
      index += 1;
      continue;
    }
    if (next === undefined || next.startsWith('--')) fail(`--${key} needs a value`);
    flags[key] = next;
    index += 1;
  }
  return flags;
}

function run(argv) {
  const [command, ...rest] = argv;
  const flags = parseArgs(rest);
  const user = flags.user;
  if (!user) fail('--user is required');
  const current = userInfo().username;
  if (user !== current) {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      fail(`cannot switch from ${current} to ${user}; run as root`);
    }
    const self = fileURLToPath(import.meta.url);
    const input = command === 'write' ? readFileSync(0) : undefined;
    const child = spawnSync(
      'runuser',
      ['-u', user, '--', process.execPath, self, command, ...rest],
      {
        input,
        stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      },
    );
    if (child.error) fail(`could not run as ${user}: ${child.error.message}`);
    if (child.signal) fail(`run as ${user} was killed by ${child.signal}`);
    process.exitCode = child.status ?? 1;
    return;
  }
  switch (command) {
    case 'mkdir': {
      if (!flags.dir) fail('--dir is required');
      const mode = flags.mode === undefined ? 0o700 : Number.parseInt(flags.mode, 8);
      const result = mkdirOwned(flags.dir, { mode });
      console.log(`mkdir=${result.path} mode=${result.mode.toString(8)}`);
      return;
    }
    case 'write': {
      if (!flags.dir || !flags.name) fail('--dir and --name are required');
      const mode = flags.mode === undefined ? 0o600 : Number.parseInt(flags.mode, 8);
      const content = readFileSync(0);
      const result = writeOwnedFile(flags.dir, flags.name, content, { mode });
      console.log(`wrote=${result.path} bytes=${result.bytes} mode=${result.mode.toString(8)}`);
      return;
    }
    case 'remove': {
      if (!flags.root) fail('--root is required');
      if (flags.path.length === 0) fail('--path is required');
      let removed = 0;
      for (const path of flags.path) {
        if (removeOwnedPath(flags.root, path)) removed += 1;
      }
      console.log(`removed=${removed}`);
      return;
    }
    case 'chmod': {
      if (!flags.root || !flags.path[0]) fail('--root and --path are required');
      const mode = flags.mode === undefined ? 0o600 : Number.parseInt(flags.mode, 8);
      const result = chmodOwnedPath(flags.root, flags.path[0], mode);
      console.log(`chmod=${result.path} mode=${result.mode.toString(8)}`);
      return;
    }
    default:
      fail(`unknown command: ${command}`);
  }
}

if (
  isAbsolute(process.argv[1] ?? '') &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LowPrivError) {
      console.error(`lowpriv: FAIL: ${error.message}`);
      process.exitCode = 1;
    } else {
      console.error(`lowpriv: ERROR: ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }
}
