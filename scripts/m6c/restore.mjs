#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  assertAllowedPath,
  assertDatabaseTarget,
  ensureDir,
  fail,
  fileInfo,
  parseArgs,
  printHelpAndExit,
  readJson,
  run,
} from './lib.mjs';

const HELP = [
  '--set-dir <dir>          backup set directory containing manifest.json (required)',
  '--target-db-url-file <file>  restricted file containing the restore DATABASE_URL',
  '--admin-url-file <file>  restricted file containing an admin DATABASE_URL',
  '--target-dsh-home <dir>  isolated restore DSH home (optional)',
  '--target-worktrees <dir> isolated restore worktree root (optional)',
  '--restore-state          extract DSH/worktree archives into the target roots',
  '--verify-only            verify set id and every part hash, then exit',
  '--allow-production       allow a production-shaped target database name',
  '--help                   show this help without reading secrets or writing files',
];

const { values } = parseArgs(process.argv.slice(2));
if (values.help) {
  printHelpAndExit('Verify and restore one MoYu M6-C backup set', HELP, [
    'node scripts/m6c/restore.mjs --set-dir /root/m6c-backups/RUN --target-db-url-file /root/m6c-restore-db.env --admin-url-file /root/m6c-admin.env --verify-only',
    'node scripts/m6c/restore.mjs --set-dir /root/m6c-backups/RUN --target-db-url-file /root/m6c-restore-db.env --admin-url-file /root/m6c-admin.env --target-dsh-home /var/lib/moyu-m6c-restore/dsh --restore-state',
  ]);
}

if (!values['set-dir']) fail('restore: --set-dir is required', 2);
const setDir = assertAllowedPath(resolve(String(values['set-dir'])), 'backup set directory');
const manifestPath = join(setDir, 'manifest.json');
if (!existsSync(manifestPath)) fail(`restore: ${manifestPath} is missing`, 1);
const manifest = readJson(manifestPath);
if (!manifest.backupSetId || !Array.isArray(manifest.parts)) {
  fail('restore: manifest has no backupSetId or parts', 1);
}
if (values.set && String(values.set) !== manifest.backupSetId) {
  fail(`restore: set id ${values.set} != manifest ${manifest.backupSetId}`, 1);
}
const problems = [];
for (const part of manifest.parts) {
  try {
    const info = fileInfo(part.path);
    if (info.sha256 !== part.sha256) {
      problems.push(`${part.name}: hash ${info.sha256} != ${part.sha256}`);
    }
    if (info.bytes !== part.bytes) {
      problems.push(`${part.name}: bytes ${info.bytes} != ${part.bytes}`);
    }
  } catch (error) {
    problems.push(`${part.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (problems.length > 0) {
  process.stderr.write(`restore: backup set verification failed\n${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({ backupSetId: manifest.backupSetId, parts: manifest.parts.length, verified: true })}\n`,
);
if (values['verify-only']) process.exit(0);

function readUrlFile(path, label) {
  if (!path) fail(`restore: --${label} is required unless --verify-only is used`, 2);
  const file = assertAllowedPath(resolve(String(path)), `${label} file`);
  const text = readFileSync(file, 'utf8');
  const assignment = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('DATABASE_URL='));
  if (assignment) return assignment.slice('DATABASE_URL='.length).replace(/^['"]|['"]$/g, '');
  const first = text.trim();
  if (/^postgres(ql)?:\/\//.test(first)) return first;
  fail(`restore: ${file} does not contain DATABASE_URL`);
}

const targetUrl = readUrlFile(values['target-db-url-file'], 'target-db-url-file');
const target = assertDatabaseTarget(targetUrl, {
  allowProduction: values['allow-production'] === true,
});
if (target.database === manifest.database?.name) {
  fail('restore: target database is the backup source; choose a dedicated restore database', 1);
}
if (
  !/^moyu_m6c_restore_[A-Za-z0-9_]+$/.test(target.database) &&
  values['allow-production'] !== true
) {
  fail(
    `restore: target ${target.database} is not a dedicated moyu_m6c_restore_* database; pass --allow-production only after an owner-approved restore plan`,
    1,
  );
}

const adminUrl = readUrlFile(values['admin-url-file'], 'admin-url-file');
assertDatabaseTarget(adminUrl, { allowProduction: true });
const parts = new Map(manifest.parts.map((part) => [part.name, part]));
const dump = parts.get('postgres');
if (!dump) fail('restore: manifest has no postgres part', 1);

run('createdb', ['--maintenance-db', adminUrl, target.database], { allowFailure: true });
run('pg_restore', [
  '--exit-on-error',
  '--no-owner',
  '--no-privileges',
  '--dbname',
  targetUrl,
  dump.path,
]);
const ledger = run('psql', [
  targetUrl,
  '-X',
  '-Atc',
  "select count(*) || ':' || coalesce(max(id),0) from drizzle.__drizzle_migrations;",
]).stdout.trim();
const tables = run('psql', [
  targetUrl,
  '-X',
  '-Atc',
  "select count(*) from information_schema.tables where table_schema='public';",
]).stdout.trim();
if (!/^\d+:\d+$/.test(ledger)) fail(`restore: could not read migration ledger: ${ledger}`, 1);
if (Number(tables) <= 0) fail('restore: no public tables were restored', 1);

if (values['restore-state']) {
  if (!values['target-dsh-home'])
    fail('restore: --target-dsh-home is required with --restore-state', 2);
  const targetDsh = ensureDir(resolve(String(values['target-dsh-home'])), 0o700);
  const dshPart = parts.get('dsh-state');
  if (!dshPart) fail('restore: manifest has no dsh-state part', 1);
  run('tar', ['-C', targetDsh, '-xzf', dshPart.path]);
  if (values['target-worktrees']) {
    const targetWorktrees = ensureDir(resolve(String(values['target-worktrees'])), 0o700);
    const worktreePart = parts.get('worktrees');
    if (!worktreePart) fail('restore: manifest has no worktrees part', 1);
    run('tar', ['-C', targetWorktrees, '-xzf', worktreePart.path]);
  }
}

process.stdout.write(
  `${JSON.stringify({
    backupSetId: manifest.backupSetId,
    targetDatabase: target.database,
    ledger,
    publicTables: Number(tables),
    stateRestored: values['restore-state'] === true,
    next: 'Keep dispatcher/automatic wake disabled; reconcile GitHub Issue/PR/comment/commit ids before enabling consumption.',
  })}\n`,
);
