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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL, fileURLToPath } from 'node:url';

import {
  IsolationGuardError,
  accessPath,
  assertDedicatedGhConfig,
  assertDedicatedSshKey,
  auditHost,
  cleanOwnedDir,
  describePath,
  prepareDir,
  prepareLayout,
  prepareRunRoot,
  readSecuredFile,
  redact,
  resolveUser,
  writeSecuredFile,
} from './guard.mjs';

const GUARD = fileURLToPath(new URL('./guard.mjs', import.meta.url));
const uid = process.getuid();
const gid = process.getgid();
const identity = { name: 'fixture-identity', uid, gid, gids: [gid] };

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'm5b-guard-'));
}

function modeOf(path) {
  return lstatSync(path).mode & 0o777;
}

function guardCli(args, options = {}) {
  return spawnSync(process.execPath, [GUARD, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function assertFails(fn, pattern) {
  assert.throws(fn, (error) => error instanceof IsolationGuardError && pattern.test(error.message));
}

test('prepareLayout makes a root-owned run directory with a private protected area', () => {
  const run = sandbox();
  const layout = prepareLayout(run, identity, {});
  assert.equal(lstatSync(run).uid, uid);
  assert.equal(modeOf(run), 0o755);
  assert.equal(modeOf(layout.protectedDir), 0o700);
  assert.equal(modeOf(layout.configDir), 0o750);
  assert.equal(lstatSync(layout.configDir).gid, gid);
  assert.equal(modeOf(layout.scratchDir), 0o700);
  assert.equal(modeOf(layout.credentialsDir), 0o700);
  assert.equal(modeOf(layout.dshHome), 0o700);
  assert.equal(lstatSync(layout.protectedDir).uid, uid);
  rmSync(run, { recursive: true, force: true });
});

test('a rerun keeps the protected files at 0600 and reads the same value', () => {
  const run = sandbox();
  const layout = prepareLayout(run, identity, {});
  writeSecuredFile(layout.protectedDir, 'supervisor-token', 'first-token');
  writeSecuredFile(layout.protectedDir, 'supervisor-token', 'second-token');
  assert.equal(modeOf(join(layout.protectedDir, 'supervisor-token')), 0o600);
  assert.equal(readSecuredFile(layout.protectedDir, 'supervisor-token'), 'second-token');
  prepareLayout(run, identity, {});
  assert.equal(readSecuredFile(layout.protectedDir, 'supervisor-token'), 'second-token');
  rmSync(run, { recursive: true, force: true });
});

test('refuses a symbolic-link bootstrap file and leaves its target untouched', () => {
  const run = sandbox();
  const elsewhere = sandbox();
  const layout = prepareLayout(run, identity, {});
  const sentinel = join(elsewhere, 'host-file');
  writeFileSync(sentinel, 'host content\n');
  symlinkSync(sentinel, join(layout.protectedDir, 'supervisor-token'));
  assertFails(
    () => writeSecuredFile(layout.protectedDir, 'supervisor-token', 'replaced'),
    /symbolic link/,
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'host content\n');
  rmSync(run, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test('refuses a symbolic-link protected directory', () => {
  const run = sandbox();
  const elsewhere = sandbox();
  const layout = prepareLayout(run, identity, {});
  rmSync(layout.protectedDir, { recursive: true, force: true });
  symlinkSync(elsewhere, layout.protectedDir);
  assertFails(
    () => writeSecuredFile(layout.protectedDir, 'supervisor-token', 'token'),
    /symbolic link/,
  );
  assert.equal(existsSync(join(elsewhere, 'supervisor-token')), false);
  rmSync(run, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test('refuses a group-writable protected directory', () => {
  const run = sandbox();
  const layout = prepareLayout(run, identity, {});
  chmodSync(layout.protectedDir, 0o770);
  assertFails(
    () => writeSecuredFile(layout.protectedDir, 'supervisor-token', 'token'),
    /group\/other writable/,
  );
  rmSync(run, { recursive: true, force: true });
});

test('cleanOwnedDir removes entries but never follows a link out of the directory', () => {
  const run = sandbox();
  const elsewhere = sandbox();
  const layout = prepareLayout(run, identity, {});
  const sentinel = join(elsewhere, 'host-file');
  writeFileSync(sentinel, 'host content\n');
  writeFileSync(join(layout.scratchDir, 'worker-delay.txt'), '10\n');
  symlinkSync(sentinel, join(layout.scratchDir, 'linked'));
  assert.equal(cleanOwnedDir(layout.scratchDir, { uid, gid }), 2);
  assert.equal(existsSync(sentinel), true);
  assert.equal(readFileSync(sentinel, 'utf8'), 'host content\n');
  rmSync(run, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test('refuses to clean a directory owned by another identity', () => {
  const run = sandbox();
  const layout = prepareLayout(run, identity, {});
  assertFails(() => cleanOwnedDir(layout.scratchDir, { uid: uid + 100000, gid }), /owned by uid/);
  rmSync(run, { recursive: true, force: true });
});

test('auditHost flags group-writable host configuration and readable secrets', () => {
  const root = sandbox();
  chmodSync(root, 0o711);
  const traverseOnly = join(root, 'dsh-home');
  const sharedWrite = join(root, 'gh-agent');
  mkdirSync(traverseOnly);
  mkdirSync(sharedWrite);
  chmodSync(traverseOnly, 0o710);
  chmodSync(sharedWrite, 0o770);
  const secret = join(sharedWrite, 'hosts.yml');
  writeFileSync(secret, 'oauth_token: top-secret\n');
  chmodSync(secret, 0o640);
  const outsider = { name: 'outsider', uid: uid + 100000, gid, gids: [gid] };
  const audit = auditHost({
    identity: outsider,
    paths: [root, traverseOnly, sharedWrite],
    secretPaths: [secret],
  });
  assert.deepEqual(
    audit.writeViolations.map((entry) => entry.path),
    [sharedWrite],
  );
  assert.deepEqual(
    audit.readViolations.map((entry) => entry.path),
    [secret],
  );
  assert.equal(accessPath(outsider, traverseOnly).writable, null);
  rmSync(root, { recursive: true, force: true });
});

test('auditHost reports a clean boundary for traverse-only grants', () => {
  const root = sandbox();
  chmodSync(root, 0o711);
  const readOnly = join(root, 'repo');
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o750);
  const clean = auditHost({
    identity: { name: 'outsider', uid: uid + 100000, gid, gids: [gid] },
    paths: [root, readOnly],
    secretPaths: [],
  });
  assert.deepEqual(clean.writeViolations, []);
  rmSync(root, { recursive: true, force: true });
});

test('refuses a copy of the host agent key even when it is renamed', () => {
  const root = sandbox();
  const hostKeyDir = join(root, 'host-keys');
  const matrix = join(root, 'matrix');
  mkdirSync(hostKeyDir);
  mkdirSync(matrix);
  const hostKey = join(hostKeyDir, 'sa_agent2');
  writeFileSync(hostKey, 'PRIVATE-KEY-MATERIAL\n');
  chmodSync(hostKey, 0o600);
  const copy = join(matrix, 'probe_deploy');
  writeFileSync(copy, 'PRIVATE-KEY-MATERIAL\n');
  chmodSync(copy, 0o600);
  assertFails(
    () => assertDedicatedSshKey({ keyPath: copy, hostKeyDir, uid }),
    /copy of the host key/,
  );
  chmodSync(copy, 0o644);
  writeFileSync(copy, 'DIFFERENT-KEY\n');
  assertFails(() => assertDedicatedSshKey({ keyPath: copy, hostKeyDir, uid }), /must be 0600/);
  chmodSync(copy, 0o600);
  const accepted = assertDedicatedSshKey({ keyPath: copy, hostKeyDir, uid });
  assert.equal(accepted.mode, 0o600);
  rmSync(root, { recursive: true, force: true });
});

test('refuses the shared gh config and accepts a dedicated one', () => {
  const root = sandbox();
  const shared = join(root, 'gh-agent');
  const dedicated = join(root, 'gh-m5bmatrix');
  mkdirSync(shared, { mode: 0o700 });
  mkdirSync(dedicated, { mode: 0o750 });
  chmodSync(dedicated, 0o750);
  writeFileSync(join(shared, 'hosts.yml'), 'oauth_token: shared\n');
  writeFileSync(join(dedicated, 'hosts.yml'), 'oauth_token: probe-only\n');
  chmodSync(join(dedicated, 'hosts.yml'), 0o640);
  assertFails(
    () => assertDedicatedGhConfig({ configDir: shared, hostConfigDirs: [shared], uid }),
    /shared gh configuration/,
  );
  const accepted = assertDedicatedGhConfig({
    configDir: dedicated,
    hostConfigDirs: [shared],
    uid,
  });
  assert.equal(accepted.tokenPresent, true);
  writeFileSync(join(dedicated, 'hosts.yml'), 'github.com:\n  users: {}\n');
  assertFails(
    () => assertDedicatedGhConfig({ configDir: dedicated, hostConfigDirs: [shared], uid }),
    /carries no token/,
  );
  rmSync(root, { recursive: true, force: true });
});

test('prepareRunRoot adopts a legacy matrix-owned root and refuses a symlink', () => {
  const run = sandbox();
  prepareRunRoot(run, { uid, adoptUids: [uid] });
  assert.equal(modeOf(run), 0o755);
  const elsewhere = sandbox();
  rmSync(run, { recursive: true, force: true });
  symlinkSync(elsewhere, run);
  assertFails(() => prepareRunRoot(run, { uid, adoptUids: [uid] }), /symbolic link/);
  rmSync(run, { force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test('prepareDir refuses a directory outside the run root', () => {
  const run = sandbox();
  const elsewhere = sandbox();
  prepareRunRoot(run, { uid, adoptUids: [uid] });
  assertFails(
    () => prepareDir(run, elsewhere, { uid, gid, mode: 0o700 }),
    /outside the matrix run root/,
  );
  rmSync(run, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test('redact hides tokens before they reach a log', () => {
  assert.equal(redact('oauth_token: ghp_abcdefghijklmnop'), 'oauth_token: ***');
  assert.equal(redact('authorization: Bearer abc123'), 'authorization: Bearer ***');
  assert.equal(redact('M5B_TOKEN=super-secret'), 'M5B_TOKEN=***');
});

test('resolveUser reads uid, primary gid and supplementary groups', () => {
  const root = sandbox();
  const passwd = join(root, 'passwd');
  const group = join(root, 'group');
  writeFileSync(passwd, 'matrix:x:995:986::/home/matrix:/usr/sbin/nologin\n');
  writeFileSync(group, 'matrix:x:986:\nwheel:x:10:matrix\n');
  const user = resolveUser('matrix', { passwd, group });
  assert.equal(user.uid, 995);
  assert.equal(user.gid, 986);
  assert.deepEqual(user.gids, [10, 986]);
  assert.throws(() => resolveUser('missing', { passwd, group }), /unknown identity/);
  rmSync(root, { recursive: true, force: true });
});

test('CLI: prepare-run then write-protected then check-run survives a rerun', () => {
  const run = sandbox();
  const prepared = guardCli([
    'prepare-run',
    '--run',
    run,
    '--uid',
    String(uid),
    '--gid',
    String(gid),
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const written = guardCli(
    ['write-protected', '--dir', join(run, 'protected'), '--name', 'seed.env'],
    {
      input: 'export M5B_SESSION_TOKEN=value\n',
    },
  );
  assert.equal(written.status, 0, written.stderr);
  const checked = guardCli(['check-run', '--run', run, '--uid', String(uid), '--gid', String(gid)]);
  assert.equal(checked.status, 0, checked.stderr);
  const read = guardCli(['read-protected', '--dir', join(run, 'protected'), '--name', 'seed.env']);
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, 'export M5B_SESSION_TOKEN=value\n');
  rmSync(run, { recursive: true, force: true });
});

test('CLI: a path replacement is refused and the host sentinel is unchanged', () => {
  const run = sandbox();
  const elsewhere = sandbox();
  const prepared = guardCli([
    'prepare-run',
    '--run',
    run,
    '--uid',
    String(uid),
    '--gid',
    String(gid),
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const sentinel = join(elsewhere, 'host-file');
  writeFileSync(sentinel, 'host content\n');
  rmSync(join(run, 'protected'), { recursive: true, force: true });
  symlinkSync(elsewhere, join(run, 'protected'));
  const attempt = guardCli(
    ['write-protected', '--dir', join(run, 'protected'), '--name', 'supervisor-token'],
    { input: 'token\n' },
  );
  assert.equal(attempt.status, 1);
  assert.match(attempt.stderr, /symbolic link/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'host content\n');
  assert.equal(existsSync(join(elsewhere, 'supervisor-token')), false);
  rmSync(run, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test('CLI: audit-host exits nonzero for a writable host path', () => {
  const root = sandbox();
  chmodSync(root, 0o711);
  const shared = join(root, 'gh-agent');
  mkdirSync(shared);
  chmodSync(shared, 0o770);
  const result = guardCli([
    'audit-host',
    '--uid',
    String(uid + 100000),
    '--gid',
    String(gid),
    '--path',
    shared,
    '--secret',
    join(root, 'missing-secret'),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /WRITE/);
  chmodSync(shared, 0o750);
  const clean = guardCli([
    'audit-host',
    '--uid',
    String(uid + 100000),
    '--gid',
    String(gid),
    '--path',
    shared,
    '--secret',
    join(root, 'missing-secret'),
  ]);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /host_boundary=clean/);
  rmSync(root, { recursive: true, force: true });
});

test('describePath never leaks file content', () => {
  const root = sandbox();
  const file = join(root, 'secret');
  writeFileSync(file, 'oauth_token: secret-value\n');
  chmodSync(file, 0o644);
  const facts = describePath(file);
  assert.equal(facts.mode, '0644');
  assert.equal(JSON.stringify(facts).includes('secret-value'), false);
  rmSync(root, { recursive: true, force: true });
});
