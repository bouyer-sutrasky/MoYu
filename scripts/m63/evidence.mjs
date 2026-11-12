/* global fetch, setTimeout, clearTimeout, URL */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';

const { Client } = pg;

/**
 * ISS-63 evidence: run one real supervisor build against a real PostgreSQL
 * database and two ticket worktrees.
 *
 * `--label base` points at pre-change code, where both repositories must fall
 * back to the supervisor-wide command. `--label branch` points at the fixed
 * tree, where one repository has its own commands, the other inherits the
 * default, and an invalid stored value fails closed.
 *
 * This script only uses an isolated database, a temporary run directory and a
 * loopback port above 4700. It never starts a runtime instance, never touches
 * the production API/3082, and never reads a production credential.
 */

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} needs a value`);
  return value;
}

function run(command, args, options) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tree = path.resolve(argument('--tree', process.cwd()));
const label = argument('--label', 'branch');
const port = Number(argument('--port', '4790'));
const adminUrl = process.env.M63_DB_ADMIN_URL ?? process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error('M63_DB_ADMIN_URL (or TEST_DATABASE_ADMIN_URL) is required');
}
if (!['base', 'branch'].includes(label)) throw new Error('--label must be base or branch');

const head = run('git', ['-C', tree, 'rev-parse', 'HEAD']).trim();
const dbName = `m63_${label}_${process.pid}_${randomBytes(4).toString('hex')}`;
const dbUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
})();
const runDir = mkdtempSync(path.join(tmpdir(), `m63-${label}-`));
const worktreeRoot = path.join(runDir, 'worktrees');
const token = randomBytes(32).toString('base64url');
const servicePort = port;
const instancesConfig = path.join(runDir, 'instances.json');
const logPath = path.join(runDir, 'supervisor.log');

const ownerId = '00000000-0000-4000-8000-000000000063';
const repositoryA = '00000000-0000-4000-8000-0000000000aa';
const repositoryB = '00000000-0000-4000-8000-0000000000bb';
const ticketA = 'feedfacecafebeef';
const ticketB = 'deadbeefcafef00d';

writeFileSync(
  instancesConfig,
  JSON.stringify({
    instances: [
      { repository: 'M63/repo-a', profile: 'probeA', dshPort: 4802, bridgePort: 4801 },
      { repository: 'M63/repo-b', profile: 'probeB', dshPort: 4804, bridgePort: 4803 },
    ],
    portRange: { start: 4801, end: 4809 },
  }),
);

for (const profile of ['probeA', 'probeB']) {
  const directory = path.join(worktreeRoot, profile, `probe-${ticketA.slice(0, 12)}`);
  mkdirSync(path.join(directory, '.git'), { recursive: true });
  writeFileSync(path.join(directory, 'README.md'), `${label} fixture\n`);
}
// The second ticket lives in its own directory so each repository has one.
mkdirSync(path.join(worktreeRoot, 'probeB', `probe-${ticketB.slice(0, 12)}`, '.git'), {
  recursive: true,
});
mkdirSync(path.join(worktreeRoot, 'probeA', `probe-${ticketB.slice(0, 12)}`, '.git'), {
  recursive: true,
});

const admin = new Client({ connectionString: adminUrl });
let database;
let supervisor;
const cleanup = async () => {
  if (supervisor && supervisor.exitCode === null) {
    supervisor.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        supervisor.kill('SIGKILL');
        resolve();
      }, 5_000);
      supervisor.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await database?.end().catch(() => undefined);
  await admin.end().catch(() => undefined);
  if (process.env.M63_KEEP === '1') {
    console.log(`kept run dir: ${runDir}`);
    return;
  }
  rmSync(runDir, { recursive: true, force: true });
};

const output = [];
const log = (line) => {
  console.log(line);
  output.push(line);
};

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);

  log(`## ISS-63 ${label} evidence`);
  log(`tree: ${tree}`);
  log(`HEAD: ${head}`);
  run('pnpm', ['--filter', '@moyu/db', 'db:migrate'], {
    cwd: tree,
    env: { ...process.env, DATABASE_URL: dbUrl },
  });
  log('migrate: ok');

  database = new Client({ connectionString: dbUrl });
  await database.connect();
  const column = await database.query(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'repositories'
          and column_name = 'check_commands'
     ) as present`,
  );
  const columnPresent = column.rows[0]?.present === true;
  if (label === 'base') {
    assert(
      !columnPresent,
      'base tree unexpectedly has repositories.check_commands; point --tree at the pre-change commit',
    );
    log('schema: repositories.check_commands absent (pre-change)');
  } else {
    assert(
      columnPresent,
      'branch tree is missing repositories.check_commands; migration 0018 not applied',
    );
    log('schema: repositories.check_commands present (0018 applied)');
  }
  await database.query(
    `insert into owners (id, display_name) values ($1, 'ISS-63 evidence owner')`,
    [ownerId],
  );
  if (label === 'base') {
    await database.query(
      `insert into repositories (id, owner_id, full_name) values ($1, $2, 'M63/repo-a'), ($3, $2, 'M63/repo-b')`,
      [repositoryA, ownerId, repositoryB],
    );
  } else {
    await database.query(
      `insert into repositories (id, owner_id, full_name, check_commands)
       values ($1, $2, 'M63/repo-a', '["printf repo-a"]'::jsonb), ($3, $2, 'M63/repo-b', null)`,
      [repositoryA, ownerId, repositoryB],
    );
  }
  await database.query(
    `insert into repository_instances
       (repository_id, state, desired_state, reason_code, profile, port, bridge_port)
     values ($1, 'sleeping', 'sleeping', 'never_started', 'probeA', 4802, 4801),
            ($2, 'sleeping', 'sleeping', 'never_started', 'probeB', 4804, 4803)`,
    [repositoryA, repositoryB],
  );

  const logFd = openSync(logPath, 'a', 0o600);
  supervisor = spawn(process.execPath, ['apps/supervisor/dist/main.js'], {
    cwd: tree,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      SUPERVISOR_HOST: '127.0.0.1',
      SUPERVISOR_PORT: String(servicePort),
      SUPERVISOR_TOKEN: token,
      DATABASE_URL: dbUrl,
      INSTANCES_CONFIG: instancesConfig,
      DSH_BIN: '/usr/bin/dsh',
      DSH_HOME: path.join(runDir, 'dsh'),
      PLATFORM_URL: 'http://127.0.0.1:4301',
      RUNTIME_CREDENTIALS_DIR: path.join(runDir, 'creds'),
      INSTANCE_ENV_DIR: path.join(runDir, 'env'),
      INSTANCE_LOG_DIR: path.join(runDir, 'logs'),
      WORKTREE_ROOT: worktreeRoot,
      REVIEW_CHECK_COMMANDS: '["printf global"]',
      REVIEW_CHECK_TIMEOUT_MS: '900000',
      REVIEW_CHECK_TOTAL_TIMEOUT_MS: '900000',
    },
    stdio: ['ignore', logFd, logFd],
  });

  const healthUrl = `http://127.0.0.1:${servicePort}/control/v1/health`;
  const deadline = Date.now() + 20_000;
  let lastHealthError = 'timeout';
  for (;;) {
    try {
      const response = await fetch(healthUrl, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) break;
      lastHealthError = `HTTP ${response.status}`;
    } catch (error) {
      lastHealthError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(`supervisor did not become healthy at ${healthUrl} (${lastHealthError})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const checks = async (repositoryId, ticketId) => {
    const response = await fetch(
      `http://127.0.0.1:${servicePort}/control/v1/instances/${repositoryId}/review/checks`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId }),
      },
    );
    return { status: response.status, body: await response.json() };
  };

  if (label === 'base') {
    const first = await checks(repositoryA, ticketA);
    const second = await checks(repositoryB, ticketB);
    log(`repo-a (no per-repository config): HTTP ${first.status}`);
    log(JSON.stringify(first.body));
    log(`repo-b (no per-repository config): HTTP ${second.status}`);
    log(JSON.stringify(second.body));
    assert(first.status === 200 && second.status === 200, 'base checks did not return 200');
    assert(
      first.body.data?.runs?.[0]?.command === 'printf global' &&
        first.body.data?.runs?.[0]?.exitCode === 0 &&
        first.body.data?.runs?.[0]?.passed === true,
      'base repo-a did not run the global command successfully',
    );
    assert(
      second.body.data?.runs?.[0]?.command === 'printf global' &&
        second.body.data?.runs?.[0]?.exitCode === 0 &&
        second.body.data?.runs?.[0]?.passed === true,
      'base repo-b did not run the global command successfully',
    );
    log('BASE-MATCH: both repositories used the supervisor-wide command');
    log('RESULT PASS');
  } else {
    const first = await checks(repositoryA, ticketA);
    const second = await checks(repositoryB, ticketB);
    log(`repo-a (custom ["printf repo-a"]): HTTP ${first.status}`);
    log(JSON.stringify(first.body));
    log(`repo-b (null = default): HTTP ${second.status}`);
    log(JSON.stringify(second.body));
    assert(first.status === 200 && second.status === 200, 'branch checks did not return 200');
    assert(
      first.body.data?.runs?.[0]?.command === 'printf repo-a' &&
        first.body.data?.runs?.[0]?.exitCode === 0 &&
        first.body.data?.runs?.[0]?.passed === true,
      'repo-a did not run its own command successfully',
    );
    assert(
      second.body.data?.runs?.[0]?.command === 'printf global' &&
        second.body.data?.runs?.[0]?.exitCode === 0 &&
        second.body.data?.runs?.[0]?.passed === true,
      'repo-b did not fall back to the global command successfully',
    );

    await database.query(`update repositories set check_commands = '[""]'::jsonb where id = $1`, [
      repositoryA,
    ]);
    const invalid = await checks(repositoryA, ticketA);
    log(`repo-a (stored invalid [""]): HTTP ${invalid.status}`);
    log(JSON.stringify(invalid.body));
    assert(invalid.status === 422, `invalid repository commands returned ${invalid.status}`);
    assert(
      String(invalid.body.error?.message ?? '').includes('仓库检查命令配置无效'),
      'invalid repository commands did not fail closed with a clear message',
    );
    await database.query(`update repositories set check_commands = $2::jsonb where id = $1`, [
      repositoryA,
      '["printf repo-a"]',
    ]);
    log('RESULT PASS');
  }
} catch (error) {
  log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
