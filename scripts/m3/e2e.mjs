#!/usr/bin/env node
/* global fetch, URL, AbortController, setTimeout, clearTimeout, TextDecoder */
/**
 * M3 end-to-end verification on an isolated stack.
 *
 * It starts the built API and dispatcher against a temporary PostgreSQL
 * database and a private, isolated DSH instance (own DSH_HOME/profile/state/
 * port, private test repository). It then drives the real web UI with Playwright
 * and checks the delivery/retry/restart/SSE properties. It never touches the
 * bootstrap instance on 3082, port 4300, nginx or the deployed database.
 *
 * Required environment:
 *   TEST_DATABASE_ADMIN_URL      admin PostgreSQL URL for temporary databases
 *   E2E_REPOSITORY               private test repository (owner/name)
 *   E2E_API_PORT                 isolated API port (default 4301)
 *   E2E_BRIDGE_URL               isolated Bridge URL (default http://127.0.0.1:3191)
 *   E2E_DSH_HOME                 isolated DSH home (default /root/.dsh-m3)
 *   E2E_DSH_PROFILE              isolated DSH profile (default m3)
 *   E2E_DSH_PORT                 isolated DSH web port (default 3192)
 * Optional:
 *   E2E_BASELINE_WEB_DIST        previous (M2) web build for before screenshots
 *   E2E_SKIP_BASELINE=1          skip the baseline screenshots
 *   E2E_OUT                      evidence directory (default docs/evidence/m3)
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { chromium } from 'playwright';

import { assertE2EIsolation, assertInstanceIdentity } from './guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API_PORT = Number(process.env.E2E_API_PORT ?? 4301);
const API_URL = `http://127.0.0.1:${API_PORT}`;
const DSH_HOME = process.env.E2E_DSH_HOME ?? '/root/.dsh-m3';
const DSH_PROFILE = process.env.E2E_DSH_PROFILE ?? 'm3';
const DSH_PORT = Number(process.env.E2E_DSH_PORT ?? 3192);
const DSH_URL = `http://127.0.0.1:${DSH_PORT}`;
const BRIDGE_TARGET_URL = process.env.E2E_BRIDGE_URL ?? 'http://127.0.0.1:3191';
const BRIDGE_PORT = Number(new URL(BRIDGE_TARGET_URL).port || 80);
let BRIDGE_URL = BRIDGE_TARGET_URL;
const REPOSITORY = process.env.E2E_REPOSITORY ?? 'Bouyer12/m3-loop-68fa5d90';
const OUT = resolve(ROOT, process.env.E2E_OUT ?? 'docs/evidence/m3');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(OUT, `run-${STAMP}`);
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const checks = [];
const processes = [];
let ownerId = '';
let sessionToken = '';
let databaseUrl = '';
let databaseName = '';
let conversationId = '';
const NEW_WEB_DIST = resolve(ROOT, 'apps/web/dist');
// Never let the bootstrap shell's DSH_*/MOYU_* variables reach a child or the
// guard. The validated instance env is the only source of MOYU_* values.
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('DSH_') && !key.startsWith('MOYU_'),
  ),
);

function log(message, fields = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), message, ...fields });
  console.log(line);
  const path = join(RUN_DIR, 'run.log');
  if (existsSync(dirname(path))) {
    createWriteStream(path, { flags: 'a' })
      .on('error', () => {})
      .write(`${line}\n`);
  }
}

function record(name, ok, details = {}) {
  checks.push({ name, ok, ...details });
  log(ok ? `check passed: ${name}` : `CHECK FAILED: ${name}`, details);
  if (!ok) {
    throw new Error(`check failed: ${name}`);
  }
}

function hashToken(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function waitFor(label, probe, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${String(lastError)}` : ''}`);
}

async function applyMigrations(client) {
  const dir = join(ROOT, 'packages/db/migrations');
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) {
        await client.query(trimmed);
      }
    }
  }
}

async function createDatabase() {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error('TEST_DATABASE_ADMIN_URL is required');
  }
  databaseName = `moyu_m3_e2e_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
    ownerId = randomUUID();
    sessionToken = randomBytes(32).toString('base64url');
    await client.query(`insert into owners (id, display_name) values ($1, $2)`, [
      ownerId,
      'M3 E2E Owner',
    ]);
    await client.query(
      `insert into sessions (owner_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')`,
      [ownerId, hashToken(sessionToken)],
    );
    await client.query(
      `insert into repositories (owner_id, full_name, default_branch, status)
       values ($1, $2, 'main', 'active')`,
      [ownerId, REPOSITORY],
    );
  } finally {
    await client.end();
  }
}

