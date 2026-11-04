#!/usr/bin/env node
/**
 * M4-UX real-browser acceptance run.
 *
 * Uses one isolated PostgreSQL database, the real API process, the real built
 * Web shell and Playwright Chromium. A loopback HTTP server stands in for the
 * repository Bridge only for the read-only model/branch catalogs, so preference
 * validation can be exercised without starting another execution runtime; no
 * task delivery, stop, resume or PR result is claimed from it.
 *
 * Before screenshots are captured from an actual build of the recorded baseline
 * commit in a detached worktree. The same database, fake catalog, browser,
 * viewport and theme are used for both builds.
 *
 * Usage:
 *   TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
 *     node scripts/m4ux/e2e.mjs [--skip-build] [--keep]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { chromium } from 'playwright';

const { Client } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = path.join(ROOT, 'docs/evidence/m4ux');
const BASE_SHA = process.env.M4UX_BASE_SHA ?? '40e857a9081b281fb3a93ebaea6986e0101f005d';
const BEFORE_DIR = path.join('/root/src', 'm4ux-before');
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const BRIDGE_TOKEN = 'm4ux-bridge-token-0123456789';
const BRIDGE_PORT = Number(process.env.M4UX_BRIDGE_PORT ?? 4410);
const AFTER_PORT = Number(process.env.M4UX_AFTER_PORT ?? 4400);
const BEFORE_PORT = Number(process.env.M4UX_BEFORE_PORT ?? 4401);
const SKIP_BUILD = process.argv.includes('--skip-build');
const KEEP = process.argv.includes('--keep');
const DB_PREFIX = 'moyu_m4ux_e2e';

if (!ADMIN_URL) {
  console.error('TEST_DATABASE_ADMIN_URL is required');
  process.exit(2);
}

const results = [];
const servers = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  const marker = status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${name}${detail ? `: ${detail}` : ''}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hashSecret(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) {
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`API did not become healthy at ${url}: ${last}`);
}

async function createDatabase() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const name = `${DB_PREFIX}_${process.pid}_${randomBytes(4).toString('hex')}`;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropDatabase(name) {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function migrate(databaseUrl) {
  run(
    path.join(ROOT, 'packages/db/node_modules/.bin/tsx'),
    [path.join(ROOT, 'packages/db/src/cli/migrate.ts')],
    { env: { DATABASE_URL: databaseUrl } },
  );
}

function buildWorktree(worktree) {
  run('corepack', ['pnpm@11.7.0', '--filter', '@moyu/web', 'exec', 'vite', 'build'], {
    cwd: worktree,
  });
  run('corepack', ['pnpm@11.7.0', '--filter', '@moyu/api', 'exec', 'tsup'], { cwd: worktree });
}

function ensureBeforeWorktree() {
  if (existsSync(path.join(BEFORE_DIR, 'apps/api/dist/server.js'))) {
    return;
  }
  if (!existsSync(path.join(BEFORE_DIR, 'package.json'))) {
    run('git', ['worktree', 'add', '--detach', BEFORE_DIR, BASE_SHA]);
  }
  if (!existsSync(path.join(BEFORE_DIR, 'node_modules'))) {
    run('corepack', ['pnpm@11.7.0', 'install', '--frozen-lockfile'], { cwd: BEFORE_DIR });
  }
  buildWorktree(BEFORE_DIR);
}

async function startApi(worktree, port) {
  const child = spawn(process.execPath, ['apps/api/dist/server.js'], {
    cwd: worktree,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      DATABASE_URL: currentDatabase.url,
      WEB_DIST_DIR: path.join(worktree, 'apps/web/dist'),
      WEBAUTHN_RP_ID: '127.0.0.1',
      WEBAUTHN_RP_NAME: 'MoYu M4-UX',
      WEBAUTHN_ORIGIN: `http://127.0.0.1:${port}`,
      AUTH_COOKIE_SECURE: 'false',
      BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
      BRIDGE_TOKEN,
      BRIDGE_TIMEOUT_MS: '5000',
      ARTIFACT_STORAGE_DIR: path.join(worktree, '.local/m4ux-artifacts'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  servers.push(child);
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url);
  } catch (error) {
    throw new Error(`${error.message}\nAPI output:\n${output.slice(-4000)}`);
  }
  return {
    url,
    origin: url,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

let currentDatabase = null;

/* -------------------------------- dispatcher ------------------------------- */

