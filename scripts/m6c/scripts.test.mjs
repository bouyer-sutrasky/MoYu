import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'moyu-m6c-scripts-'));
const env = { ...process.env, M6C_ALLOWED_ROOTS: root };

function run(script, args) {
  return spawnSync(process.execPath, [join(import.meta.dirname, script), ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test('every m6c CLI has a side-effect-free --help', () => {
  for (const script of [
    'release-manifest.mjs',
    'verify-running.mjs',
    'backup.mjs',
    'restore.mjs',
    'browser-scenarios.mjs',
    'check-matrix.mjs',
  ]) {
    const result = run(script, ['--help']);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.match(result.stdout, /side-effect free/i, script);
  }
});

test('release manifest refuses a missing plugin artifact', () => {
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  const result = run('release-manifest.mjs', [
    '--source',
    source,
    '--out',
    join(root, 'manifest.json'),
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--plugin-dir is required/);
});

test('restore verifies the backupSetId and every part hash', () => {
  const setDir = join(root, 'backup-set');
  mkdirSync(setDir, { recursive: true });
  const part = join(setDir, 'postgres.dump');
  writeFileSync(part, 'not-a-real-dump\n');
  const manifest = {
    schemaVersion: 1,
    backupSetId: 'RUN-TEST',
    database: { name: 'moyu_m6c' },
    parts: [
      {
        name: 'postgres',
        kind: 'pg_dump',
        path: part,
        sha256: sha256(part),
        bytes: readFileSync(part).length,
      },
    ],
  };
  writeFileSync(join(setDir, 'manifest.json'), JSON.stringify(manifest));
  const good = run('restore.mjs', ['--set-dir', setDir, '--verify-only']);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /"verified":true/);

  writeFileSync(part, 'tampered\n');
  const bad = run('restore.mjs', ['--set-dir', setDir, '--verify-only']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /hash/);
});

test('matrix checker fails a Pass row without evidence', () => {
  const matrix = join(root, 'matrix.json');
  writeFileSync(
    matrix,
    JSON.stringify({
      rows: [
        {
          id: 'A01',
          status: 'Pass',
          environment: 'candidate',
          sha: 'a'.repeat(40),
          command: 'true',
          exitCode: 0,
          evidence: 'missing.txt',
        },
      ],
    }),
  );
  const result = run('check-matrix.mjs', ['--matrix', matrix, '--evidence', root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /evidence is missing/);
});

test('run logs redact PostgreSQL credentials', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "import('./scripts/m6c/lib.mjs').then((m) => m.run('true', ['postgresql://user:s3cret@127.0.0.1/db']))",
    ],
    { cwd: join(import.meta.dirname, '..', '..'), encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /[REDACTED]/);
  assert.doesNotMatch(result.stderr, /s3cret/);
});

test('backup status prints its resolved target without writing', () => {
  const dsh = join(root, 'dsh');
  mkdirSync(dsh, { recursive: true });
  const envFile = join(root, 'db.env');
  writeFileSync(envFile, 'DATABASE_URL=postgresql://moyu@127.0.0.1:55432/moyu_test\n');
  const result = run('backup.mjs', ['--status', '--db-url-file', envFile, '--dsh-home', dsh]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"mode":"status"/);
  assert.match(result.stdout, /moyu_test/);
});
