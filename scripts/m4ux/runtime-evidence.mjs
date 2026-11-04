#!/usr/bin/env node
/**
 * Verifies the pinned upstream artifact's real `GET /bridge/v1/branches` and the
 * platform preference path against an isolated runtime profile.
 *
 * It starts (or reuses) a dedicated DSH profile that loads only
 * `/root/src/upstream/m4ux-final-verify`, configures the GitHub Source through
 * the loopback management API, and exercises the Bridge with a real Bearer
 * token. It then starts a temporary platform API/database pointing at that
 * Bridge and saves a valid and an invalid branch preference through the real
 * owner API.
 *
 * Usage:
 *   TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
 *     node scripts/m4ux/runtime-evidence.mjs [--reuse-runtime]
 *
 * Output: docs/evidence/m4ux/runtime-evidence.json
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = path.join(ROOT, 'docs/evidence/m4ux');
const ARTIFACT = process.env.M4UX_RUNTIME_ARTIFACT ?? '/root/src/upstream/m4ux-final-verify';
const DSH_HOME = process.env.M4UX_DSH_HOME ?? '/root/.dsh-m4ux';
const PROFILE = 'm4ux';
const REPOSITORY = process.env.M4UX_RUNTIME_REPOSITORY ?? 'bouyer-sutrasky/m4-github-probe';
const BRIDGE_PORT = Number(process.env.M4UX_RUNTIME_BRIDGE_PORT ?? 3391);
const WEB_PORT = Number(process.env.M4UX_RUNTIME_WEB_PORT ?? 3392);
const API_PORT = Number(process.env.M4UX_PLATFORM_PORT ?? 4403);
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const REUSE = process.argv.includes('--reuse-runtime') || process.env.M4UX_RUNTIME_REUSE === '1';
const GH_CONFIG_DIR = process.env.GH_CONFIG_DIR ?? '/root/.config/gh-agent';
const TOKEN_FILE = path.join(DSH_HOME, 'bridge-token');
const results = [];
const servers = [];
let runtimeChild = null;
let databaseName = null;

function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`[${status === 'pass' ? 'PASS' : 'FAIL'}] ${name}: ${detail ?? ''}`);
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
async function token() {
  if (!existsSync(TOKEN_FILE)) {
    await writeFile(TOKEN_FILE, randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return (await readFile(TOKEN_FILE, 'utf8')).trim();
}
async function waitFor(url, predicate, timeoutMs = 60_000, label = url) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (predicate(response)) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready: ${last}`);
}

async function bridgeJson(pathname, bearer = true) {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathname}`, {
    headers: bearer ? { authorization: `Bearer ${await token()}` } : {},
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** The Bridge closes connections while dsh-superagent restarts; retry briefly. */
async function bridgeJsonReady(pathname, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const probe = await bridgeJson(pathname);
      if (probe.status !== 503 && probe.status !== 502) return probe;
      last = probe;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last ?? { status: 0, body: null };
}