async function startDispatcher(repositoryFullName) {
  const child = spawn(process.execPath, ['apps/dispatcher/dist/main.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: currentDatabase.url,
      BRIDGE_REPOSITORY: repositoryFullName,
      BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`,
      BRIDGE_TOKEN,
      DELIVERY_INTERVAL_MS: '200',
      EVENT_SYNC_INTERVAL_MS: '200',
      OPERATION_INTERVAL_MS: '500',
      DUPLICATE_INTERVAL_MS: '500',
      REPORT_CAPTURE_INTERVAL_MS: '1000',
      RECONCILE_ON_START: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  servers.push(child);
  await new Promise((resolve) => setTimeout(resolve, 800));
  return {
    output: () => output,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/* ------------------------------- fake Bridge ------------------------------- */

const bridgeState = {
  capabilities: { branches: true },
  models: [
    {
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      reasoningEfforts: ['low', 'high'],
    },
    {
      provider: 'commandcode',
      model: 'second-model',
      displayName: 'Second Model',
      reasoningEfforts: [],
    },
  ],
  branches: ['main', 'release', 'feature-x'],
  calls: [],
  // Real dispatch-path state: one trigger is accepted, then an optional read
  // event is served so the actual dispatcher writes delivered/read transitions.
  deliveryCalls: 0,
  ticketCalls: 0,
  eventsCursor: 0,
  readEvent: null,
  lastTrigger: null,
};

function startFakeBridge() {
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${BRIDGE_TOKEN}`) {
      send(401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    bridgeState.calls.push(url.pathname);
    if (url.pathname === '/bridge/v1/capabilities') {
      send(200, {
        protocolVersion: 'moyu-bridge/1',
        upstream: { package: 'dsh-superagent', version: '0.1.0', commit: BASE_SHA },
        capabilities: {
          trigger: true,
          events: true,
          tickets: true,
          models: true,
          pause: true,
          resume: true,
          retry: true,
          readOnlyDiscussion: true,
          start: true,
          branches: bridgeState.capabilities.branches,
        },
        source: { kind: 'workspace', enabled: true },
      });
      return;
    }
    if (url.pathname === '/bridge/v1/models') {
      send(200, { models: bridgeState.models });
      return;
    }
    if (url.pathname === '/bridge/v1/triggers' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      bridgeState.deliveryCalls += 1;
      bridgeState.lastTrigger = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const triggerId = String(bridgeState.lastTrigger?.triggerId ?? 'm4ux-trigger');
      send(200, {
        result: 'stored',
        triggerId,
        baseCommit: 'abcdef1234567890abcdef1234567890abcdef12',
        ticketId: 'm4ux-runtime-ticket',
      });
      return;
    }
    if (url.pathname === '/bridge/v1/events') {
      const afterRaw = Number(url.searchParams.get('after') ?? '0');
      const after = Number.isFinite(afterRaw) ? afterRaw : 0;
      const events = [];
      if (bridgeState.readEvent && after < bridgeState.readEvent.seq) {
        events.push(bridgeState.readEvent);
      }
      const next = events.at(-1)?.seq ?? after;
      send(200, { events, next, hasMore: false });
      return;
    }
    if (url.pathname.startsWith('/bridge/v1/tickets/')) {
      bridgeState.ticketCalls += 1;
      send(200, {
        ticketId: decodeURIComponent(url.pathname.split('/').at(-1) ?? ''),
        title: 'M4-UX runtime evidence ticket',
        state: 'running',
        mode: 'execute',
        planRevision: null,
        paused: null,
        ended: null,
        assignmentId: null,
        execution: null,
      });
      return;
    }
    if (url.pathname.startsWith('/bridge/v1/operations/')) {
      send(404, { error: 'Unknown operation' });
      return;
    }
    if (url.pathname === '/bridge/v1/branches') {
      if (!bridgeState.capabilities.branches) {
        send(404, { error: 'Unknown operation' });
        return;
      }
      send(200, {
        branches: bridgeState.branches.map((name) => ({
          name,
          commit: `${name}`.padEnd(40, '0').slice(0, 40),
        })),
        hasMore: false,
      });
      return;
    }
    send(404, { error: 'Unknown operation' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BRIDGE_PORT, '127.0.0.1', () => {
      resolve({
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/* ---------------------------------- seed ----------------------------------- */

async function seed(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const query = (text, values) => pool.query(text, values);
  const owner = await query(`insert into owners (display_name) values ($1) returning id`, [
    'M4-UX Owner',
  ]);
  const ownerId = owner.rows[0].id;
  const sessionToken = randomBytes(32).toString('base64url');
  await query(
    `insert into sessions (owner_id, token_hash, expires_at)
     values ($1, $2, now() + interval '1 day')`,
    [ownerId, hashSecret(sessionToken)],
  );

  const repoA = await query(
    `insert into repositories (owner_id, full_name, default_branch, status, bridge_url)
     values ($1, $2, 'main', 'active', $3) returning id`,
    [ownerId, 'bouyer-sutrasky/m4ux-main', `http://127.0.0.1:${BRIDGE_PORT}`],
  );
  const repoB = await query(
    `insert into repositories (owner_id, full_name, default_branch, status, bridge_url)
     values ($1, $2, 'main', 'active', $3) returning id`,
    [ownerId, 'bouyer-sutrasky/m4ux-other', `http://127.0.0.1:${BRIDGE_PORT}`],
  );
  const repositoryA = repoA.rows[0].id;
  const repositoryB = repoB.rows[0].id;

  const modelId = 'commandcode/deepseek/deepseek-v4.1-flash';
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  async function conversation({
    repositoryId,
    title,
    updatedAt,
    executionMode = 'execute',
    source = 'web',
    externalKey = null,
    externalUrl = null,
    baseBranch = 'main',
    model = modelId,
  }) {
    const row = await query(
      `insert into conversations
         (owner_id, repository_id, mode, execution_mode, source, external_key, external_url,
          base_branch, model_id, model_reasoning_effort, title, created_at, updated_at)
       values ($1,$2,'work',$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
      [
        ownerId,
        repositoryId,
        executionMode,
        source,
        externalKey,
        externalUrl,
        baseBranch,
        model,
        model ? 'high' : null,
        title,
        iso(updatedAt),
      ],
    );
    return row.rows[0].id;
  }

  async function task(conversationId, repositoryId, state, overrides = {}) {
    const row = await query(
      `insert into task_links
         (conversation_id, repository_id, state, version, base_branch, base_commit, model_id,
          model_reasoning_effort, execution_mode, upstream_ticket_id, stopped_at, stop_evidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [
        conversationId,
        repositoryId,
        state,
        overrides.version ?? 3,
        overrides.baseBranch ?? 'main',
        overrides.baseCommit ?? 'abcdef1234567890abcdef1234567890abcdef12',
        overrides.model === null ? null : (overrides.model ?? modelId),
        overrides.model === null ? null : (overrides.reasoningEffort ?? 'high'),
        overrides.executionMode ?? 'execute',
        overrides.upstreamTicketId ?? null,
        overrides.stoppedAt ?? null,
        overrides.stopEvidence ?? {},
      ],
    );
    return row.rows[0].id;
  }

  async function message(
    conversationId,
    { direction = 'inbound', kind = 'user', body, createdAt, read = false, replyTo = null },
  ) {
    const row = await query(
      `insert into messages (conversation_id, direction, kind, body, reply_to_message_id, source, created_at)
       values ($1,$2,$3,$4,$5,'web',$6) returning id`,
      [conversationId, direction, kind, body, replyTo, iso(createdAt)],
    );
    const messageId = row.rows[0].id;
    await query(
      `insert into deliveries
         (message_id, state, attempt_count, upstream_trigger_id, delivered_at, handed_to_worker_at, read_at, evidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        messageId,
        read ? 'delivered' : 'pending',
        read ? 1 : 0,
        `workspace:${messageId}`,
        read ? iso(createdAt + 1000) : null,
        read ? iso(createdAt + 1500) : null,
        read ? iso(createdAt + 2000) : null,
        read ? { result: 'stored' } : {},
      ],
    );
    return messageId;
  }

  const historyId = await conversation({
    repositoryId: repositoryA,
    title: '历史分页验证',
    updatedAt: now + 3_600_000,
  });
  await task(historyId, repositoryA, 'pending_admission', { upstreamTicketId: 'ticket-history' });

  const messageIds = [];
  const messageBodies = [];
  const base = now - 400_000;
  for (let index = 0; index < 250; index += 1) {
    const createdAt = base + Math.floor(index / 3) * 1_000;
    const inbound = index % 4 !== 3;
    const body = inbound
      ? `历史消息 #${String(index + 1).padStart(3, '0')}`
      : `执行器回复 #${index + 1}`;
    const id = await message(historyId, {
      direction: inbound ? 'inbound' : 'outbound',
      kind: inbound ? 'user' : 'reply',
      body,
      createdAt,
      read: index === 240,
    });
    messageIds.push(id);
    messageBodies.push(body);
  }

  const secondId = await conversation({
    repositoryId: repositoryA,
    title: '草稿与发送验证',
    updatedAt: now + 2_400_000,
  });
  await task(secondId, repositoryA, 'pending_admission', { upstreamTicketId: 'ticket-second' });
  await message(secondId, { body: '第二会话的初始消息', createdAt: now - 120_000 });

  const stoppedId = await conversation({
    repositoryId: repositoryA,
    title: '已停止任务',
    updatedAt: now + 1_800_000,
  });
  await task(stoppedId, repositoryA, 'stopped', {
    upstreamTicketId: 'ticket-stopped',
    version: 7,
    createdAt: now - 500_000,
    stoppedAt: iso(now - 600_000),
    stopEvidence: {
      harnessPid: 40127,
      agentStatus: 'idle',
      jobsBefore: [],
      jobsAfter: [],
      subagentsAfter: 0,
      ticketId: 'ticket-stopped',
    },
  });
  await message(stoppedId, { body: '停止前的任务说明', createdAt: now - 900_000 });

  const githubId = await conversation({
    repositoryId: repositoryA,
    title: 'GitHub 汇入任务',
    updatedAt: now + 1_200_000,
    source: 'github',
    externalKey: 'github:42',
    externalUrl: 'https://github.com/bouyer-sutrasky/m4ux-main/pull/42',
  });
  await task(githubId, repositoryA, 'awaiting_review', {
    upstreamTicketId: 'github-ticket-42',
    version: 5,
  });
  await message(githubId, {
    direction: 'outbound',
    kind: 'result',
    body: 'GitHub 汇入任务的执行结果',
    createdAt: now - 300_000,
  });

  const otherId = await conversation({
    repositoryId: repositoryB,
    title: '另一个仓库的任务',
    updatedAt: now + 600_000,
  });
  await task(otherId, repositoryB, 'pending_admission', { upstreamTicketId: 'ticket-other' });
  const otherMessageId = await message(otherId, {
    body: '另一个仓库的消息',
    createdAt: now - 200_000,
  });

  const taskTitles = [];
  for (let index = 0; index < 120; index += 1) {
    const title = `历史任务 ${String(index + 1).padStart(3, '0')}`;
    taskTitles.push(title);
    const id = await conversation({
      repositoryId: repositoryA,
      title,
      updatedAt: now - Math.floor(index / 2) * 60_000 - 1_000,
    });
    await task(id, repositoryA, index % 3 === 0 ? 'completed' : 'pending_admission');
  }

  await pool.end();
  return {
    ownerId,
    sessionToken,
    repositoryA,
    repositoryB,
    historyId,
    secondId,
    stoppedId,
    githubId,
    otherId,
    otherMessageId,
    messageIds,
    messageBodies,
    taskTitles,
    modelId,
  };
}

/* --------------------------------- browser --------------------------------- */

function cookieFor(token, baseURL) {
  return {
    name: 'moyu_session',
    value: token,
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax',
  };
}

async function newContext(browser, { baseURL, token, viewport, theme }) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN' });
  await context.addCookies([cookieFor(token, baseURL)]);
  await context.addInitScript((value) => {
    try {
      window.localStorage.setItem('moyu.theme', value);
    } catch {
      /* ignore */
    }
  }, theme);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  await page.getByText('MoYu', { exact: true }).first().waitFor();
  await page.getByRole('complementary', { name: '工作台导航' }).waitFor();
  return { context, page };
}

function sidebar(page) {
  return page.getByRole('complementary', { name: '工作台导航' });
}

async function openConversationById(page, conversationId) {
  const item = sidebar(page).locator(`[data-conversation-id="${conversationId}"]`).first();
  await item.waitFor();
  await item.click();
  await page.getByRole('region', { name: '会话消息' }).waitFor();
  await page.getByRole('heading', { name: '未命名任务', exact: true }).waitFor();
}

async function createWebConversation(baseURL, token, repositoryId) {
  const response = await apiFetch(baseURL, token, '/api/v1/conversations', {
    method: 'POST',
    body: {
      repositoryId,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      model: {
        provider: 'commandcode',
        model: 'deepseek/deepseek-v4.1-flash',
        reasoningEffort: 'high',
      },
      clientRequestId: `m4ux-merge-${randomUUID()}`,
    },
  });
  assert(response.status === 201, `after: merge source conversation created (${response.status})`);
  return response.payload.data.conversation.id;
}

async function openConversation(page, title) {
  const item = sidebar(page).locator('button', { hasText: title }).first();
  await item.waitFor();
  await item.click();
  await page.getByRole('region', { name: '会话消息' }).waitFor();
  // The region already exists when switching conversations; wait for the
  // header so the composer has also switched to the selected conversation.
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}

async function messageCount(page) {
  // Works for both builds: the baseline predates the data-message-id attribute.
  return page.locator('section[aria-label="会话消息"] article').count();
}

async function waitForMessageCount(page, expected) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-message-id]').length === count,
    expected,
    { timeout: 15_000 },
  );
}

async function firstVisibleAnchor(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return null;
    const top = main.getBoundingClientRect().top;
    const items = [...document.querySelectorAll('[data-message-id]')];
    const first = items.find((item) => item.getBoundingClientRect().bottom > top + 1);
    return first
      ? {
          id: first.getAttribute('data-message-id'),
          top: first.getBoundingClientRect().top,
          scrollTop: main.scrollTop,
          scrollHeight: main.scrollHeight,
        }
      : null;
  });
}

async function messageTop(page, id) {
  return page.evaluate((messageId) => {
    const node = document.querySelector(`[data-message-id="${messageId}"]`);
    return node ? node.getBoundingClientRect().top : null;
  }, id);
}

async function waitForComposer(page, expected) {
  await page.waitForFunction(
    (value) => {
      const area = document.querySelector('textarea');
      return area !== null && area.value === value;
    },
    expected,
    { timeout: 10_000 },
  );
}

async function scrollMainTo(page, position) {
  await page.evaluate((where) => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = where === 'top' ? 0 : main.scrollHeight;
  }, position);
}

async function captureBefore(browser, { baseURL, token }) {
  const light = await newContext(browser, {
    baseURL,
    token,
    viewport: { width: 1440, height: 900 },
    theme: 'light',
  });
  await openConversation(light.page, '历史分页验证');
  assert((await messageCount(light.page)) === 100, 'baseline: newest page has 100 messages');
  assert(
    (await light.page.getByRole('button', { name: '加载更早消息' }).count()) === 0,
    'baseline: no load-earlier control',
  );
  await light.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-before-desktop-light-history.png'),
  });

  await light.page.getByRole('button', { name: '新建任务' }).first().click();
  await light.page.getByText('新建任务', { exact: false }).first().waitFor();
  assert(
    (await light.page.getByText('本次创建实际配置').count()) === 0,
    'baseline: no effective-config summary',
  );
  await light.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-before-desktop-light-new-task.png'),
  });

  await light.page.getByRole('button', { name: '取消' }).click();
  await openConversation(light.page, '草稿与发送验证');
  const composer = light.page.getByRole('textbox', { name: '消息输入区' });
  await composer.fill('基线草稿在刷新后会丢失');
  await light.page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(light.page, '草稿与发送验证');
  assert(
    (await light.page.getByRole('textbox', { name: '消息输入区' }).inputValue()) === '',
    'baseline: draft is lost after refresh',
  );
  await light.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-before-desktop-light-draft.png'),
  });

  const dark = await newContext(browser, {
    baseURL,
    token,
    viewport: { width: 1440, height: 900 },
    theme: 'dark',
  });
  await dark.page.getByRole('button', { name: '新建任务' }).first().click();
  await dark.page.getByText('新建任务', { exact: false }).first().waitFor();
  await dark.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-before-desktop-dark-new-task.png'),
  });

  const mobile = await newContext(browser, {
    baseURL,
    token,
    viewport: { width: 390, height: 844 },
    theme: 'light',
  });
  await mobile.page.getByRole('button', { name: '打开导航' }).click();
  await openConversation(mobile.page, '历史分页验证');
  await mobile.page
    .getByRole('button', { name: '关闭导航' })
    .click()
    .catch(() => {});
  await mobile.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-before-mobile-light-history.png'),
  });

  await light.context.close();
  await dark.context.close();
  await mobile.context.close();
  record('before screenshots', 'pass', 'baseline build @ ' + BASE_SHA.slice(0, 7));
}

