#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  assertAllowedPath,
  assertDatabaseTarget,
  ensureDir,
  fail,
  fileInfo,
  findFiles,
  parseArgs,
  printHelpAndExit,
  run,
  writeJson,
} from './lib.mjs';

const HELP = [
  '--set <id>               backupSetId (default: UTC timestamp)',
  '--out <dir>              destination directory (required unless --status)',
  '--db-url-file <file>     restricted file containing DATABASE_URL',
  '--dsh-home <dir>         DSH home/state root to back up',
  '--worktrees <dir>        worktree root to include (optional)',
  '--release-root <dir>     immutable release root to record (optional)',
  '--unit-prefix <prefix>   systemd prefix used with --stop-writers (default: moyu-m6c)',
  '--stop-writers           stop dispatcher, supervisor and API before the dump',
  '--start-after            start API, supervisor and dispatcher after a successful dump',
  '--skip-sqlite            explicitly omit SQLite state (makes the backup partial)',
  '--allow-production       allow a production-shaped database name',
  '--status                 print resolved targets and exit without writing',
  '--help                   show this help without reading secrets or writing files',
];

const { values } = parseArgs(process.argv.slice(2));
if (values.help)
  printHelpAndExit('Create a consistent MoYu M6-C backup set', HELP, [
    'node scripts/m6c/backup.mjs --status --db-url-file /etc/moyu-m6c/api.env --dsh-home /var/lib/moyu-m6c/dsh --allow-production',
    'node scripts/m6c/backup.mjs --set RUN-20261116 --out /root/m6c-backups/RUN-20261116 --db-url-file /etc/moyu-m6c/api.env --dsh-home /var/lib/moyu-m6c/dsh --stop-writers --start-after',
  ]);

function readDatabaseUrl(path) {
  if (!path) fail('backup: --db-url-file is required', 2);
  const file = assertAllowedPath(resolve(String(path)), 'database url file');
  const text = readFileSync(file, 'utf8');
  const assignment = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('DATABASE_URL='));
  if (assignment) return assignment.slice('DATABASE_URL='.length).replace(/^['"]|['"]$/g, '');
  const first = text.trim();
  if (/^postgres(ql)?:\/\//.test(first)) return first;
  fail(`backup: ${file} does not contain DATABASE_URL`);
}

const dbUrl = readDatabaseUrl(values['db-url-file']);
const dbTarget = assertDatabaseTarget(dbUrl, {
  allowProduction: values['allow-production'] === true,
});
const dshHome = values['dsh-home']
  ? assertAllowedPath(resolve(String(values['dsh-home'])), 'DSH home')
  : null;
const worktrees = values.worktrees
  ? assertAllowedPath(resolve(String(values.worktrees)), 'worktree root')
  : null;
const releaseRoot = values['release-root']
  ? assertAllowedPath(resolve(String(values['release-root'])), 'release root')
  : null;
const set = String(
  values.set ??
    new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, '')
      .slice(0, 15),
);
if (!/^[A-Za-z0-9._-]{1,80}$/.test(set)) fail('backup: --set contains unsupported characters', 2);

if (values.status) {
  process.stdout.write(
    `${JSON.stringify({
      mode: 'status',
      set,
      database: { name: dbTarget.database, host: dbTarget.host, port: dbTarget.port },
      dshHome,
      worktrees,
      releaseRoot,
      wouldStopWriters: values['stop-writers'] === true,
      sqlite: values['skip-sqlite'] === true ? 'omitted' : 'required',
    })}\n`,
  );
  process.exit(0);
}

if (!values.out) fail('backup: --out is required unless --status is used', 2);
if (!dshHome || !existsSync(dshHome)) fail('backup: --dsh-home must exist', 2);
const out = ensureDir(resolve(String(values.out)), 0o700);
const parts = [];
const addPart = (name, kind, path, extra = {}) => {
  const info = fileInfo(path);
  parts.push({ name, kind, path: info.path, sha256: info.sha256, bytes: info.bytes, ...extra });
};

const units = String(values['unit-prefix'] ?? 'moyu-m6c');
const stopWriters = values['stop-writers'] === true;
const startAfter = values['start-after'] === true;
if (stopWriters) {
  for (const unit of [`${units}-dispatcher`, `${units}-supervisor`, `${units}-api`]) {
    run('systemctl', ['stop', `${unit}.service`]);
  }
}

try {
  // PostgreSQL custom-format dump is taken while all known writers are stopped.
  const dump = join(out, `${dbTarget.database}.dump`);
  run('pg_dump', ['-Fc', '-f', dump, dbUrl]);
  run('pg_restore', ['--list', dump]);
  addPart('postgres', 'pg_dump', dump, { database: dbTarget.database });

  if (values['skip-sqlite'] !== true) {
    const sqliteFiles = findFiles(dshHome, (path) => /\.(sqlite|sqlite3|db)$/.test(path), 100);
    if (sqliteFiles.length === 0) {
      fail('backup: no SQLite state found; pass --skip-sqlite only if that is intentional', 1);
    }
    const sqliteDir = ensureDir(join(out, 'sqlite'), 0o700);
    const { backup, DatabaseSync } = await import('node:sqlite');
    for (const source of sqliteFiles) {
      const target = join(sqliteDir, source.slice(dshHome.length + 1).replaceAll('/', '__'));
      const database = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(database, target);
      } finally {
        database.close();
      }
      chmodSync(target, 0o600);
      addPart(`sqlite:${basename(source)}`, 'sqlite-backup', target, { source });
    }
  }

  const stateArchive = join(out, 'dsh-state.tgz');
  run('tar', ['-C', dshHome, '-czf', stateArchive, '.']);
  addPart('dsh-state', 'tar', stateArchive, { source: dshHome });

  if (worktrees) {
    const worktreeArchive = join(out, 'worktrees.tgz');
    run('tar', ['-C', worktrees, '-czf', worktreeArchive, '.']);
    addPart('worktrees', 'tar', worktreeArchive, { source: worktrees });
  }

  const release = releaseRoot
    ? {
        root: releaseRoot,
        gitHead: existsSync(join(releaseRoot, 'release-manifest.json'))
          ? (JSON.parse(readFileSync(join(releaseRoot, 'release-manifest.json'), 'utf8')).source
              ?.gitHead ?? null)
          : null,
      }
    : null;

  writeJson(join(out, 'manifest.json'), {
    schemaVersion: 1,
    backupSetId: set,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    database: { name: dbTarget.database, host: dbTarget.host, port: dbTarget.port },
    writersStopped: stopWriters,
    release,
    parts,
    notes: [
      'The manifest records hashes and paths only; the directory is mode 0700.',
      'Restore must verify the same backupSetId and every part hash before touching a target.',
    ],
  });
  process.stdout.write(
    `${JSON.stringify({ backupSetId: set, out, parts: parts.length, database: dbTarget.database })}\n`,
  );
} finally {
  if (startAfter) {
    for (const unit of [`${units}-api`, `${units}-supervisor`, `${units}-dispatcher`]) {
      run('systemctl', ['start', `${unit}.service`], { allowFailure: true });
    }
  }
}