async function management(pathname, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${WEB_PORT}/orchestrator/api/${pathname}`, {
    method,
    headers: {
      origin: `http://127.0.0.1:${WEB_PORT}`,
      'x-orchestrator-request': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

async function writeProfile() {
  const dir = path.join(DSH_HOME, 'profiles', PROFILE);
  await mkdir(path.join(DSH_HOME, 'state', PROFILE), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${PROFILE}`,
        private: true,
        dependencies: { 'dsh-superagent': `link:${ARTIFACT}` },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-superagent'],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  if (!existsSync(path.join(dir, 'cordis.yml'))) {
    await writeFile(path.join(dir, 'cordis.yml'), '# composed from patches\n[]\n');
  }
  await writeFile(
    path.join(dir, 'cordis.patch.yml'),
    [
      '# M4-UX isolated runtime verification profile (patch 0021 artifact).',
      '- id: webserver',
      '  config:',
      '    host: 127.0.0.1',
      `    port: ${WEB_PORT}`,
      '- id: dsh-superagent',
      '  config:',
      `    stateDir: ${path.join(DSH_HOME, 'state', PROFILE)}`,
      '- id: dsh-superagent-github',
      '  config:',
      `    repository: ${REPOSITORY}`,
      '    cli: /usr/bin/gh',
      '- id: dsh-superagent-workspace',
      '  config:',
      `    repository: ${REPOSITORY}`,
      '',
    ].join('\n'),
  );
  execFileSync('/usr/bin/dsh', ['plugin', '--profile', PROFILE, 'install'], {
    env: { ...process.env, DSH_HOME, HOME: '/root' },
    stdio: 'ignore',
  });
}

async function startRuntime() {
  if (REUSE) {
    const health = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`).catch(() => null);
    if (health?.ok) {
      record('runtime reuse', 'pass', `existing bridge on ${BRIDGE_PORT}`);
      return;
    }
  }
  await writeProfile();
  const env = {
    ...process.env,
    DSH_HOME,
    HOME: '/root',
    GH_CONFIG_DIR,
    MOYU_BRIDGE_HOST: '127.0.0.1',
    MOYU_BRIDGE_PORT: String(BRIDGE_PORT),
    MOYU_BRIDGE_TOKEN: await token(),
    MOYU_PLATFORM_URL: `http://127.0.0.1:${API_PORT}`,
    MOYU_PLATFORM_TOKEN: randomBytes(24).toString('hex'),
  };
  delete env.GIT_CONFIG_GLOBAL;
  runtimeChild = spawn('/usr/bin/dsh', ['--profile', PROFILE, '--no-open'], {
    cwd: '/root',
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  runtimeChild.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  servers.push(runtimeChild);
  try {
    await waitFor(
      `http://127.0.0.1:${BRIDGE_PORT}/healthz`,
      (response) => response.ok,
      90_000,
      'isolated Bridge',
    );
  } catch (error) {
    throw new Error(`${error.message}\n${stderr.slice(-2000)}`);
  }
  record('runtime start', 'pass', `${ARTIFACT} on web ${WEB_PORT} / bridge ${BRIDGE_PORT}`);
}

async function configureGithubSource() {
  const settings = await management('settings');
  assert(settings.status === 200, 'runtime settings readable');
  const github = settings.body.sources.find((source) => source.id === 'github');
  assert(github, 'GitHub source is registered');
  if (github.value.config.repository === REPOSITORY && github.value.config.cli === '/usr/bin/gh') {
    return;
  }
  const saved = await management(`settings/source:github`, 'PUT', {
    value: {
      enabled: true,
      config: {
        ...github.value.config,
        repository: REPOSITORY,
        cli: '/usr/bin/gh',
      },
    },
    revision: github.revision,
  });
  assert(
    saved.status === 200,
    `GitHub source saved (${saved.status}: ${JSON.stringify(saved.body)})`,
  );
  record('GitHub source configured', 'pass', REPOSITORY);
  // Saving an account field restarts dsh-superagent and reruns setup. The
  // Bridge health route can answer before the repository projection is ready,
  // so wait for the actual branch call instead.
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const probe = await bridgeJson('/bridge/v1/branches');
      if (probe.status === 200) return;
      last = probe;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Bridge branches did not become ready after source setup: ${JSON.stringify(last)}`,
  );
}

async function platformDatabase() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  databaseName = `moyu_m4ux_runtime_${process.pid}_${randomBytes(4).toString('hex')}`;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function migrate(databaseUrl) {
  execFileSync(
    path.join(ROOT, 'packages/db/node_modules/.bin/tsx'),
    [path.join(ROOT, 'packages/db/src/cli/migrate.ts')],
    { env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
}

async function startPlatform(databaseUrl) {
  const tokenValue = randomBytes(24).toString('hex');
  const owner = new Client({ connectionString: databaseUrl });
  await owner.connect();
  let repositoryId;
  try {
    const ownerRow = await owner.query(
      `insert into owners (display_name) values ('M4-UX Runtime Evidence') returning id`,
    );
    const ownerId = ownerRow.rows[0].id;
    const repo = await owner.query(
      `insert into repositories (owner_id, full_name, default_branch, status, bridge_url)
       values ($1, $2, 'main', 'active', $3) returning id`,
      [ownerId, REPOSITORY, `http://127.0.0.1:${BRIDGE_PORT}`],
    );
    repositoryId = repo.rows[0].id;
    await owner.query(
      `insert into sessions (owner_id, token_hash, expires_at)
       values ($1, $2, now() + interval '1 day')`,
      [ownerId, sha256(Buffer.from(tokenValue, 'utf8'))],
    );
  } finally {
    await owner.end();
  }
  const child = spawn(process.execPath, ['apps/api/dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      API_PORT: String(API_PORT),
      API_HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      WEB_DIST_DIR: path.join(ROOT, 'apps/web/dist'),
      WEBAUTHN_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      WEBAUTHN_RP_ID: '127.0.0.1',
      AUTH_COOKIE_SECURE: 'false',
      BRIDGE_TOKEN: await token(),
      BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
      BRIDGE_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  servers.push(child);
  await waitFor(
    `http://127.0.0.1:${API_PORT}/healthz`,
    (response) => response.ok,
    30_000,
    'platform API',
  );
  return { repositoryId, token: tokenValue, baseURL: `http://127.0.0.1:${API_PORT}` };
}

async function platformJson(baseURL, tokenValue, pathname, options = {}) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      cookie: `moyu_session=${tokenValue}`,
      accept: 'application/json',
      origin: baseURL,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  if (!ADMIN_URL) {
    console.error('TEST_DATABASE_ADMIN_URL is required');
    process.exit(2);
  }
  await mkdir(EVIDENCE, { recursive: true });
  const artifactFiles = {
    'lib/index.js': sha256(await readFile(path.join(ARTIFACT, 'lib/index.js'))),
    'package.json': sha256(await readFile(path.join(ARTIFACT, 'package.json'))),
  };

  await startRuntime();
  await configureGithubSource();

  const unauthorised = await bridgeJson('/bridge/v1/branches', false);
  assert(
    unauthorised.status === 401,
    `Bridge rejects a missing Bearer token (${unauthorised.status})`,
  );
  const capabilities = await bridgeJsonReady('/bridge/v1/capabilities');
  assert(capabilities.status === 200, 'capabilities readable');
  assert(
    capabilities.body?.capabilities?.branches === true,
    'capabilities advertise the branches patch',
  );
  const realBranches = await bridgeJsonReady('/bridge/v1/branches');
  assert(
    realBranches.status === 200,
    `branches readable (${realBranches.status}: ${JSON.stringify(realBranches.body)})`,
  );
  const branchNames = realBranches.body.branches.map((branch) => branch.name);
  assert(
    branchNames.includes('main'),
    `real branch list contains main (${branchNames.join(', ')})`,
  );
  record(
    'real Bridge branches',
    'pass',
    `${branchNames.length} branches: ${branchNames.join(', ')}`,
  );

  const databaseUrl = await platformDatabase();
  migrate(databaseUrl);
  const platform = await startPlatform(databaseUrl);
  try {
    const listed = await platformJson(
      platform.baseURL,
      platform.token,
      `/api/v1/repositories/${platform.repositoryId}/branches`,
    );
    assert(listed.status === 200, `platform branches endpoint (${listed.status})`);
    assert(
      listed.body.data.status === 'ready' &&
        listed.body.data.branches.some((branch) => branch.name === 'main'),
      'platform reads the real branch list',
    );
    record('platform branch list', 'pass', `${listed.body.data.branches.length} branches`);

    const missingBranch = `m4ux-missing-${randomUUID()}`;
    const invalid = await platformJson(
      platform.baseURL,
      platform.token,
      `/api/v1/repositories/${platform.repositoryId}/preferences`,
      {
        method: 'PUT',
        body: { executionMode: 'execute', baseBranch: missingBranch, model: null },
      },
    );
    assert(invalid.status === 422, `missing branch is rejected (${invalid.status})`);
    assert(
      String(invalid.body?.error?.message ?? '').includes('no longer exists'),
      'rejection names the missing branch',
    );
    record('platform rejects a deleted branch', 'pass', invalid.body.error.message);

    const valid = await platformJson(
      platform.baseURL,
      platform.token,
      `/api/v1/repositories/${platform.repositoryId}/preferences`,
      {
        method: 'PUT',
        body: { executionMode: 'execute', baseBranch: 'main', model: null },
      },
    );
    assert(valid.status === 200, `valid branch preference saved (${valid.status})`);
    const reloaded = await platformJson(
      platform.baseURL,
      platform.token,
      `/api/v1/repositories/${platform.repositoryId}/preferences`,
    );
    assert(reloaded.body.data.preferences?.baseBranch === 'main', 'saved preference reloads');
    record('platform saves a valid branch preference', 'pass', 'main saved and reloaded');

    const evidence = {
      at: new Date().toISOString(),
      artifact: ARTIFACT,
      profile: {
        dshHome: DSH_HOME,
        bridgePort: BRIDGE_PORT,
        webPort: WEB_PORT,
        mode: REUSE ? 'reuse' : 'started',
      },
      artifactFiles,
      repository: REPOSITORY,
      bridge: {
        unauthorisedStatus: unauthorised.status,
        protocolVersion: capabilities.body?.protocolVersion,
        upstream: capabilities.body?.upstream,
        capabilities: capabilities.body?.capabilities,
        branchCount: branchNames.length,
        branchNames,
        hasMore: realBranches.body?.hasMore,
      },
      platform: {
        branchStatus: listed.body.data.status,
        branchNames: listed.body.data.branches.map((branch) => branch.name),
        invalidBranchStatus: invalid.status,
        invalidBranchMessage: invalid.body?.error?.message,
        savedBranch: reloaded.body.data.preferences?.baseBranch,
        savedMode: reloaded.body.data.preferences?.executionMode,
      },
      results,
    };
    await writeFile(
      path.join(EVIDENCE, 'runtime-evidence.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(`evidence: ${path.join(EVIDENCE, 'runtime-evidence.json')}`);
  } finally {
    for (const server of servers.reverse()) {
      await stopChild(server);
    }
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}

main().catch(async (error) => {
  console.error(error);
  record('run', 'fail', error instanceof Error ? error.message : String(error));
  for (const server of servers.reverse()) {
    await stopChild(server).catch(() => {});
  }
  process.exit(1);
});