async function captureAfter(browser, { baseURL, token }) {
  const light = await newContext(browser, {
    baseURL,
    token,
    viewport: { width: 1440, height: 900 },
    theme: 'light',
  });
  await openConversation(light.page, '历史分页验证');
  await waitForMessageCount(light.page, 100);
  assert(
    (await light.page.getByRole('button', { name: '加载更早消息' }).count()) === 1,
    'after: load-earlier control exists',
  );
  await light.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-after-desktop-light-history.png'),
  });

  await light.page.getByRole('button', { name: '新建任务' }).first().click();
  await light.page.getByText('本次创建实际配置').waitFor();
  await light.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-after-desktop-light-new-task.png'),
  });
  await light.page.getByRole('button', { name: '取消' }).click();

  await openConversation(light.page, '草稿与发送验证');
  await light.page.getByRole('textbox', { name: '消息输入区' }).fill('刷新后应恢复的草稿');
  await light.page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(light.page, '草稿与发送验证');
  assert(
    (await light.page.getByRole('textbox', { name: '消息输入区' }).inputValue()) ===
      '刷新后应恢复的草稿',
    'after: draft restored after refresh',
  );
  await light.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-after-desktop-light-draft.png'),
  });
  await light.page.getByRole('button', { name: '清除草稿' }).click();

  const dark = await newContext(browser, {
    baseURL,
    token,
    viewport: { width: 1440, height: 900 },
    theme: 'dark',
  });
  await dark.page.getByRole('button', { name: '新建任务' }).first().click();
  await dark.page.getByText('本次创建实际配置').waitFor();
  await dark.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-after-desktop-dark-new-task.png'),
  });

  const mobile = await newContext(browser, {
    baseURL,
    token,
    viewport: { width: 390, height: 844 },
    theme: 'light',
  });
  await mobile.page.getByRole('button', { name: '打开导航' }).click();
  await openConversation(mobile.page, '历史分页验证');
  await mobile.page.screenshot({
    path: path.join(EVIDENCE, 'm4ux-after-mobile-light-history.png'),
  });
  const overflow = await mobile.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert(overflow <= 1, `after: no horizontal overflow on mobile (got ${overflow})`);

  await light.context.close();
  await dark.context.close();
  await mobile.context.close();
  record('after screenshots', 'pass', 'branch build');
}

/* ------------------------------- functional -------------------------------- */

async function apiFetch(baseURL, token, pathname, options = {}) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      cookie: `moyu_session=${token}`,
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      origin: baseURL,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function insertPendingInboundMessage(databaseUrl, conversationId, body) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `insert into messages (conversation_id, direction, kind, body, source)
       values ($1, 'inbound', 'user', $2, 'web') returning id`,
      [conversationId, body],
    );
    const messageId = result.rows[0].id;
    await client.query(
      `insert into deliveries (message_id, state, attempt_count) values ($1, 'pending', 0)`,
      [messageId],
    );
    return messageId;
  } finally {
    await client.end();
  }
}

async function countMessages(databaseUrl, conversationId, body) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const rows = await client.query(
      'select count(*)::int as count from messages where conversation_id = $1 and body = $2',
      [conversationId, body],
    );
    return rows.rows[0].count;
  } finally {
    await client.end();
  }
}

