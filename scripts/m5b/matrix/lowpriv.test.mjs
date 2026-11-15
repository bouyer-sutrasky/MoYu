import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL, fileURLToPath } from 'node:url';

import {
  LowPrivError,
  chmodOwnedPath,
  mkdirOwned,
  removeOwnedPath,
  writeOwnedFile,
} from './lowpriv.mjs';

const LOWPRIV = fileURLToPath(new URL('./lowpriv.mjs', import.meta.url));
const currentUser = userInfo().username;

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'm5b-lowpriv-'));
}

function sentinelFacts(path) {
  const stat = statSync(path);
  return {
    content: readFileSync(path, 'utf8'),
    mode: stat.mode & 0o777,
    uid: stat.uid,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function assertFails(fn, pattern) {
  assert.throws(fn, (error) => error instanceof LowPrivError && pattern.test(error.message));
}

test('a write replaces a pre-created leaf symlink without touching its target', () => {
  const root = sandbox();
  const dir = join(root, 'owned');
  mkdirSync(dir, { mode: 0o700 });
  const sentinel = join(root, 'host-sentinel');
  writeFileSync(sentinel, 'HOST-SENTINEL\n');
  chmodSync(sentinel, 0o600);
  const before = sentinelFacts(sentinel);
  symlinkSync(sentinel, join(dir, 'config'));
  writeOwnedFile(dir, 'config', 'IDENTITY-CONFIG\n', { mode: 0o600 });
  const after = sentinelFacts(sentinel);
  assert.deepEqual(after, before);
  const written = lstatSync(join(dir, 'config'));
  assert.equal(written.isSymbolicLink(), false);
  assert.equal(written.mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, 'config'), 'utf8'), 'IDENTITY-CONFIG\n');
  rmSync(root, { recursive: true, force: true });
});

test('repeated writes are idempotent and stay 0600', () => {
  const root = sandbox();
  const dir = join(root, 'owned');
  mkdirSync(dir, { mode: 0o700 });
  for (const value of ['first', 'second', 'third']) {
    writeOwnedFile(dir, 'state', value);
    assert.equal(lstatSync(join(dir, 'state')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, 'state'), 'utf8'), value);
  }
  rmSync(root, { recursive: true, force: true });
});

test('a write refuses a symlinked destination directory', () => {
  const root = sandbox();
  const real = join(root, 'real');
  mkdirSync(real);
  const link = join(root, 'owned');
  symlinkSync(real, link);
  const sentinel = join(root, 'host-sentinel');
  writeFileSync(sentinel, 'HOST-SENTINEL\n');
  const before = sentinelFacts(sentinel);
  assertFails(() => writeOwnedFile(link, 'config', 'x'), /symbolic link/);
  assert.deepEqual(sentinelFacts(sentinel), before);
  assert.equal(existsSync(join(real, 'config')), false);
  rmSync(root, { recursive: true, force: true });
});

test('remove unlinks a symlink itself and never its target', () => {
  const root = sandbox();
  const sentinel = join(root, 'host-sentinel');
  writeFileSync(sentinel, 'HOST-SENTINEL\n');
  const before = sentinelFacts(sentinel);
  const link = join(root, 'owned-link');
  symlinkSync(sentinel, link);
  assert.equal(removeOwnedPath(root, link), true);
  assert.equal(existsSync(link), false);
  assert.deepEqual(sentinelFacts(sentinel), before);
  rmSync(root, { recursive: true, force: true });
});

test('remove and chmod refuse paths outside the owned root', () => {
  const root = sandbox();
  const outside = mkdtempSync(join(tmpdir(), 'm5b-lowpriv-outside-'));
  const sentinel = join(outside, 'host-sentinel');
  writeFileSync(sentinel, 'HOST-SENTINEL\n');
  const before = sentinelFacts(sentinel);
  assertFails(() => removeOwnedPath(root, sentinel), /outside/);
  assertFails(() => chmodOwnedPath(root, sentinel, 0o644), /outside/);
  assert.deepEqual(sentinelFacts(sentinel), before);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('chmod refuses a symbolic link instead of following it', () => {
  const root = sandbox();
  const sentinel = join(root, 'host-sentinel');
  writeFileSync(sentinel, 'HOST-SENTINEL\n');
  chmodSync(sentinel, 0o600);
  const before = sentinelFacts(sentinel);
  const link = join(root, 'owned-link');
  symlinkSync(sentinel, link);
  assertFails(() => chmodOwnedPath(root, link, 0o644), /symbolic link/);
  assert.deepEqual(sentinelFacts(sentinel), before);
  rmSync(root, { recursive: true, force: true });
});

test('mkdir refuses a symlinked directory', () => {
  const root = sandbox();
  const real = join(root, 'real');
  mkdirSync(real);
  const link = join(root, 'owned');
  symlinkSync(real, link);
  assertFails(() => mkdirOwned(link), /symbolic link/);
  rmSync(root, { recursive: true, force: true });
});

test('CLI: write/mkdir/remove run as the requested current user', () => {
  const root = sandbox();
  const dir = join(root, 'owned');
  const mkdir = spawnSync(
    process.execPath,
    [LOWPRIV, 'mkdir', '--user', currentUser, '--dir', dir, '--mode', '700'],
    { encoding: 'utf8' },
  );
  assert.equal(mkdir.status, 0, mkdir.stderr);
  const sentinel = join(root, 'host-sentinel');
  writeFileSync(sentinel, 'HOST-SENTINEL\n');
  const before = sentinelFacts(sentinel);
  symlinkSync(sentinel, join(dir, 'config'));
  const write = spawnSync(
    process.execPath,
    [LOWPRIV, 'write', '--user', currentUser, '--dir', dir, '--name', 'config'],
    { encoding: 'utf8', input: 'IDENTITY-CONFIG\n' },
  );
  assert.equal(write.status, 0, write.stderr);
  assert.deepEqual(sentinelFacts(sentinel), before);
  const remove = spawnSync(
    process.execPath,
    [LOWPRIV, 'remove', '--user', currentUser, '--root', dir, '--path', join(dir, 'config')],
    { encoding: 'utf8' },
  );
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(existsSync(join(dir, 'config')), false);
  rmSync(root, { recursive: true, force: true });
});