function apiEnv(webDist) {
  const env = {
    ...BASE_ENV,
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    DATABASE_URL: databaseUrl,
    WEBAUTHN_RP_ID: '127.0.0.1',
    WEBAUTHN_RP_NAME: 'MoYu M3 E2E',
    WEBAUTHN_ORIGIN: API_URL,
    AUTH_COOKIE_SECURE: 'false',
    WEB_DIST_DIR: webDist,
    ARTIFACT_STORAGE_DIR: join(RUN_DIR, 'artifacts'),
    BRIDGE_REPOSITORY: REPOSITORY,
    BRIDGE_URL,
    BRIDGE_TOKEN: process.env.E2E_BRIDGE_TOKEN,
    BRIDGE_CALLBACK_TOKEN: process.env.E2E_CALLBACK_TOKEN,
    BRIDGE_DEFAULT_BRANCH: 'main',
  };
  delete env.TEST_DATABASE_ADMIN_URL;
  return env;
}

function dispatcherEnv() {
  const env = {
    ...BASE_ENV,
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: databaseUrl,
    BRIDGE_REPOSITORY: REPOSITORY,
    BRIDGE_URL,
    BRIDGE_TOKEN: process.env.E2E_BRIDGE_TOKEN,
    DELIVERY_INTERVAL_MS: '200',
    DELIVERY_LEASE_MS: '60000',
    DELIVERY_RETRY_CAP_MS: '2000',
    EVENT_SYNC_INTERVAL_MS: '300',
  };
  delete env.TEST_DATABASE_ADMIN_URL;
  return env;
}

function spawnLogged(name, command, args, options) {
  mkdirSync(RUN_DIR, { recursive: true });
  const fd = openSync(join(RUN_DIR, `${name}.log`), 'a');
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  child.unref();
  const entry = { name, child };
  processes.push(entry);
  log(`started ${name}`, { pid: child.pid });
  return entry;
}

async function stopProcess(entry) {
  if (!entry.child.pid || entry.child.exitCode !== null) {
    return;
  }
  try {
    process.kill(-entry.child.pid, 'SIGTERM');
  } catch {
    entry.child.kill('SIGTERM');
  }
  const deadline = Date.now() + 15000;
  while (entry.child.exitCode === null && Date.now() < deadline) {
    await delay(200);
  }
  if (entry.child.exitCode === null) {
    try {
      process.kill(-entry.child.pid, 'SIGKILL');
    } catch {
      entry.child.kill('SIGKILL');
    }
  }
}

async function stopAll() {
  for (const entry of [...processes].reverse()) {
    await stopProcess(entry);
  }
  processes.length = 0;
}

async function startApi(webDist) {
  const entry = spawnLogged('api', process.execPath, ['apps/api/dist/server.js'], {
    cwd: ROOT,
    env: apiEnv(webDist),
  });
  await waitFor(
    'API ready',
    async () => {
      const response = await fetch(`${API_URL}/readyz`);
      return response.ok;
    },
    30_000,
  );
  return entry;
}

async function stopApi(entry) {
  await stopProcess(entry);
  processes.splice(processes.indexOf(entry), 1);
  await waitFor(
    'API port closed',
    async () => {
      try {
        await fetch(`${API_URL}/healthz`);
        return false;
      } catch {
        return true;
      }
    },
    15_000,
  );
}

async function startDispatcher() {
  return spawnLogged('dispatcher', process.execPath, ['apps/dispatcher/dist/main.js'], {
    cwd: ROOT,
    env: dispatcherEnv(),
  });
}