async function functional(browser, api, seeded) {
  const { baseURL, token } = api;
  const light = await newContext(browser, {
    baseURL,
    token,
    viewport: { width: 1440, height: 900 },
    theme: 'light',
  });
  const page = light.page;
  const makeGate = () => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  // 1. Full message history with stable scroll anchoring.
  await openConversation(page, '历史分页验证');
  await waitForMessageCount(page, 100);

  // A late older-page response from a previous conversation selection must not
  // pollute the newly loaded list.
  const staleGate = makeGate();
  const staleHandler = async (route) => {
    await staleGate.promise;
    await route.continue();
  };
  await page.route(/\/messages\?before=/, staleHandler);
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await openConversation(page, '草稿与发送验证');
  await openConversation(page, '历史分页验证');
  await waitForMessageCount(page, 100);
  staleGate.release();
  await page.waitForTimeout(800);
  assert(
    (await messageCount(page)) === 100,
    'after: a late older-page response did not pollute the new conversation list',
  );
  await page.unroute(/\/messages\?before=/, staleHandler);

  let loads = 0;
  while ((await page.getByRole('button', { name: '加载更早消息' }).count()) > 0) {
    // The user scrolls to the top before asking for older messages; record the
    // row at that position, because the button itself sits above the list.
    await scrollMainTo(page, 'top');
    const before = await firstVisibleAnchor(page);
    const beforeCount = await messageCount(page);
    await page.getByRole('button', { name: '加载更早消息' }).click();
    // The last page holds the remainder, so wait for any growth rather than a
    // fixed page size.
    await page.waitForFunction(
      (previous) => document.querySelectorAll('[data-message-id]').length > previous,
      beforeCount,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(80);
    assert(before, 'after: anchor row exists while paginating');
    const afterAnchorTop = await messageTop(page, before.id);
    assert(afterAnchorTop !== null, 'after: the anchor row is still rendered');
    assert(
      Math.abs(before.top - afterAnchorTop) <= 2,
      `after: the anchor row keeps its viewport position (${JSON.stringify({ before, afterAnchorTop })})`,
    );
    loads += 1;
    assert(loads < 10, 'after: pagination terminates');
  }
  await waitForMessageCount(page, 250);
  const ids = await page
    .locator('[data-message-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')));
  assert(new Set(ids).size === 250, 'after: all 250 messages are unique');
  assert((await page.getByText('已显示全部消息').count()) === 1, 'after: end of history label');
  record('message history pagination', 'pass', '250 messages across pages, anchored');

  // 2. SSE arrival keeps loaded history and appends once.
  await scrollMainTo(page, 'bottom');
  const sseBody = `SSE 追加消息 ${Date.now()}`;
  const sse = await apiFetch(baseURL, token, `/api/v1/conversations/${seeded.historyId}/messages`, {
    method: 'POST',
    body: { clientMessageId: `sse-${randomUUID()}`, text: sseBody },
  });
  assert(sse.status === 202, `after: SSE seed message accepted (${sse.status})`);
  await page.getByText(sseBody).waitFor();
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-message-id]').length === count,
    251,
    { timeout: 15_000 },
  );
  const afterSseIds = await page
    .locator('[data-message-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')));
  for (const id of ids.slice(0, 50)) {
    assert(afterSseIds.includes(id), 'after: SSE merge kept already loaded history');
  }
  assert(new Set(afterSseIds).size === 251, 'after: SSE merge has no duplicate message');
  record('SSE merge with loaded history', 'pass', '251 messages, no duplicate');

  // 3. Task list pagination and repository cursor isolation.
  const listCount = async () => sidebar(page).locator('[data-conversation-id]').count();
  assert((await listCount()) === 50, 'after: task list starts at the default limit 50');
  await page.getByRole('button', { name: '加载更多任务' }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="工作台导航"] [data-conversation-id]').length === 100,
    null,
    { timeout: 15_000 },
  );
  await page.getByRole('button', { name: '加载更多任务' }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="工作台导航"] [data-conversation-id]').length === 124,
    null,
    { timeout: 15_000 },
  );
  const allTitles = await page
    .locator('[aria-label="工作台导航"] [data-conversation-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
  for (const title of seeded.taskTitles) {
    assert(
      allTitles.some((text) => text.includes(title)),
      `after: task ${title} is reachable`,
    );
  }
  const repositorySelect = sidebar(page).locator('select').first();
  await repositorySelect.selectOption(seeded.repositoryB);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="工作台导航"] [data-conversation-id]').length === 1,
    null,
    { timeout: 15_000 },
  );
  const otherTitles = await page
    .locator('[aria-label="工作台导航"] [data-conversation-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
  assert(
    otherTitles.every((text) => !text.includes('历史任务 001')),
    'after: switching repository isolates the task list',
  );
  await repositorySelect.selectOption(seeded.repositoryA);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="工作台导航"] [data-conversation-id]').length === 50,
    null,
    { timeout: 15_000 },
  );
  record('task list pagination and repository isolation', 'pass', '124 tasks reachable');

  // 3b. An already displayed message follows stored -> delivered -> read via
  // the real dispatcher and SSE, without reloading the page.
  await repositorySelect.selectOption(seeded.repositoryB);
  await openConversation(page, '另一个仓库的任务');
  await page.getByText('平台收件').first().waitFor();
  const dispatcher = await startDispatcher('bouyer-sutrasky/m4ux-other');
  try {
    await page.getByText('执行器已接收').first().waitFor({ timeout: 20_000 });
    bridgeState.readEvent = {
      seq: 1,
      id: 'read-1',
      type: 'message.read',
      at: new Date().toISOString(),
      data: { messageId: seeded.otherMessageId, at: new Date().toISOString() },
    };
    await page.getByText('已读取').first().waitFor({ timeout: 20_000 });
  } finally {
    await dispatcher.stop();
  }
  record(
    'delivery and read update in place',
    'pass',
    'stored -> delivered -> read through the real dispatcher and SSE',
  );

  // 3b2. A stale delivered response must not overwrite the newer read
  // projection, including after leaving and returning to the conversation.
  const reorderBody = `投递乱序 ${Date.now()}`;
  const reorderId = await insertPendingInboundMessage(
    currentDatabase.url,
    seeded.otherId,
    reorderBody,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await repositorySelect.selectOption(seeded.repositoryB);
  await openConversation(page, '另一个仓库的任务');
  const reorderRow = page.locator(`[data-message-id="${reorderId}"]`);
  await reorderRow.waitFor();
  let deliveredHeld;
  const deliveredHeldPromise = new Promise((resolve) => {
    deliveredHeld = resolve;
  });
  let deliverRelease;
  const deliverReleasePromise = new Promise((resolve) => {
    deliverRelease = resolve;
  });
  const detailPattern = new RegExp(`/conversations/${seeded.otherId}/messages/${reorderId}$`);
  let deliveredHeldOnce = false;
  const holdDelivered = async (route) => {
    if (deliveredHeldOnce || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    deliveredHeldOnce = true;
    const response = await route.fetch();
    deliveredHeld();
    await deliverReleasePromise;
    await route.fulfill({ response });
  };
  await page.route(detailPattern, holdDelivered);
  const reorderDispatcher = await startDispatcher('bouyer-sutrasky/m4ux-other');
  try {
    await deliveredHeldPromise;
    bridgeState.readEvent = {
      seq: 2,
      id: 'read-2',
      type: 'message.read',
      at: new Date().toISOString(),
      data: { messageId: reorderId, at: new Date().toISOString() },
    };
    await reorderRow.getByText('已读取').waitFor({ timeout: 20_000 });
    await repositorySelect.selectOption(seeded.repositoryA);
    await openConversation(page, '历史分页验证');
    await repositorySelect.selectOption(seeded.repositoryB);
    await openConversation(page, '另一个仓库的任务');
    deliverRelease();
    await page.waitForTimeout(500);
    await reorderRow.getByText('已读取').waitFor();
    assert(
      (await reorderRow.getByText('执行器已接收').count()) === 0,
      'after: the stale delivered response did not overwrite read',
    );
  } finally {
    await reorderDispatcher.stop();
    await page.unroute(detailPattern, holdDelivered);
  }
  record(
    'out-of-order delivery responses',
    'pass',
    'held delivered response cannot overwrite read after a switch round-trip',
  );

  await repositorySelect.selectOption(seeded.repositoryA);

  // 3c. An SSE message that arrives after the initial query but before its
  // response must be caught up after the first page lands.
  await openConversation(page, '历史分页验证');
  const timingBody = `初次加载期间新增 ${Date.now()}`;
  const timingPattern = new RegExp(
    `/api/v1/conversations/${seeded.secondId}/messages\\?limit=100$`,
  );
  let held;
  const heldPromise = new Promise((resolve) => {
    held = resolve;
  });
  let releaseResponse;
  const releasePromise = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const holdInitial = async (route) => {
    const response = await route.fetch();
    held(response);
    await releasePromise;
    await route.fulfill({ response });
  };
  await page.route(timingPattern, holdInitial);
  await openConversation(page, '草稿与发送验证');
  const heldResponse = await heldPromise;
  assert(heldResponse.ok(), 'after: initial message query completed before the hold');
  const timing = await apiFetch(
    baseURL,
    token,
    `/api/v1/conversations/${seeded.secondId}/messages`,
    {
      method: 'POST',
      body: { clientMessageId: `timing-${randomUUID()}`, text: timingBody },
    },
  );
  assert(timing.status === 202, `after: timing message accepted (${timing.status})`);
  // Give the SSE loop time to deliver message.created while the page is still
  // loading; then release the pre-event query response.
  await page.waitForTimeout(1_500);
  releaseResponse();
  await page.getByText(timingBody).first().waitFor({ timeout: 20_000 });
  assert(
    (await page.getByText(timingBody).count()) === 1,
    'after: catch-up appended the message once',
  );
  await page.unroute(timingPattern, holdInitial);
  record(
    'SSE during initial load',
    'pass',
    'held first-page response, event arrived, catch-up showed it once',
  );

  // 4. Draft isolation, refresh, explicit clear.
  await openConversation(page, '草稿与发送验证');
  const composer = page.getByRole('textbox', { name: '消息输入区' });
  await composer.fill('草稿：会话二的未发送内容');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, '草稿与发送验证');
  await waitForComposer(page, '草稿：会话二的未发送内容');
  await openConversation(page, '历史分页验证');
  await waitForComposer(page, '');
  await page.getByRole('textbox', { name: '消息输入区' }).fill('历史会话草稿');
  await openConversation(page, '草稿与发送验证');
  await waitForComposer(page, '草稿：会话二的未发送内容');
  await repositorySelect.selectOption(seeded.repositoryB);
  await openConversation(page, '另一个仓库的任务');
  await waitForComposer(page, '');
  await page.getByRole('textbox', { name: '消息输入区' }).fill('仓库 B 草稿');
  await repositorySelect.selectOption(seeded.repositoryA);
  await openConversation(page, '历史分页验证');
  await waitForComposer(page, '历史会话草稿');
  await page.getByRole('button', { name: '清除草稿' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, '历史分页验证');
  await waitForComposer(page, '');
  record('draft isolation, refresh and clear', 'pass', 'owner/repo/conversation keys');

  // 5. Editing while a send is in flight keeps the newer text.
  await openConversation(page, '草稿与发送验证');
  const delayedFor = (gate) => async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await gate.promise;
    await route.continue();
  };
  const editGate = makeGate();
  const delayed = delayedFor(editGate);
  await page.route('**/api/v1/conversations/*/messages', delayed);
  const original = `发送中的原文 ${Date.now()}`;
  const edited = '发送后继续编辑的新内容';
  const editResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
  );
  await page.getByRole('textbox', { name: '消息输入区' }).fill(original);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入区' }).fill(edited);
  editGate.release();
  const editReply = await editResponse;
  await page.waitForFunction(
    (text) => {
      const area = document.querySelector('textarea');
      return area && area.value === text;
    },
    edited,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(300);
  assert(
    (await page.getByRole('textbox', { name: '消息输入区' }).inputValue()) === edited,
    'after: send success does not clear a newer draft version',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, '草稿与发送验证');
  await waitForComposer(page, edited);
  const originalStored = await countMessages(currentDatabase.url, seeded.secondId, original);
  assert(
    originalStored === 1,
    `after: original text stored once (got ${originalStored}, HTTP ${editReply.status()})`,
  );
  await page.unroute('**/api/v1/conversations/*/messages', delayed);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'edit during send',
    'pass',
    'newer draft kept, old text sent to the captured conversation',
  );

  // 6. Switching conversation while sending: the request still targets the source
  // conversation and its result must not clear the new conversation's input.
  const switchGate = makeGate();
  const switchDelayed = delayedFor(switchGate);
  await page.route('**/api/v1/conversations/*/messages', switchDelayed);
  const switchBody = `切会话发送 ${Date.now()}`;
  const switchResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/messages'),
  );
  await page.getByRole('textbox', { name: '消息输入区' }).fill(switchBody);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await openConversation(page, '历史分页验证');
  await page.getByRole('textbox', { name: '消息输入区' }).fill('切到新会话后继续输入');
  switchGate.release();
  await switchResponse;
  await page.waitForTimeout(200);
  await waitForComposer(page, '切到新会话后继续输入');
  assert(
    (await countMessages(currentDatabase.url, seeded.secondId, switchBody)) === 1,
    'after: in-flight send landed in the conversation it was submitted from',
  );
  assert(
    (await countMessages(currentDatabase.url, seeded.historyId, switchBody)) === 0,
    'after: in-flight send did not go to the newly selected conversation',
  );
  await page.unroute('**/api/v1/conversations/*/messages', switchDelayed);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record('switch conversation during send', 'pass', 'request stays on its captured conversation');

  // 7. Response lost after the server stored the message: retry reuses the id.
  await openConversation(page, '草稿与发送验证');
  const ambiguousBody = `响应丢失重试 ${Date.now()}`;
  let firstClientMessageId = null;
  let secondClientMessageId = null;
  let intercepted = false;
  const loseResponse = async (route) => {
    if (route.request().method() !== 'POST' || intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    firstClientMessageId = JSON.parse(route.request().postData() ?? '{}').clientMessageId;
    await route.fetch();
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'dependency_unavailable',
          message: 'simulated lost response',
          retryable: true,
        },
        requestId: 'simulated',
      }),
    });
  };
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/messages')) {
      if (intercepted) {
        secondClientMessageId = JSON.parse(request.postData() ?? '{}').clientMessageId;
      }
    }
  });
  await page.route('**/api/v1/conversations/*/messages', loseResponse);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(ambiguousBody);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('草稿与幂等标识已保留').waitFor({ timeout: 15_000 });
  await page.unroute('**/api/v1/conversations/*/messages', loseResponse);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(
    () => {
      const area = document.querySelector('textarea');
      return area && area.value === '';
    },
    null,
    { timeout: 15_000 },
  );
  assert(firstClientMessageId, 'after: first send carried a clientMessageId');
  assert(
    secondClientMessageId === firstClientMessageId,
    `after: retry reuses the original clientMessageId (${firstClientMessageId} vs ${secondClientMessageId})`,
  );
  assert(
    (await countMessages(currentDatabase.url, seeded.secondId, ambiguousBody)) === 1,
    'after: retry did not duplicate the stored message',
  );
  record('ambiguous response retry', 'pass', 'same clientMessageId, one stored message');

  // 7a. ABA guard: clearing and retyping the same text while a send is in
  // flight creates a new draft lineage; the old 202 must not clear it.
  await openConversation(page, '草稿与发送验证');
  if ((await page.getByRole('button', { name: '清除草稿' }).count()) > 0) {
    await page.getByRole('button', { name: '清除草稿' }).click();
  }
  const abaText = `ABA 原文 ${Date.now()}`;
  const abaGate = makeGate();
  const abaDelay = delayedFor(abaGate);
  const abaPattern = new RegExp(`/conversations/${seeded.secondId}/messages$`);
  await page.route(abaPattern, abaDelay);
  const abaResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/${seeded.secondId}/messages`),
  );
  await page.getByRole('textbox', { name: '消息输入区' }).fill(abaText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入区' }).fill('');
  await page.getByRole('textbox', { name: '消息输入区' }).fill(abaText);
  abaGate.release();
  const abaReply = await abaResponse;
  assert(abaReply?.status() === 202, 'after: ABA send accepted');
  await page.waitForTimeout(300);
  assert(
    (await page.getByRole('textbox', { name: '消息输入区' }).inputValue()) === abaText,
    'after: the retyped same text survives the older response (new lineage)',
  );
  await page.unroute(abaPattern, abaDelay);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'cleared and retyped draft is not cleared by the old response',
    'pass',
    'same text, new draft lineage, input preserved',
  );

  // 7a1. Edit while a send runs, then an explicit failure. The newer edit must
  // be restorable while the old send is retried by its original key.
  await openConversation(page, '草稿与发送验证');
  if ((await page.getByRole('button', { name: '清除草稿' }).count()) > 0) {
    await page.getByRole('button', { name: '清除草稿' }).click();
  }
  const explicitText = `明确失败原文 ${Date.now()}`;
  const explicitEdit = `明确失败后编辑 ${Date.now()}`;
  const explicitGate = makeGate();
  let explicitHeld;
  const explicitHeldPromise = new Promise((resolve) => {
    explicitHeld = resolve;
  });
  const explicitPattern = new RegExp(`/conversations/${seeded.secondId}/messages$`);
  const explicitHandler = async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fetch();
    explicitHeld();
    await explicitGate.promise;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: 'forced failure' } }),
    });
  };
  await page.route(explicitPattern, explicitHandler);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(explicitText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await explicitHeldPromise;
  await page.getByRole('textbox', { name: '消息输入区' }).fill(explicitEdit);
  explicitGate.release();
  await page.getByRole('button', { name: '恢复待确认内容' }).waitFor();
  await openConversation(page, '历史分页验证');
  await openConversation(page, '草稿与发送验证');
  await page.getByRole('button', { name: '恢复待确认内容' }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, '草稿与发送验证');
  await waitForComposer(page, explicitEdit);
  await page.getByRole('button', { name: '恢复待确认内容' }).click();
  await waitForComposer(page, explicitText);
  await page
    .getByText(/合并来源|未发送内容已保留/)
    .first()
    .waitFor();
  await page.unroute(explicitPattern, explicitHandler);
  const explicitRetry = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/${seeded.secondId}/messages`),
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await explicitRetry;
  await waitForComposer(page, explicitEdit);
  assert(
    (await countMessages(currentDatabase.url, seeded.secondId, explicitText)) === 1,
    'after: explicit failure retry used the original key, one row',
  );
  assert(
    (await countMessages(currentDatabase.url, seeded.secondId, explicitEdit)) === 0,
    'after: the newer edit was not sent with the retry',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, '草稿与发送验证');
  await waitForComposer(page, explicitEdit);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'edit then explicit failure restores both',
    'pass',
    'old body retried by key; newer edit restored after success and refresh',
  );

  // 7a1b. Same recovery when the response is lost (ambiguous outcome).
  await openConversation(page, '草稿与发送验证');
  const lostEditBase = `结果不明原文 ${Date.now()}`;
  const lostEditNew = `结果不明后编辑 ${Date.now()}`;
  const lostEditGate = makeGate();
  let lostEditHeld;
  const lostEditHeldPromise = new Promise((resolve) => {
    lostEditHeld = resolve;
  });
  const lostEditPattern = new RegExp(`/conversations/${seeded.secondId}/messages$`);
  const lostEditHandler = async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fetch();
    lostEditHeld();
    await lostEditGate.promise;
    await route.abort('failed');
  };
  await page.route(lostEditPattern, lostEditHandler);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(lostEditBase);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await lostEditHeldPromise;
  await page.getByRole('textbox', { name: '消息输入区' }).fill(lostEditNew);
  lostEditGate.release();
  await page.getByRole('button', { name: '恢复待确认内容' }).waitFor();
  await page.getByRole('button', { name: '恢复待确认内容' }).click();
  await waitForComposer(page, lostEditBase);
  await page.unroute(lostEditPattern, lostEditHandler);
  const lostEditRetry = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/${seeded.secondId}/messages`),
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await lostEditRetry;
  await waitForComposer(page, lostEditNew);
  assert(
    (await countMessages(currentDatabase.url, seeded.secondId, lostEditBase)) === 1,
    'after: ambiguous retry kept one row',
  );
  assert(
    (await countMessages(currentDatabase.url, seeded.secondId, lostEditNew)) === 0,
    'after: ambiguous new edit was not sent',
  );
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'edit then ambiguous failure restores both',
    'pass',
    'new edit deferred across retry; old body not duplicated',
  );

  // 7a2. Per-conversation sending state: A's late finally must not unlock B,
  // and a conversation still sending cannot be re-entered.
  await openConversation(page, '历史分页验证');
  if ((await page.getByRole('button', { name: '清除草稿' }).count()) > 0) {
    await page.getByRole('button', { name: '清除草稿' }).click();
  }
  await openConversation(page, '草稿与发送验证');
  let aRequests = 0;
  const aGate = makeGate();
  const aDelay = delayedFor(aGate);
  const aPattern = new RegExp(`/conversations/${seeded.secondId}/messages$`);
  await page.route(aPattern, async (route) => {
    if (route.request().method() === 'POST') aRequests += 1;
    await aDelay(route);
  });
  const aResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/${seeded.secondId}/messages`),
  );
  const aText = `A 在途 ${Date.now()}`;
  await page.getByRole('textbox', { name: '消息输入区' }).fill(aText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await openConversation(page, '历史分页验证');
  let bRequests = 0;
  const bGate = makeGate();
  const bDelay = delayedFor(bGate);
  const bPattern = new RegExp(`/conversations/${seeded.historyId}/messages$`);
  await page.route(bPattern, async (route) => {
    if (route.request().method() === 'POST') bRequests += 1;
    await bDelay(route);
  });
  const bResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/${seeded.historyId}/messages`),
  );
  const bText = `B 在途 ${Date.now()}`;
  await page.getByRole('textbox', { name: '消息输入区' }).fill(bText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await openConversation(page, '草稿与发送验证');
  await page.getByRole('button', { name: '发送中…' }).waitFor();
  await page.getByRole('textbox', { name: '消息输入区' }).press('Enter');
  await page.waitForTimeout(200);
  assert(aRequests === 1, `after: re-entry in the same conversation is blocked (${aRequests})`);
  aGate.release();
  await aResponse;
  await openConversation(page, '历史分页验证');
  await page.getByRole('button', { name: '发送中…' }).waitFor();
  assert(bRequests === 1, `after: B runs once (${bRequests})`);
  bGate.release();
  await bResponse;
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  await page.unroute(aPattern);
  await page.unroute(bPattern);
  record(
    'per-conversation send state and late finally',
    'pass',
    'A/B stay independently locked; A finishing does not unlock B',
  );

  // 7b. A merged first message carries a newer draft to the GitHub target
  // instead of leaving it under the hidden source alias.
  const mergeUrl = 'https://github.com/bouyer-sutrasky/m4ux-main/issues/42';
  await openConversation(page, 'GitHub 汇入任务');
  if ((await page.getByRole('button', { name: '清除草稿' }).count()) > 0) {
    await page.getByRole('button', { name: '清除草稿' }).click();
  }
  const sourceA = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversationById(page, sourceA);
  const mergeGateA = makeGate();
  const mergeDelayA = delayedFor(mergeGateA);
  const mergePatternA = new RegExp(`/conversations/${sourceA}/messages$`);
  await page.route(mergePatternA, mergeDelayA);
  const mergeResponseA = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes(`/${sourceA}/messages`),
    )
    .catch(() => null);
  const editedA = '合并后仍要保留的草稿 A';
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入区' }).fill(editedA);
  mergeGateA.release();
  assert(
    (await (await mergeResponseA).json()).data.message.conversationId,
    'after: merge response',
  );
  await page.getByRole('heading', { name: 'GitHub 汇入任务', exact: true }).waitFor();
  await waitForComposer(page, editedA);
  await page.unroute(mergePatternA, mergeDelayA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  await waitForComposer(page, editedA);
  record(
    'merge carries edited draft',
    'pass',
    'newer source draft appears in the merged target and survives refresh',
  );

  // 7c. The target already has a draft: both texts stay recoverable.
  await page.getByRole('textbox', { name: '消息输入区' }).fill('目标已有草稿');
  await openConversation(page, '历史分页验证');
  const sourceB = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversationById(page, sourceB);
  const mergeGateB = makeGate();
  const mergeDelayB = delayedFor(mergeGateB);
  const mergePatternB = new RegExp(`/conversations/${sourceB}/messages$`);
  await page.route(mergePatternB, mergeDelayB);
  const mergeResponseB = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes(`/${sourceB}/messages`),
    )
    .catch(() => null);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入区' }).fill('源会话新草稿');
  mergeGateB.release();
  const mergeReplyB = await mergeResponseB;
  assert(mergeReplyB?.status() === 202, 'after: second merge send accepted');
  await page.getByRole('heading', { name: 'GitHub 汇入任务', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const area = document.querySelector('textarea');
    return (
      area !== null && area.value.includes('目标已有草稿') && area.value.includes('源会话新草稿')
    );
  });
  await page.unroute(mergePatternB, mergeDelayB);
  record(
    'merge preserves an existing target draft',
    'pass',
    'target and source text are joined, neither is overwritten',
  );

  // 7c2. Target already has an in-flight send: merging must not settle or
  // retarget it. The source text is deferred until the target send resolves.
  const sourceE = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  if ((await page.getByRole('button', { name: '清除草稿' }).count()) > 0) {
    await page.getByRole('button', { name: '清除草稿' }).click();
  }
  const targetBText = `目标在途 B ${Date.now()}`;
  const targetBGate = makeGate();
  const targetBDelay = delayedFor(targetBGate);
  const targetBPattern = new RegExp(`/conversations/${seeded.githubId}/messages$`);
  await page.route(targetBPattern, targetBDelay);
  const targetBResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/${seeded.githubId}/messages`),
  );
  await page.getByRole('textbox', { name: '消息输入区' }).fill(targetBText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await openConversationById(page, sourceE);
  const sourceEText = `源 A 新草稿 ${Date.now()}`;
  const sourceEGate = makeGate();
  const sourceEDelay = delayedFor(sourceEGate);
  const sourceEPattern = new RegExp(`/conversations/${sourceE}/messages$`);
  await page.route(sourceEPattern, sourceEDelay);
  const sourceEResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes(`/${sourceE}/messages`),
  );
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入区' }).fill(sourceEText);
  sourceEGate.release();
  await sourceEResponse;
  await page.getByRole('heading', { name: 'GitHub 汇入任务', exact: true }).waitFor();
  await waitForComposer(page, targetBText);
  await page
    .getByText(/发送结果待确认/)
    .first()
    .waitFor();
  assert(
    (await page.getByRole('button', { name: '恢复合并草稿' }).count()) === 0,
    'after: deferred text waits for the target pending send',
  );
  // A newer edit made on the target is also preserved when checking B.
  const targetEditY = `目标后编辑 Y ${Date.now()}`;
  await page.getByRole('textbox', { name: '消息输入区' }).fill(targetEditY);
  await page.getByRole('button', { name: '恢复待确认内容' }).click();
  await waitForComposer(page, targetBText);
  targetBGate.release();
  await targetBResponse;
  await page.waitForFunction(
    (texts) => {
      const area = document.querySelector('textarea');
      return area !== null && texts.every((text) => area.value.includes(text));
    },
    [sourceEText, targetEditY],
  );
  assert(
    (await countMessages(currentDatabase.url, seeded.githubId, targetBText)) === 1,
    'after: target B stored once',
  );
  for (const text of [sourceEText, targetEditY]) {
    assert(
      (await countMessages(currentDatabase.url, seeded.githubId, text)) === 0,
      `after: deferred text was not sent with B (${text})`,
    );
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  await page.waitForFunction(
    (texts) => {
      const area = document.querySelector('textarea');
      return area !== null && texts.every((text) => area.value.includes(text));
    },
    [sourceEText, targetEditY],
  );
  await page.unroute(targetBPattern, targetBDelay);
  await page.unroute(sourceEPattern, sourceEDelay);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'merge with a target send in flight',
    'pass',
    'B keeps its key; deferred + newer edit promoted after B settles and refresh',
  );

  // 7c2b. The source's new draft is textually identical to the target's
  // pending body. They are still different edits: keep both identities and do
  // not drop the source when the target settles.
  const sourceG = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  if ((await page.getByRole('button', { name: '清除草稿' }).count()) > 0) {
    await page.getByRole('button', { name: '清除草稿' }).click();
  }
  const sameText = `同文待确认 ${Date.now()}`;
  const sameGate = makeGate();
  const sameDelay = delayedFor(sameGate);
  const samePattern = new RegExp(`/conversations/${seeded.githubId}/messages$`);
  await page.route(samePattern, sameDelay);
  const sameResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/${seeded.githubId}/messages`),
  );
  await page.getByRole('textbox', { name: '消息输入区' }).fill(sameText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await openConversationById(page, sourceG);
  const sourceSameGate = makeGate();
  const sourceSameDelay = delayedFor(sourceSameGate);
  const sourceSamePattern = new RegExp(`/conversations/${sourceG}/messages$`);
  await page.route(sourceSamePattern, sourceSameDelay);
  const sourceSameResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes(`/${sourceG}/messages`),
  );
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入区' }).fill(sameText);
  sourceSameGate.release();
  await sourceSameResponse;
  await page.getByRole('heading', { name: 'GitHub 汇入任务', exact: true }).waitFor();
  await waitForComposer(page, sameText);
  await page
    .getByText(/发送结果待确认/)
    .first()
    .waitFor();
  sameGate.release();
  await sameResponse;
  await waitForComposer(page, sameText);
  assert(
    (await countMessages(currentDatabase.url, seeded.githubId, sameText)) === 1,
    'after: identical source text was not sent a second time',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  await waitForComposer(page, sameText);
  await page.unroute(samePattern, sameDelay);
  await page.unroute(sourceSamePattern, sourceSameDelay);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'identical source and target text stay separate drafts',
    'pass',
    'source identity survives B settling; one row; text restored after refresh',
  );

  // 7c3. The target's send response is lost. Its pending key survives the
  // merge; retry settles B and only then restores the source text.
  const sourceF = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  if ((await page.getByRole('button', { name: '清除草稿' }).count()) > 0) {
    await page.getByRole('button', { name: '清除草稿' }).click();
  }
  const lostBText = `目标丢响应 B ${Date.now()}`;
  const lostBGate = makeGate();
  let lostBHeld;
  const lostBHeldPromise = new Promise((resolve) => {
    lostBHeld = resolve;
  });
  const lostBPattern = new RegExp(`/conversations/${seeded.githubId}/messages$`);
  const lostBHandler = async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    lostBHeld(response);
    await lostBGate.promise;
    await route.abort('failed');
  };
  await page.route(lostBPattern, lostBHandler);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(lostBText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await lostBHeldPromise;
  const sourceFGate = makeGate();
  const sourceFDelay = delayedFor(sourceFGate);
  const sourceFPattern = new RegExp(`/conversations/${sourceF}/messages$`);
  await page.route(sourceFPattern, sourceFDelay);
  const sourceFResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes(`/${sourceF}/messages`),
  );
  await openConversationById(page, sourceF);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入区' }).fill(lostBText);
  sourceFGate.release();
  await sourceFResponse;
  await page.getByRole('heading', { name: 'GitHub 汇入任务', exact: true }).waitFor();
  await waitForComposer(page, lostBText);
  lostBGate.release();
  await page
    .getByText(/网络结果不明确|发送失败/)
    .first()
    .waitFor();
  await waitForComposer(page, lostBText);
  await page.unroute(lostBPattern, lostBHandler);
  const retryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/${seeded.githubId}/messages`),
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await retryResponse;
  await waitForComposer(page, lostBText);
  assert(
    (await countMessages(currentDatabase.url, seeded.githubId, lostBText)) === 1,
    'after: lost target response retried by its original key, one row',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  await waitForComposer(page, lostBText);
  await page.unroute(sourceFPattern, sourceFDelay);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'merge with a lost target response',
    'pass',
    'identical source text survives B retry by original key, one row, refresh',
  );

  // 7c4. The source send fails before the server commits, the user restores
  // the pending body (moving the new edit to deferredText), then retries the
  // original URL. The merge must carry that deferred edit to the target.
  await openConversation(page, 'GitHub 汇入任务');
  if ((await page.getByRole('button', { name: '清除草稿' }).count()) > 0) {
    await page.getByRole('button', { name: '清除草稿' }).click();
  }
  const sourceH = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversationById(page, sourceH);
  const restoreY = `恢复后未发送 Y ${Date.now()}`;
  const beforeServerGate = makeGate();
  let beforeServerHeld;
  const beforeServerHeldPromise = new Promise((resolve) => {
    beforeServerHeld = resolve;
  });
  const beforeServerPattern = new RegExp(`/conversations/${sourceH}/messages$`);
  const beforeServerHandler = async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    beforeServerHeld();
    await beforeServerGate.promise;
    await route.abort('failed');
  };
  await page.route(beforeServerPattern, beforeServerHandler);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await beforeServerHeldPromise;
  await page.getByRole('textbox', { name: '消息输入区' }).fill(restoreY);
  beforeServerGate.release();
  await page.getByRole('button', { name: '恢复待确认内容' }).waitFor();
  await page.getByRole('button', { name: '恢复待确认内容' }).click();
  await waitForComposer(page, mergeUrl);
  await page
    .getByText(/合并来源|未发送内容已保留/)
    .first()
    .waitFor();
  await page.unroute(beforeServerPattern, beforeServerHandler);
  const mergeUrlCountBefore = await countMessages(currentDatabase.url, seeded.githubId, mergeUrl);
  const mergeRetry = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes(`/${sourceH}/messages`),
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await mergeRetry;
  await page.getByRole('heading', { name: 'GitHub 汇入任务', exact: true }).waitFor();
  await waitForComposer(page, restoreY);
  assert(
    (await countMessages(currentDatabase.url, seeded.githubId, mergeUrl)) ===
      mergeUrlCountBefore + 1,
    'after: original URL merged exactly once',
  );
  assert(
    (await countMessages(currentDatabase.url, seeded.githubId, restoreY)) === 0,
    'after: deferred Y was not sent during the merge retry',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  await waitForComposer(page, restoreY);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'restored deferred edit survives merge retry',
    'pass',
    'abort-before-server, restore pending, retry URL by key; Y moves to target',
  );

  // 7c5. The first request committed and merged but its response was lost.
  // Restore + retry by key must still carry the deferred edit to the target.
  const sourceI = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversationById(page, sourceI);
  const lostMergeY = `提交丢响应 Y ${Date.now()}`;
  const lostMergeGate = makeGate();
  let lostMergeHeld;
  const lostMergeHeldPromise = new Promise((resolve) => {
    lostMergeHeld = resolve;
  });
  const lostMergePattern = new RegExp(`/conversations/${sourceI}/messages$`);
  const lostMergeHandler = async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await route.fetch();
    lostMergeHeld();
    await lostMergeGate.promise;
    await route.abort('failed');
  };
  await page.route(lostMergePattern, lostMergeHandler);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await lostMergeHeldPromise;
  await page.getByRole('textbox', { name: '消息输入区' }).fill(lostMergeY);
  lostMergeGate.release();
  // The server committed the merge before the response was lost. Depending on
  // whether the alias GET lands first, the UI may already have moved to the
  // target with the source draft intact; otherwise restore it on the source.
  await page.waitForTimeout(1_000);
  const lostRestore = page.getByRole('button', { name: '恢复待确认内容' });
  if ((await lostRestore.count()) > 0) {
    await lostRestore.click();
  }
  await waitForComposer(page, mergeUrl);
  await page.unroute(lostMergePattern, lostMergeHandler);
  const lostMergeUrlCountBefore = await countMessages(
    currentDatabase.url,
    seeded.githubId,
    mergeUrl,
  );
  const lostMergeRetry = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/messages'),
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await lostMergeRetry;
  await page.getByRole('heading', { name: 'GitHub 汇入任务', exact: true }).waitFor();
  await waitForComposer(page, lostMergeY);
  assert(
    (await countMessages(currentDatabase.url, seeded.githubId, mergeUrl)) ===
      lostMergeUrlCountBefore,
    'after: committed-but-lost URL was not duplicated by the retry',
  );
  assert(
    (await countMessages(currentDatabase.url, seeded.githubId, lostMergeY)) === 0,
    'after: committed-but-lost deferred Y was not sent',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, 'GitHub 汇入任务');
  await waitForComposer(page, lostMergeY);
  await page.getByRole('button', { name: '清除草稿' }).click();
  record(
    'deferred edit survives committed-but-lost merge',
    'pass',
    'response lost after commit; retry by key restores Y without duplicate URL',
  );

  // 7d. Merging while the user moved to another conversation: the late result
  // must not touch the current composer, and the source hides without losing
  // unsent text (there is no newer draft in this run).
  const sourceC = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversationById(page, sourceC);
  const mergeGateC = makeGate();
  const mergeDelayC = delayedFor(mergeGateC);
  const mergePatternC = new RegExp(`/conversations/${sourceC}/messages$`);
  await page.route(mergePatternC, mergeDelayC);
  const mergeResponseC = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes(`/${sourceC}/messages`),
    )
    .catch(() => null);
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await openConversation(page, '历史分页验证');
  await page.getByRole('textbox', { name: '消息输入区' }).fill('合并途中切到历史并输入');
  mergeGateC.release();
  const mergeReplyC = await mergeResponseC;
  assert(mergeReplyC?.status() === 202, 'after: switch merge send accepted');
  await page.waitForTimeout(800);
  await waitForComposer(page, '合并途中切到历史并输入');
  await page.unroute(mergePatternC, mergeDelayC);
  record(
    'merge while switching conversation',
    'pass',
    'late merge result leaves the new conversation input untouched',
  );

  // 7e. Two sends in different conversations: the later merged send must not
  // clear or target the other conversation's in-flight response.
  await page.getByRole('button', { name: '清除草稿' }).click();
  await openConversation(page, '草稿与发送验证');
  const sourceD = await createWebConversation(baseURL, token, seeded.repositoryA);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConversation(page, '草稿与发送验证');
  const secondGate = makeGate();
  const secondDelay = delayedFor(secondGate);
  const secondPattern = new RegExp(`/conversations/${seeded.secondId}/messages$`);
  await page.route(secondPattern, secondDelay);
  const secondResponse = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/${seeded.secondId}/messages`),
    )
    .catch(() => null);
  const concurrentNormal = `双会话并发普通消息 ${Date.now()}`;
  await page.getByRole('textbox', { name: '消息输入区' }).fill(concurrentNormal);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await openConversationById(page, sourceD);
  const mergeGateD = makeGate();
  const mergeDelayD = delayedFor(mergeGateD);
  const mergePatternD = new RegExp(`/conversations/${sourceD}/messages$`);
  await page.route(mergePatternD, mergeDelayD);
  const mergeResponseD = page
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes(`/${sourceD}/messages`),
    )
    .catch(() => null);
  const concurrentEdited = '双会话并发合并草稿';
  await page.getByRole('textbox', { name: '消息输入区' }).fill(mergeUrl);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入区' }).fill(concurrentEdited);
  mergeGateD.release();
  const mergeReplyD = await mergeResponseD;
  assert(mergeReplyD?.status() === 202, 'after: concurrent merge send accepted');
  await page.getByRole('heading', { name: 'GitHub 汇入任务', exact: true }).waitFor();
  await page.waitForFunction(
    (value) => {
      const area = document.querySelector('textarea');
      return area !== null && area.value.includes(value);
    },
    concurrentEdited,
    { timeout: 10_000 },
  );
  secondGate.release();
  const secondReply = await secondResponse;
  assert(secondReply?.status() === 202, 'after: concurrent normal send accepted');
  await page.waitForTimeout(800);
  await page.waitForFunction(
    (value) => {
      const area = document.querySelector('textarea');
      return area !== null && area.value.includes(value);
    },
    concurrentEdited,
    { timeout: 10_000 },
  );
  assert(
    (await countMessages(currentDatabase.url, seeded.secondId, concurrentNormal)) === 1,
    'after: the concurrent normal message was stored once in its own conversation',
  );
  await page.unroute(secondPattern, secondDelay);
  await page.unroute(mergePatternD, mergeDelayD);
  record(
    'two concurrent sends and a late response',
    'pass',
    'merged target keeps its draft while the other send settles',
  );

  // 8. Preferences: defaults, refresh, cross-repository isolation, invalid branch/model.
  await page.getByRole('button', { name: '新建任务' }).first().click();
  await page.getByText('本次创建实际配置').waitFor();
  const summary = () => page.locator('[data-field="config-summary"]').innerText();
  let text = await summary();
  assert(text.includes('bouyer-sutrasky/m4ux-main'), 'after: summary shows the repository');
  assert(text.includes('main'), 'after: summary shows the default branch');
  assert(text.includes('实例默认模型'), 'after: summary shows the instance default model');
  assert(text.includes('直接执行'), 'after: summary shows direct execution');
  await page.locator('[data-field="base-branch"]').selectOption('release');
  await page
    .locator('[data-field="model"]')
    .selectOption(JSON.stringify(['commandcode', 'deepseek/deepseek-v4.1-flash']));
  await page.locator('[data-field="reasoning"]').selectOption('high');
  await page.getByRole('radio', { name: /先讨论/ }).check();
  text = await summary();
  assert(
    text.includes('release') && text.includes('先讨论'),
    'after: summary follows the selection',
  );
  await page.getByRole('button', { name: '保存为默认' }).click();
  await page.getByText('已保存为该仓库的新任务默认配置').waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建任务' }).first().click();
  await page.getByText('本次创建实际配置').waitFor();
  assert(
    (await page.locator('[data-field="base-branch"]').inputValue()) === 'release',
    'after: saved branch restored',
  );
  assert(
    (await page.locator('[data-field="reasoning"]').inputValue()) === 'high',
    'after: saved reasoning restored',
  );
  assert(
    await page.getByRole('radio', { name: /先讨论/ }).isChecked(),
    'after: saved mode restored',
  );
  const repoBSelect = sidebar(page).locator('select').first();
  await repoBSelect.selectOption(seeded.repositoryB);
  await page.getByRole('button', { name: '新建任务' }).first().click();
  await page.getByText('本次创建实际配置').waitFor();
  assert(
    (await page.locator('[data-field="base-branch"]').inputValue()) === 'main',
    'after: repo B keeps its own branch default',
  );
  assert(
    await page.getByRole('radio', { name: /直接执行/ }).isChecked(),
    'after: repo B keeps its own mode default',
  );
  await repoBSelect.selectOption(seeded.repositoryA);

  bridgeState.branches = ['main', 'feature-x'];
  const branchesNow = await apiFetch(
    baseURL,
    token,
    `/api/v1/repositories/${seeded.repositoryA}/branches`,
  );
  assert(
    branchesNow.status === 200 &&
      JSON.stringify(branchesNow.payload.data.branches.map((branch) => branch.name).sort()) ===
        JSON.stringify(['feature-x', 'main']),
    `after: runtime branch list reflects the deleted branch (${branchesNow.status})`,
  );
  const prefsNow = await apiFetch(
    baseURL,
    token,
    `/api/v1/repositories/${seeded.repositoryA}/preferences`,
  );
  assert(
    prefsNow.payload.data.preferences?.baseBranch === 'release',
    'after: saved preference still names the deleted branch',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建任务' }).first().click();
  await page.getByText('本次创建实际配置').waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-field="base-branch"]');
    return element !== null && element.tagName === 'SELECT' && element.options.length > 0;
  });
  await page
    .getByText(/已保存的分支 release 已不存在/)
    .first()
    .waitFor();
  assert(
    await page.getByRole('button', { name: '创建任务' }).isDisabled(),
    'after: invalid branch disables creation',
  );
  await page.locator('[data-field="base-branch"]').selectOption('main');
  assert(
    await page.getByRole('button', { name: '创建任务' }).isEnabled(),
    'after: valid branch enables creation',
  );

  bridgeState.branches = ['main', 'release', 'feature-x'];
  bridgeState.models = bridgeState.models.filter(
    (model) => model.model !== 'deepseek/deepseek-v4.1-flash',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建任务' }).first().click();
  await page.getByText('本次创建实际配置').waitFor();
  await page
    .getByText(/已保存的模型 .* 当前不可用/)
    .first()
    .waitFor();
  assert(
    await page.getByRole('button', { name: '创建任务' }).isDisabled(),
    'after: unavailable model disables creation',
  );
  await page.locator('[data-field="model"]').selectOption('');
  assert(
    await page.getByRole('button', { name: '创建任务' }).isEnabled(),
    'after: a valid model enables creation',
  );

  bridgeState.models = [
    {
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      reasoningEfforts: ['low', 'high'],
    },
    {
      provider: 'commandcode',
      model: 'second-model',
      displayName: 'Second Model',
      reasoningEfforts: [],
    },
  ];

  bridgeState.capabilities.branches = false;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建任务' }).first().click();
  await page
    .getByText(/该运行时未提供分支列表/)
    .first()
    .waitFor();
  await page.locator('[data-field="base-branch"]').fill('main');
  await page.getByRole('button', { name: '保存为默认' }).click();
  await page.getByText('已保存为该仓库的新任务默认配置').waitFor();
  bridgeState.capabilities.branches = true;
  bridgeState.branches = ['main', 'release', 'feature-x'];

  // Frozen task configuration is not changed by preferences.
  const frozen = await apiFetch(baseURL, token, `/api/v1/conversations/${seeded.historyId}`);
  assert(frozen.status === 200, 'after: frozen conversation readable');
  assert(
    frozen.payload.data.conversation.baseBranch === 'main',
    'after: existing task keeps its frozen branch after preference edits',
  );
  await page.getByRole('button', { name: '取消' }).click();
  record(
    'repository preferences',
    'pass',
    'save/restore/isolation/invalid branch/model/frozen task',
  );

  // 9. Copy and M4 regression checks.
  const bodyText = await page.locator('body').innerText();
  assert(!bodyText.includes('M4 接入'), 'after: no stale M4 repository copy');
  assert(bodyText.includes('添加仓库'), 'after: add-repository entry remains visible');
  const addButton = sidebar(page).locator('button', { hasText: '添加仓库' }).first();
  assert(
    (await addButton.getAttribute('title'))?.includes('M5'),
    'after: add-repository explains M5 status',
  );
  assert(await addButton.isDisabled(), 'after: add-repository stays disabled');

  await openConversation(page, '已停止任务');
  assert(
    (await page.getByRole('button', { name: '继续' }).count()) === 1,
    'after: stopped task offers resume',
  );
  await page.getByRole('button', { name: '展开右侧详情' }).click();
  await page.locator('dt', { hasText: '停止证据' }).waitFor();
  assert(
    (await page.getByText('40127', { exact: false }).count()) > 0,
    'after: stop evidence PID shown',
  );
  await page.getByRole('button', { name: '收起右侧详情' }).click();

  await openConversation(page, 'GitHub 汇入任务');
  await page.getByText('GitHub 汇入 · github:42').first().waitFor();

  await openConversation(page, '历史分页验证');
  await scrollMainTo(page, 'top');
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await page.waitForTimeout(500);
  assert(
    (await page.getByText('已读取').count()) > 0,
    'after: read delivery evidence still rendered',
  );
  record('M4 regression and copy', 'pass', 'stopped/resume, GitHub import, delivery read, M5 copy');

  await light.context.close();
}

/* ----------------------------------- main ---------------------------------- */

async function main() {
  await mkdir(EVIDENCE, { recursive: true });
  currentDatabase = await createDatabase();
  console.log(`isolated database: ${currentDatabase.name}`);
  migrate(currentDatabase.url);
  const seeded = await seed(currentDatabase.url);
  const bridge = await startFakeBridge();

  if (!SKIP_BUILD) {
    buildWorktree(ROOT);
    if (!process.env.M4UX_SKIP_BEFORE) {
      ensureBeforeWorktree();
    }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    if (!process.env.M4UX_SKIP_BEFORE) {
      const before = await startApi(BEFORE_DIR, BEFORE_PORT);
      try {
        await captureBefore(browser, { baseURL: before.url, token: seeded.sessionToken });
      } finally {
        await before.stop();
      }
    }

    const after = await startApi(ROOT, AFTER_PORT);
    try {
      await captureAfter(browser, { baseURL: after.url, token: seeded.sessionToken });
      await functional(browser, { baseURL: after.url, token: seeded.sessionToken }, seeded);
    } finally {
      await after.stop();
    }
  } finally {
    await browser.close();
    await bridge.close();
    for (const server of servers) {
      if (!server.killed) server.kill('SIGKILL');
    }
    if (!KEEP) {
      await dropDatabase(currentDatabase.name);
    } else {
      console.log(`kept database: ${currentDatabase.name}`);
    }
  }

  await writeFile(
    path.join(EVIDENCE, 'm4ux-e2e.json'),
    `${JSON.stringify({ at: new Date().toISOString(), baseSha: BASE_SHA, results }, null, 2)}\n`,
  );
  console.log(`evidence: ${EVIDENCE}`);
  console.log(
    `passed ${results.filter((item) => item.status === 'pass').length}/${results.length}`,
  );
}

main().catch(async (error) => {
  console.error(error);
  record('run', 'fail', error instanceof Error ? error.message : String(error));
  await writeFile(
    path.join(EVIDENCE, 'm4ux-e2e.json'),
    `${JSON.stringify({ at: new Date().toISOString(), baseSha: BASE_SHA, results }, null, 2)}\n`,
  ).catch(() => {});
  if (!KEEP && currentDatabase) {
    await dropDatabase(currentDatabase.name).catch(() => {});
  }
  process.exit(1);
});