async function startInstance(isolated) {
  // Only the already-validated home and the whitelisted instance env reach the
  // child; the env file is never re-read here and cannot override DSH_HOME.
  const env = { ...BASE_ENV, DSH_HOME: isolated.dshHome, ...isolated.env };
  mkdirSync(join(RUN_DIR, 'dsh'), { recursive: true });
  const fd = openSync(join(RUN_DIR, 'dsh-instance.log'), 'a');
  const child = spawn('dsh', ['--profile', DSH_PROFILE, '--no-open'], {
    cwd: DSH_HOME,
    env,
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  child.unref();
  const entry = { name: 'dsh', child };
  processes.push(entry);
  const state = await waitFor(
    'DSH instance ready',
    async () => {
      const response = await fetch(`${DSH_URL}/orchestrator/api/state`, {
        headers: { 'x-orchestrator-request': '1' },
      });
      if (!response.ok) {
        return false;
      }
      // A fresh state has no deployment yet; configureInstance sets it. Only
      // the panel socket has to be reachable here.
      return await response.json();
    },
    120_000,
    1000,
  );
  assertInstanceIdentity(state, join(DSH_HOME, 'state', DSH_PROFILE));
  log('isolated DSH instance ready', { port: DSH_PORT });
  return entry;
}

async function stopInstance(entry) {
  await stopProcess(entry);
  processes.splice(processes.indexOf(entry), 1);
  await waitFor(
    'DSH port closed',
    async () => {
      try {
        await fetch(`${DSH_URL}/orchestrator/api/state`, {
          headers: { 'x-orchestrator-request': '1' },
        });
        return false;
      } catch {
        return true;
      }
    },
    30_000,
  );
}

async function panel(path, method = 'GET', body) {
  const response = await fetch(`${DSH_URL}/orchestrator/api${path}`, {
    method,
    headers: {
      'x-orchestrator-request': '1',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `panel ${method} ${path} failed: ${response.status} ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function configureInstanceOnce() {
  const settings = await panel('/settings');
  const blockRevision = (block) => settings.blocks?.[block]?.revision ?? 0;
  const sourceRevision = (id) =>
    settings.sources?.find((source) => source.id === id)?.revision ?? 0;

  await panel('/settings/source%3Agithub', 'PUT', {
    value: {
      enabled: false,
      config: {
        repository: REPOSITORY,
        cli: '/root/.local/bin/gh-agent',
        pollSeconds: 60,
        failuresBeforeError: 3,
        observeIssues: false,
        observePulls: false,
        observeComments: false,
        observeCi: false,
      },
    },
    revision: sourceRevision('github'),
  });
  await panel('/settings/source%3Aworkspace', 'PUT', {
    value: { enabled: true, config: { repository: REPOSITORY } },
    revision: sourceRevision('workspace'),
  });
  await panel('/settings/policy', 'PUT', {
    value: {
      rules: settings.blocks.policy.value.rules,
      sources: {
        workspace: { allowed: [{ id: ownerId }], admission: {} },
      },
    },
    revision: blockRevision('policy'),
  });
  const executorPrepare = [
    'git -c safe.directory="*" clone --no-tags',
    '"ssh://git@ssh.github.com:443/$DSH_SUPERAGENT_WORKSPACE_REPOSITORY.git"',
    '"$DSH_SUPERAGENT_DIR"',
    '&& git -C "$DSH_SUPERAGENT_DIR" -c advice.detachedHead=false checkout "$DSH_SUPERAGENT_WORKSPACE_BASE_COMMIT"',
    '&& git -C "$DSH_SUPERAGENT_DIR" config user.name "Bouyer12"',
    '&& git -C "$DSH_SUPERAGENT_DIR" config user.email "202233540+Bouyer12@users.noreply.github.com"',
    '&& git -C "$DSH_SUPERAGENT_DIR" switch -c "agent/$DSH_SUPERAGENT_NAME"',
  ].join(' ');
  await panel('/settings/executor', 'PUT', {
    value: {
      model: {
        provider: 'commandcode',
        model: 'deepseek/deepseek-v4.1-flash',
        reasoningEffort: 'high',
      },
      maxWorkers: 1,
      directory: '/root/m3-run',
      prepare: executorPrepare,
      blockedCommands: [],
    },
    revision: blockRevision('executor'),
  });
  await panel('/settings/eval', 'PUT', {
    value: {
      mode: 'auto',
      timeoutSeconds: 300,
      model: {
        provider: 'commandcode',
        model: 'deepseek/deepseek-v4.1-flash',
        reasoningEffort: 'low',
      },
    },
    revision: blockRevision('eval'),
  });
  await waitFor(
    'instance configured and ready',
    async () => {
      const state = await panel('/state');
      return state.setup?.accounts?.repository === REPOSITORY &&
        (state.health?.runtime?.state === 'ready' || state.health?.runtime?.state === 'paused')
        ? state
        : false;
    },
    180_000,
  );
  log('instance configured', { policyVersion: (await panel('/settings')).policyVersion });
}

/** Retries configuration across provider/GitHub 503s that are transient. */
async function configureInstance() {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      await configureInstanceOnce();
      return;
    } catch (error) {
      log('instance configuration retry', {
        attempt,
        error: error instanceof Error ? error.message.slice(0, 400) : String(error),
      });
      await delay(10_000);
    }
  }
  throw new Error('instance configuration kept failing');
}

function apiFetch(path, options = {}) {
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: `moyu_session=${sessionToken}`,
      ...options.headers,
    },
  }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`API ${path} failed: ${response.status} ${JSON.stringify(payload)}`);
    }
    return payload.data;
  });
}

async function getConversation(id) {
  return apiFetch(`/api/v1/conversations/${id}`);
}

let cachedRepositoryId = '';

async function resolveRepositoryId() {
  const data = await apiFetch('/api/v1/repositories');
  const repository = data.repositories.find((item) => item.fullName === REPOSITORY);
  if (!repository) {
    throw new Error('configured repository is not visible through the API');
  }
  cachedRepositoryId = repository.id;
  return repository.id;
}

async function postMessage(conversation, clientMessageId, text) {
  return apiFetch(`/api/v1/conversations/${conversation}/messages`, {
    method: 'POST',
    body: JSON.stringify({ clientMessageId, text }),
  });
}

async function listMessages(conversation) {
  return apiFetch(`/api/v1/conversations/${conversation}/messages?limit=100`);
}

/** Reads a delivery row from the platform database for an outage assertion. */
async function deliveryRow(messageId) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `select state, delivered_at from deliveries where message_id = $1 limit 1`,
      [messageId],
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

function sqliteScalar(sql, params = []) {
  const script = `import sqlite3, json, sys\ncon=sqlite3.connect('file:/root/.dsh-m3/state/m3/orchestrator.sqlite?mode=ro', uri=True)\nprint(json.dumps(con.execute(sys.argv[1], json.loads(sys.argv[2])).fetchall()))`;
  const result = spawnSync('python3', ['-c', script, sql, JSON.stringify(params)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`sqlite query failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

function triggerCount(triggerId) {
  return sqliteScalar('select count(*) from trigger where id = ?', [triggerId])[0][0];
}

async function ticketCount() {
  const data = await panel('/tickets?state=all&limit=1000');
  return data.total ?? data.items?.length ?? 0;
}

async function openSse(after, runMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runMs);
  const response = await fetch(`${API_URL}/api/v1/events${after ? `?after=${after}` : ''}`, {
    headers: {
      accept: 'text/event-stream',
      cookie: `moyu_session=${sessionToken}`,
    },
    signal: controller.signal,
  });
  if (!response.ok) {
    clearTimeout(timer);
    throw new Error(`SSE failed: ${response.status}`);
  }
  const events = [];
  const reader = response.body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += new TextDecoder().decode(value);
      for (let index = buffer.indexOf('\n\n'); index >= 0; index = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const idLine = block.split('\n').find((line) => line.startsWith('id: '));
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        if (idLine && dataLine) {
          events.push({ id: idLine.slice(4), data: JSON.parse(dataLine.slice(6)) });
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

async function screenshot(page, name, viewport) {
  await page.setViewportSize(viewport);
  await delay(300);
  const file = join(RUN_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/**
 * A loopback HTTP proxy used once to lose the first successful trigger
 * response: the Bridge has already persisted the Trigger when it replies, but
 * the dispatcher sees the connection die and must retry with the same id.
 */
async function startBridgeFaultProxy(targetUrl) {
  const target = new URL(targetUrl);
  let dropped = 0;
  const server = createHttpServer((request, response) => {
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port || 80),
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: `${target.hostname}:${target.port}` },
      },
      (upstreamResponse) => {
        if (dropped === 0 && request.method === 'POST' && request.url === '/bridge/v1/triggers') {
          dropped += 1;
          // Drain the Bridge response (it already committed) and drop the
          // downstream response, so the platform never receives the receipt.
          upstreamResponse.resume();
          upstreamResponse.on('end', () => response.destroy());
          return;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Bridge fault proxy did not bind');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    get dropped() {
      return dropped;
    },
    close: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      }),
  };
}

async function captureOverview(label, webDist) {
  const api = await startApi(webDist);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [theme, viewport] of [
      ['light', DESKTOP],
      ['light', MOBILE],
      ['dark', DESKTOP],
      ['dark', MOBILE],
    ]) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        baseURL: API_URL,
      });
      await context.addCookies([
        {
          name: 'moyu_session',
          value: sessionToken,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      await page.goto('/');
      await page.locator('main').first().waitFor({ timeout: 30_000 });
      await delay(1500);
      const suffix = `${viewport === DESKTOP ? 'desktop' : 'mobile'}-${theme}`;
      await screenshot(page, `${label}-${suffix}.png`, viewport);
      await context.close();
    }
  } finally {
    await browser.close();
    await stopApi(api);
  }
}

async function main() {
  // Validate the instance configuration before creating a run directory,
  // deleting anything, starting a process, or touching the panel.
  const isolated = await assertE2EIsolation({
    dshHome: DSH_HOME,
    profile: DSH_PROFILE,
    dshPort: DSH_PORT,
    apiPort: API_PORT,
    bridgePort: BRIDGE_PORT,
    envFile: join(DSH_HOME, 'env'),
    processEnv: BASE_ENV,
  });
  mkdirSync(RUN_DIR, { recursive: true });
  log('run directory', { RUN_DIR });
  log('isolation guard passed', {
    dshHome: isolated.dshHome,
    profile: isolated.profile,
    stateDir: isolated.stateDir,
  });
  const bridgeProxy = await startBridgeFaultProxy(BRIDGE_TARGET_URL);
  BRIDGE_URL = bridgeProxy.url;
  log('Bridge fault proxy ready', { url: BRIDGE_URL, target: BRIDGE_TARGET_URL });
  await createDatabase();
  log('temporary database created', { databaseName });

  if (!process.env.E2E_SKIP_BASELINE) {
    const baseline = process.env.E2E_BASELINE_WEB_DIST;
    if (!baseline || !existsSync(join(baseline, 'index.html'))) {
      throw new Error('E2E_BASELINE_WEB_DIST must point at the previous web build');
    }
    log('capturing baseline overview screenshots');
    await captureOverview('before', resolve(baseline));
  }

  const api = await startApi(NEW_WEB_DIST);
  const dispatcher = await startDispatcher();
  // Fresh isolated runtime state per run unless explicitly kept. Only the
  // dedicated E2E state directory is removed; the profile, credentials and
  // build are untouched, and no other profile/state is ever touched.
  if (process.env.E2E_KEEP_STATE !== '1') {
    // Session histories live outside the state directory but are keyed by the
    // workspace path. Removing them keeps a fresh run from reusing the main
    // Session's old transcript (which would make the assessor treat a fresh
    // repository's request as a duplicate of an earlier run).
    rmSync(isolated.stateDir, { recursive: true, force: true });
    rmSync(isolated.sessionsDir, { recursive: true, force: true });
  }
  const instance = await startInstance(isolated);
  await configureInstance();
  await resolveRepositoryId();
  record('private test repository is bound through the Bridge config', true, {
    repository: REPOSITORY,
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: 'light',
    baseURL: API_URL,
  });
  await context.addCookies([
    {
      name: 'moyu_session',
      value: sessionToken,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage();

  try {
    await page.goto('/');
    await page.locator('main').first().waitFor({ timeout: 30_000 });
    await delay(1200);
    await screenshot(page, 'after-desktop-light.png', DESKTOP);

    const mobileContext = await browser.newContext({
      viewport: MOBILE,
      colorScheme: 'light',
      baseURL: API_URL,
    });
    await mobileContext.addCookies([
      {
        name: 'moyu_session',
        value: sessionToken,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto('/');
    await mobilePage
      .locator('strong', { hasText: REPOSITORY })
      .first()
      .waitFor({ timeout: 30_000 });
    await delay(800);
    await screenshot(mobilePage, 'after-mobile-light.png', MOBILE);
    await mobileContext.close();

    for (const [theme, viewport] of [
      ['dark', DESKTOP],
      ['dark', MOBILE],
    ]) {
      const darkContext = await browser.newContext({
        viewport,
        colorScheme: theme,
        baseURL: API_URL,
      });
      await darkContext.addCookies([
        {
          name: 'moyu_session',
          value: sessionToken,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);
      const darkPage = await darkContext.newPage();
      await darkPage.goto('/');
      await darkPage.locator('main').first().waitFor({ timeout: 30_000 });
      await delay(1200);
      await screenshot(
        darkPage,
        `after-${viewport === DESKTOP ? 'desktop' : 'mobile'}-dark.png`,
        viewport,
      );
      await darkContext.close();
    }

    // New task through the real UI.
    await page.getByRole('button', { name: '新建任务' }).first().click();
    await page.getByRole('heading', { name: /开始任务/ }).waitFor({ timeout: 30_000 });
    const modelSelect = page.getByLabel('模型');
    await waitFor(
      'model catalog loaded',
      async () => (await modelSelect.locator('option').count()) > 1,
      30_000,
    );
    await modelSelect.selectOption({ index: 1 });
    const effort = page.getByLabel('推理强度');
    if ((await effort.count()) > 0) {
      const options = await effort.locator('option').allTextContents();
      if (options.includes('high')) {
        await effort.selectOption('high');
      }
    }
    await page.getByRole('button', { name: '创建任务' }).click();
    const composer = page.getByLabel('消息输入区');
    await composer.waitFor({ timeout: 30_000 });

    const taskText =
      "README.md 第 5 行里的 'teh' 是拼写错误，但目标措辞需要我来决定：可能是 'the'，也可能是 'this'。" +
      '请不要自己判断或先改文件；先通过平台向我提问确认要用哪个词。我回复后再只改这一处、运行检查，' +
      '并在当前已检出的工作分支提交推送、用同一个分支名打开 PR；不要改 CHANGELOG，也不要另建分支。';
    await composer.fill(taskText);
    await composer.press('Enter');

    const conversations = await waitFor(
      'conversation appears',
      async () => {
        const list = await apiFetch(`/api/v1/conversations?repositoryId=${cachedRepositoryId}`);
        return list.conversations.length > 0 ? list.conversations : false;
      },
      30_000,
    );
    conversationId = conversations[0].id;
    const taskMessage = (await listMessages(conversationId)).messages.find(
      (message) => message.direction === 'inbound',
    );
    if (!taskMessage) {
      throw new Error('the new conversation has no inbound task message');
    }
    const mainTriggerId = `workspace:${taskMessage.id}`;
    record('web created a conversation with a pending task', true, {
      conversationId,
      messageId: taskMessage.id,
    });

    const linkedTask = await waitFor(
      'task linked to an upstream Ticket',
      async () => {
        const data = await getConversation(conversationId);
        return data.conversation.task?.upstreamTicketId ? data.conversation.task : false;
      },
      5 * 60_000,
      2000,
    );
    const frozenBaseCommit = linkedTask.baseCommit;
    record('superagent accepted the task and linked its Ticket', true, {
      ticketId: linkedTask.upstreamTicketId,
      baseCommit: frozenBaseCommit,
    });

    const questionState = await waitFor(
      'worker asks a question',
      async () => {
        const data = await getConversation(conversationId);
        const task = data.conversation.task;
        return task?.question && task.state === 'waiting_input' ? task : false;
      },
      10 * 60_000,
      2000,
    );
    record('worker question reached the web conversation', true, {
      question: questionState.question,
    });
    await page.getByText(questionState.question, { exact: false }).first().waitFor({
      timeout: 30_000,
    });
    await screenshot(page, 'after-question-light.png', DESKTOP);
    await page.emulateMedia({ colorScheme: 'dark' });
    await screenshot(page, 'after-question-dark.png', DESKTOP);
    await page.emulateMedia({ colorScheme: 'light' });

    await composer.fill("用 'the'，只改 README，不用改 CHANGELOG。");
    await composer.press('Enter');

    const replyMessage = await waitFor(
      'reply message stored',
      async () => {
        const messages = (await listMessages(conversationId)).messages;
        return messages.find(
          (message) => message.direction === 'inbound' && message.body.includes("用 'the'"),
        );
      },
      30_000,
    );
    const readReply = await waitFor(
      'reply delivery reaches read with executor evidence',
      async () => {
        const message = (await listMessages(conversationId)).messages.find(
          (item) => item.id === replyMessage.id,
        );
        return message?.delivery?.state === 'read' ? message : false;
      },
      120_000,
    );
    record('reply delivery reached read from worker session evidence', true, {
      messageId: readReply.id,
      readAt: readReply.delivery?.readAt,
    });

    const reviewState = await waitFor(
      'task reaches awaiting review with a PR',
      async () => {
        const data = await getConversation(conversationId);
        const task = data.conversation.task;
        return task?.prUrl && ['awaiting_review', 'completed'].includes(task.state) ? task : false;
      },
      20 * 60_000,
      3000,
    );
    record('worker delivered a pull request', true, {
      prUrl: reviewState.prUrl,
      prNumber: reviewState.prNumber,
      state: reviewState.state,
    });
    const detailToggle = page.getByRole('button', { name: /展开右侧详情|收起右侧详情/ });
    if ((await detailToggle.count()) > 0) {
      await detailToggle.first().click();
    }
    await page
      .getByText(new RegExp(`PR #${reviewState.prNumber}`))
      .first()
      .waitFor({
        timeout: 30_000,
      });
    await screenshot(page, 'after-review-light.png', DESKTOP);
    await page.emulateMedia({ colorScheme: 'dark' });
    await screenshot(page, 'after-review-dark.png', DESKTOP);
    await page.emulateMedia({ colorScheme: 'light' });

    const prView = spawnSync(
      'gh',
      [
        'pr',
        'view',
        String(reviewState.prNumber),
        '--repo',
        REPOSITORY,
        '--json',
        'state,mergedAt,headRefName,baseRefName,url',
      ],
      { encoding: 'utf8' },
    );
    record('pull request exists in the private test repository', prView.status === 0, {
      stdout: prView.stdout?.slice(0, 2000),
      stderr: prView.stderr?.slice(0, 500),
    });

    const ticketsBefore = await ticketCount();

    // Same clientMessageId submitted concurrently: one message, one delivery, one trigger.
    const duplicateId = `e2e-duplicate-${randomUUID()}`;
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        postMessage(conversationId, duplicateId, '收到，谢谢。').then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ),
      ),
    );
    const okCount = attempts.filter((attempt) => attempt.ok).length;
    record('all concurrent retries of one clientMessageId returned a result', okCount === 5, {
      okCount,
    });
    const duplicateMessageId = attempts.find((attempt) => attempt.ok)?.value.message.id;
    const duplicateMessages = (await listMessages(conversationId)).messages.filter(
      (message) => message.clientMessageId === duplicateId,
    );
    record('same clientMessageId produced exactly one message', duplicateMessages.length === 1, {
      duplicateId,
    });
    const triggerId = `workspace:${duplicateMessageId}`;
    await waitFor(
      'duplicate message delivered',
      async () => {
        const data = await getConversation(conversationId);
        const message = (await listMessages(conversationId)).messages.find(
          (item) => item.id === duplicateMessageId,
        );
        return message && ['delivered', 'read'].includes(message.delivery?.state ?? '')
          ? data
          : false;
      },
      60_000,
    );
    record(
      'duplicate retries produced exactly one upstream Trigger',
      triggerCount(triggerId) === 1,
      { triggerId },
    );
    record(
      'duplicate retries did not create another Ticket',
      (await ticketCount()) === ticketsBefore,
    );

    // SSE: the replay is ordered and duplicate-free, and a real Last-Event-ID
    // reconnect backfills the gap contiguously with the expected event types.
    const firstStream = await openSse(undefined, 3000);
    const firstIds = firstStream.map((event) => Number(event.id));
    record(
      'SSE replay delivered the durable event history in order, once each',
      firstIds.length > 0 &&
        firstIds.every((id, index) => index === 0 || id > firstIds[index - 1]) &&
        new Set(firstIds).size === firstIds.length,
      { eventCount: firstStream.length, firstIds },
    );
    const lastId = firstStream.at(-1).id;
    const liveClientId = `e2e-sse-${randomUUID()}`;
    const liveMessage = await postMessage(conversationId, liveClientId, '确认，继续即可。');
    const replayed = await openSse(lastId, 6000);
    const replayIds = replayed.map((event) => Number(event.id));
    const contiguousFrom = Number(lastId) + 1;
    record(
      'SSE reconnect filled the gap in order, without duplicates or omissions',
      replayIds.length > 0 &&
        replayIds[0] === contiguousFrom &&
        replayIds.every((id, index) => index === 0 || id === replayIds[index - 1] + 1) &&
        new Set(replayIds).size === replayIds.length,
      { lastId, replayIds },
    );
    record(
      'SSE reconnect carried the expected message events',
      replayed.some(
        (event) =>
          event.data?.type === 'message.created' &&
          event.data?.data?.messageId === liveMessage.message.id,
      ) &&
        replayed.some(
          (event) =>
            event.data?.type === 'message.delivery_changed' &&
            event.data?.data?.messageId === liveMessage.message.id,
        ),
      { liveMessageId: liveMessage.message.id },
    );

    // Lost receipt: force an already delivered row back to pending; the Bridge
    // deduplicates the same Trigger id and the platform marks it delivered once.
    const frozenBeforeLostReceipt = (await getConversation(conversationId)).conversation.baseCommit;
    const lostReceiptMessage = (await listMessages(conversationId)).messages.find(
      (message) => message.id === duplicateMessageId,
    );
    if (!lostReceiptMessage) {
      throw new Error('lost-receipt fixture message missing');
    }
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(
        `update deliveries set state='pending', delivered_at=null, read_at=null,
                handed_to_worker_at=null, evidence='{}'::jsonb,
                next_attempt_at=now(), lease_owner=null, lease_expires_at=null
          where message_id=$1`,
        [duplicateMessageId],
      );
    } finally {
      await client.end();
    }
    await waitFor(
      'lost receipt recovered',
      async () => {
        const message = (await listMessages(conversationId)).messages.find(
          (item) => item.id === duplicateMessageId,
        );
        return message && ['delivered', 'read'].includes(message.delivery?.state ?? '')
          ? message
          : false;
      },
      60_000,
    );
    record(
      'redelivery after a lost receipt stayed deduplicated upstream',
      triggerCount(triggerId) === 1,
      { triggerId },
    );
    record('redelivery did not create another Ticket', (await ticketCount()) === ticketsBefore);
    const frozenAfterLostReceipt = (await getConversation(conversationId)).conversation.baseCommit;
    record(
      'redelivery kept the first frozen base commit',
      Boolean(frozenBeforeLostReceipt) && frozenAfterLostReceipt === frozenBeforeLostReceipt,
      { frozenBeforeLostReceipt, frozenAfterLostReceipt },
    );

    // API restart: stop the dispatcher, accept a message, restart the API, then
    // start the dispatcher again; the message is still delivered exactly once.
    await stopProcess(dispatcher);
    processes.splice(processes.indexOf(dispatcher), 1);
    const restartConversation = (
      await apiFetch('/api/v1/conversations', {
        method: 'POST',
        body: JSON.stringify({
          repositoryId: cachedRepositoryId,
          mode: 'work',
          executionMode: 'execute',
          baseBranch: 'main',
          model: {
            provider: 'commandcode',
            model: 'deepseek/deepseek-v4.1-flash',
            reasoningEffort: 'low',
          },
          clientRequestId: `e2e-restart-${randomUUID()}`,
        }),
      })
    ).conversation;
    const restartClientId = `e2e-restart-${randomUUID()}`;
    const acceptedBeforeRestart = await postMessage(
      restartConversation.id,
      restartClientId,
      '可靠性验证：这条消息只用于确认重启后不丢失、不重复投递，请忽略。',
    );
    record('API accepted the message before restart', acceptedBeforeRestart.duplicate === false);
    await stopApi(api);
    const restartedApi = await startApi(NEW_WEB_DIST);
    const afterRestart = await listMessages(restartConversation.id);
    record(
      'API restart kept the accepted message and its pending delivery',
      afterRestart.messages.some((message) => message.clientMessageId === restartClientId),
      { messageCount: afterRestart.messages.length },
    );
    await startDispatcher();
    const restartMessage = afterRestart.messages.find(
      (message) => message.clientMessageId === restartClientId,
    );
    await waitFor(
      'message delivered after API restart',
      async () => {
        const message = (await listMessages(restartConversation.id)).messages.find(
          (item) => item.id === restartMessage.id,
        );
        return message && ['delivered', 'read'].includes(message.delivery?.state ?? '')
          ? message
          : false;
      },
      90_000,
    );
    const restartTriggerCount = triggerCount(`workspace:${restartMessage.id}`);
    record('API restart delivered exactly one upstream Trigger', restartTriggerCount === 1, {
      triggerId: `workspace:${restartMessage.id}`,
      triggerCount: restartTriggerCount,
    });

    // Bridge restart: a message accepted while the runtime is down is retried
    // and delivered once after the Bridge comes back.
    await stopInstance(instance);
    const bridgeConversation = (
      await apiFetch('/api/v1/conversations', {
        method: 'POST',
        body: JSON.stringify({
          repositoryId: cachedRepositoryId,
          mode: 'work',
          executionMode: 'execute',
          baseBranch: 'main',
          model: {
            provider: 'commandcode',
            model: 'deepseek/deepseek-v4.1-flash',
            reasoningEffort: 'low',
          },
          clientRequestId: `e2e-bridge-${randomUUID()}`,
        }),
      })
    ).conversation;
    const bridgeClientId = `e2e-bridge-${randomUUID()}`;
    await postMessage(
      bridgeConversation.id,
      bridgeClientId,
      '可靠性验证：Bridge 重启后这条消息只能投递一次，请忽略。',
    );
    await delay(2000);
    const pending = (await listMessages(bridgeConversation.id)).messages.find(
      (message) => message.clientMessageId === bridgeClientId,
    );
    if (!pending) {
      throw new Error('Bridge outage fixture message is missing');
    }
    const persistedDelivery = await deliveryRow(pending.id);
    record(
      'Bridge outage kept the message and delivery, not yet delivered',
      Boolean(pending) &&
        persistedDelivery !== null &&
        persistedDelivery.state !== 'delivered' &&
        persistedDelivery.delivered_at === null,
      {
        state: pending?.delivery?.state,
        persistedState: persistedDelivery?.state ?? null,
        deliveredAt: persistedDelivery?.delivered_at ?? null,
      },
    );
    const restartedInstance = await startInstance(isolated);
    await waitFor(
      'message delivered after Bridge restart',
      async () => {
        const message = (await listMessages(bridgeConversation.id)).messages.find(
          (item) => item.id === pending.id,
        );
        return message && ['delivered', 'read'].includes(message.delivery?.state ?? '')
          ? message
          : false;
      },
      180_000,
    );
    record(
      'Bridge restart delivered the message once',
      triggerCount(`workspace:${pending.id}`) === 1,
      { trigger: `workspace:${pending.id}` },
    );

    record(
      'first successful Bridge receipt was lost at the HTTP response and retried once',
      bridgeProxy.dropped === 1 && triggerCount(mainTriggerId) === 1,
      { droppedResponses: bridgeProxy.dropped, trigger: mainTriggerId },
    );
    const finalConversation = await getConversation(conversationId);
    const platformTicketId = finalConversation.conversation.task?.upstreamTicketId;
    if (!platformTicketId) {
      throw new Error('task lost its upstream ticket');
    }
    const ticketResponse = await fetch(
      `${BRIDGE_TARGET_URL}/bridge/v1/tickets/${encodeURIComponent(platformTicketId)}`,
      { headers: { authorization: `Bearer ${process.env.E2E_BRIDGE_TOKEN}` } },
    );
    if (!ticketResponse.ok) {
      throw new Error(`Bridge ticket read failed: ${ticketResponse.status}`);
    }
    const bridgeTicket = await ticketResponse.json();
    record(
      'platform and Ticket froze the same base commit',
      Boolean(frozenBaseCommit) &&
        finalConversation.conversation.task?.baseCommit === frozenBaseCommit &&
        bridgeTicket.base?.commit === frozenBaseCommit,
      {
        platformBase: finalConversation.conversation.task?.baseCommit,
        ticketBase: bridgeTicket.base?.commit,
      },
    );

    await bridgeProxy.close();
    await writeFile(
      join(RUN_DIR, 'e2e-result.json'),
      `${JSON.stringify({ ok: true, checks, conversationId, repository: REPOSITORY, runAt: STAMP }, null, 2)}\n`,
    );
    log('E2E completed');
    void restartedApi;
    void restartedInstance;
    void restartedInstance;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  log('E2E failed', { error: error instanceof Error ? error.stack : String(error) });
  await writeFile(
    join(RUN_DIR, 'e2e-result.json'),
    `${JSON.stringify({ ok: false, error: String(error), checks }, null, 2)}\n`,
  ).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await stopAll();
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (adminUrl && databaseName) {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}
