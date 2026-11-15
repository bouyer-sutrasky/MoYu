#!/usr/bin/env node
/* global window, fetch, setTimeout, URL */
/**
 * M6-B acceptance evidence.
 *
 * It starts an isolated PostgreSQL database, a real host supervisor, two real
 * API processes (baseline `main@68c01e5` and this checkout) and real Chromium
 * pages over the same isolated data. It exercises:
 *
 *   B1  SSE-driven browser notification, permission handling, cross-tab /
 *       refresh dedupe and click-to-conversation
 *   B2  owner-scoped history search, stable cursor pagination and edge cases
 *   B3  dry-run preview, explicit confirmation, merged/clean/occupied/boundary
 *       refusals, real deletion, idempotent retry and audit trail
 *   B4  raw command/output/exit-code logs plus before/after UI captures
 *
 * It only touches:
 *   - the isolated PostgreSQL server in TEST_DATABASE_ADMIN_URL (a fresh DB)
 *   - $M6B_RUN_DIR (default /tmp/m6b-run)
 *   - loopback ports 4625/4626/4696
 * It never restarts 3082, the production API on 4300, or /root/src/upstream.
 *
 * Usage:
 *   TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
 *   node scripts/m6b/evidence.mjs
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { chromium } from 'playwright';

import { taskSummary } from './task-summary.mjs';

const { Client } = pg;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const OUT = path.join(REPO, 'docs/evidence/m6b');
const RUN = process.env.M6B_RUN_DIR ?? '/tmp/m6b-run';
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = process.env.M6B_DB_NAME ?? 'moyu_m6b_evidence';
const BASELINE_HEAD = process.env.M6B_BASELINE ?? '68c01e50d69a075183a0a175c57611fa77e1163a';
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();

const HEAD_PORT = Number(process.env.M6B_HEAD_PORT ?? 4625);
const BEFORE_PORT = Number(process.env.M6B_BEFORE_PORT ?? 4626);
const SUP_PORT = Number(process.env.M6B_SUPERVISOR_PORT ?? 4696);
const HEAD_URL = `http://127.0.0.1:${HEAD_PORT}`;
const BEFORE_URL = `http://127.0.0.1:${BEFORE_PORT}`;
const SUP_TOKEN = randomBytes(24).toString('hex');
const SESSION_TOKEN = `m6b-session-${randomBytes(16).toString('hex')}`;
const OTHER_TOKEN = `m6b-other-${randomBytes(16).toString('hex')}`;
const GITHUB_CLI = process.env.M6B_GITHUB_CLI ?? '/root/.local/bin/gh-agent';

if (!ADMIN_URL) {
  throw new Error('TEST_DATABASE_ADMIN_URL is required for the M6-B acceptance run.');
}
const DATABASE_URL = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  return url.toString();
})();

const children = [];
const cleanupFns = [];
const evidence = new Map();

function ensureDir(directory) {
  mkdirSync(directory, { recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
  });
  if (result.error) throw result.error;
  return {
    command: [command, ...args].join(' '),
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    exitCode: result.status ?? -1,
  };
}

function runOrThrow(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${result.command} failed (${result.exitCode}):\n${result.output}`);
  }
  return result;
}

function start(name, command, args, options = {}) {
  ensureDir(path.join(RUN, 'logs'));
  const logPath = path.join(RUN, 'logs', `${name}.log`);
  appendFileSync(logPath, `\n=== ${name} ${new Date().toISOString()} ===\n`);
  const logFd = openSync(logPath, 'a');
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  children.push({ name, child, logPath });
  return child;
}

async function stopChildren() {
  for (const { name, child } of children.splice(0)) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    if (!existsSync(path.join(RUN, 'logs', `${name}.log`))) continue;
  }
}

async function waitFor(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not become ready at ${url}: ${last}`);
}

async function waitForSupervisor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`supervisor did not become ready at ${url}: ${last}`);
}

async function api(base, cookie, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(cookie ? { cookie: `moyu_session=${cookie}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

function record(item, side, entry) {
  const key = `${item}-${side}`;
  if (!evidence.has(key)) evidence.set(key, { item, side, entries: [] });
  evidence.get(key).entries.push(entry);
}

function writeEvidenceFiles() {
  const baselineShort = BASELINE_HEAD.slice(0, 12);
  for (const { item, side, entries } of evidence.values()) {
    const base = item.endsWith(`-${side}`) ? item.slice(0, item.length - side.length - 1) : item;
    const lines = [
      `# ${base}-${side} — ${new Date().toISOString()}`,
      ...(side === 'red'
        ? [
            '# Red-side result semantics: exit code 0 = the baseline lacks or fails this acceptance item (the expected red); exit code 1 = the feature unexpectedly exists on the baseline.',
          ]
        : []),
      `$ git rev-parse HEAD`,
      HEAD,
      `# baseline for the red side`,
      `$ git rev-parse ${BASELINE_HEAD}`,
      BASELINE_HEAD,
      '',
    ];
    for (const entry of entries) {
      lines.push(`$ ${entry.command}`, entry.output.trimEnd(), `exit code: ${entry.exitCode}`, '');
    }
    writeFileSync(path.join(OUT, `${base}-${side}.txt`), `${lines.join('\n')}\n`);
  }
  writeFileSync(
    path.join(OUT, 'run.json'),
    `${JSON.stringify({ head: HEAD, baseline: BASELINE_HEAD, baselineShort, ranAt: new Date().toISOString(), database: DB_NAME }, null, 2)}\n`,
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function createDatabase() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function dropDatabase() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

function setupWorktrees(seed) {
  const root = path.join(RUN, 'worktrees');
  const profile = path.join(root, 'probe1');
  ensureDir(profile);
  const remote = path.join(RUN, 'remote.git');
  rmSync(remote, { recursive: true, force: true });
  runOrThrow('git', ['init', '-q', '--bare', '-b', 'main', remote]);

  // A source repository with a real linked worktree is used for the clean
  // ticket, so `git worktree list` has an administrative record that cleanup
  // must prune. The other tickets use independent clones.
  const source = path.join(RUN, 'task-source');
  rmSync(source, { recursive: true, force: true });
  ensureDir(source);
  runOrThrow('git', ['init', '-q', '-b', 'main'], { cwd: source });
  runOrThrow('git', ['config', 'user.email', 'm6b@example.invalid'], { cwd: source });
  runOrThrow('git', ['config', 'user.name', 'M6B Evidence'], { cwd: source });
  writeFileSync(path.join(source, 'keep.txt'), 'm6b evidence source\n');
  runOrThrow('git', ['add', '.'], { cwd: source });
  runOrThrow('git', ['commit', '-q', '-m', 'M6-B evidence source'], { cwd: source });
  runOrThrow('git', ['remote', 'add', 'origin', remote], { cwd: source });
  runOrThrow('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: source });

  const addLinked = (ticketId) => {
    const directory = path.join(profile, `task-${ticketId.slice(0, 12)}`);
    rmSync(directory, { recursive: true, force: true });
    runOrThrow(
      'git',
      ['worktree', 'add', '-q', '-b', `agent/m6b-${ticketId.slice(0, 12)}`, directory, 'main'],
      { cwd: source },
    );
    runOrThrow('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: directory });
    return directory;
  };

  const clone = (ticketId) => {
    const directory = path.join(profile, `task-${ticketId.slice(0, 12)}`);
    rmSync(directory, { recursive: true, force: true });
    runOrThrow('git', ['clone', '-q', remote, directory], { cwd: RUN });
    runOrThrow('git', ['config', 'user.email', 'm6b@example.invalid'], { cwd: directory });
    runOrThrow('git', ['config', 'user.name', 'M6B Evidence'], { cwd: directory });
    const hasHead =
      run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: directory }).exitCode === 0;
    if (!hasHead) {
      writeFileSync(path.join(directory, 'keep.txt'), 'm6b evidence worktree\n');
      runOrThrow('git', ['add', '.'], { cwd: directory });
      runOrThrow('git', ['commit', '-q', '-m', 'M6-B evidence fixture'], { cwd: directory });
    }
    return directory;
  };
  const push = (directory) => {
    runOrThrow('git', ['remote', 'set-url', 'origin', remote], { cwd: directory });
    runOrThrow('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: directory });
  };

  const clean = addLinked(seed.tickets.clean);

  const dirty = clone(seed.tickets.dirty);
  push(dirty);
  writeFileSync(path.join(dirty, 'dirty.txt'), 'uncommitted evidence change\n');

  const unmerged = clone(seed.tickets.unmerged);
  push(unmerged);

  const occupied = clone(seed.tickets.occupied);
  push(occupied);
  const squatter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    cwd: occupied,
    stdio: 'ignore',
  });
  cleanupFns.push(() => {
    try {
      squatter.kill('SIGKILL');
    } catch {
      // gone
    }
  });

  // A ticket directory that resolves outside WORKTREE_ROOT must be refused and
  // must never be deleted. This is a real symlink, not a string check.
  const outside = path.join(RUN, 'outside-worktree');
  rmSync(outside, { recursive: true, force: true });
  ensureDir(outside);
  writeFileSync(path.join(outside, 'secret.txt'), 'must survive the cleanup\n');
  runOrThrow('git', ['init', '-q', '-b', 'main'], { cwd: outside });
  runOrThrow('git', ['config', 'user.email', 'm6b@example.invalid'], { cwd: outside });
  runOrThrow('git', ['config', 'user.name', 'M6B Evidence'], { cwd: outside });
  writeFileSync(path.join(outside, 'file.txt'), 'outside\n');
  runOrThrow('git', ['add', '.'], { cwd: outside });
  runOrThrow('git', ['commit', '-q', '-m', 'outside fixture'], { cwd: outside });
  const outsideLink = path.join(profile, `task-${seed.tickets.outside.slice(0, 12)}`);
  rmSync(outsideLink, { recursive: true, force: true });
  symlinkSync(outside, outsideLink);

  return { root, profile, source, clean, dirty, unmerged, occupied, outside, outsideLink };
}

function buildBaseline() {
  const baseline = path.join(RUN, 'baseline');
  if (existsSync(path.join(baseline, 'apps/web/dist/index.html'))) return baseline;
  try {
    run('git', ['worktree', 'remove', '--force', baseline], { cwd: REPO });
  } catch {
    // not registered
  }
  rmSync(baseline, { recursive: true, force: true });
  runOrThrow('git', ['worktree', 'add', '--detach', baseline, BASELINE_HEAD], { cwd: REPO });
  runOrThrow('corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd: baseline });
  runOrThrow('corepack', ['pnpm', 'build'], { cwd: baseline });
  return baseline;
}

function startApi(name, cwd, port, webDist, extraEnv = {}) {
  return start(name, process.execPath, ['apps/api/dist/server.js'], {
    cwd,
    env: {
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      LOG_LEVEL: 'info',
      DATABASE_URL,
      WEBAUTHN_RP_ID: '127.0.0.1',
      WEBAUTHN_RP_NAME: 'MoYu',
      WEBAUTHN_ORIGIN: `http://127.0.0.1:${port}`,
      AUTH_COOKIE_SECURE: 'false',
      ARTIFACT_STORAGE_DIR: path.join(RUN, 'artifacts'),
      WEB_DIST_DIR: webDist,
      GITHUB_CLI,
      ...extraEnv,
    },
  });
}

function startSupervisor() {
  const instances = path.join(RUN, 'instances.json');
  writeFileSync(
    instances,
    `${JSON.stringify({
      instances: [
        { repository: 'bouyer-sutrasky/MoYu', profile: 'probe1', dshPort: 4692, bridgePort: 4693 },
      ],
      portRange: { start: 4692, end: 4699 },
    })}\n`,
  );
  return start('supervisor', process.execPath, ['apps/supervisor/dist/main.js'], {
    env: {
      SUPERVISOR_HOST: '127.0.0.1',
      SUPERVISOR_PORT: String(SUP_PORT),
      SUPERVISOR_TOKEN: SUP_TOKEN,
      DATABASE_URL,
      INSTANCES_CONFIG: instances,
      DSH_BIN: '/usr/bin/dsh',
      DSH_HOME: path.join(RUN, 'dsh'),
      PLATFORM_URL: HEAD_URL,
      RUNTIME_CREDENTIALS_DIR: path.join(RUN, 'creds'),
      INSTANCE_ENV_DIR: path.join(RUN, 'env'),
      INSTANCE_LOG_DIR: path.join(RUN, 'logs'),
      WORKTREE_ROOT: path.join(RUN, 'worktrees'),
      LOG_LEVEL: 'info',
      NODE_ENV: 'test',
    },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSse(page, minimum, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await page.evaluate(() => window.__m6b?.sse ?? 0);
    if (value >= minimum) return value;
    await sleep(150);
  }
  return page.evaluate(() => window.__m6b?.sse ?? 0);
}

function notificationInitScript() {
  return (arg) => {
    const currentOwner = arg.ownerId;
    const mode = arg.permission;
    const result = arg.requestResult;
    window.__m6b = {
      sse: 0,
      notifications: [],
      instances: [],
      permissionRequests: 0,
    };
    try {
      window.localStorage.setItem(
        `moyu.notify.settings.v1:${currentOwner}`,
        JSON.stringify({
          mode: 'always',
          categories: { needs_reply: true, review: true, completed: true, failed: true },
        }),
      );
    } catch {
      // storage unavailable; permission test still runs
    }
    const Original = window.EventSource;
    if (Original) {
      class TracedEventSource extends Original {
        constructor(...args) {
          super(...args);
          this.addEventListener('workspaceEvent', () => {
            window.__m6b.sse += 1;
          });
        }
      }
      window.EventSource = TracedEventSource;
    }
    class TracedNotification {
      constructor(title, options) {
        this.title = title;
        this.options = options;
        this.onclick = null;
        window.__m6b.notifications.push({
          title,
          body: options?.body ?? null,
          tag: options?.tag ?? null,
        });
        window.__m6b.instances.push(this);
      }
      close() {}
    }
    TracedNotification.permission = mode;
    TracedNotification.requestPermission = async () => {
      window.__m6b.permissionRequests += 1;
      return result;
    };
    window.Notification = TracedNotification;
  };
}

async function openPage(browser, baseUrl, token, viewport, theme, initScript, initArg) {
  const context = await browser.newContext({ viewport, colorScheme: theme, locale: 'zh-CN' });
  await context.addCookies([
    { name: 'moyu_session', value: token, domain: '127.0.0.1', path: '/' },
  ]);
  await context.addInitScript((mode) => {
    try {
      window.localStorage.setItem('moyu.theme', mode);
    } catch {
      // ignored
    }
  }, theme);
  if (initScript) await context.addInitScript(initScript, initArg);
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('工作台导航').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(900);
  return { context, page };
}

async function openMobileNav(page) {
  const button = page.getByRole('button', { name: '打开导航' });
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await page.waitForTimeout(400);
  }
}

async function screenshot(page, name, records, meta) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled' });
  records.push({ name, file: path.relative(REPO, file), ...meta });
}

async function captureActivity(page, viewport, name, records, meta) {
  await openMobileNav(page);
  await page.getByRole('button', { name: '活动中心' }).first().click();
  const dialog = page.getByRole('dialog', { name: '活动中心' });
  await dialog.waitFor({ state: 'visible' });
  await page.waitForTimeout(1000);
  const text = await dialog.innerText();
  await screenshot(page, name, records, meta);
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await dialog.waitFor({ state: 'detached' });
  return text;
}

async function captureSettings(page, viewport, name, records, meta) {
  await openMobileNav(page);
  await page.getByLabel('工作台导航').getByRole('button', { name: '设置' }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await dialog.waitFor({ state: 'visible' });
  await page.waitForTimeout(700);
  const text = await dialog.innerText();
  await screenshot(page, name, records, meta);
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await dialog.waitFor({ state: 'detached' });
  return text;
}

async function main() {
  ensureDir(OUT);
  ensureDir(RUN);
  ensureDir(path.join(RUN, 'artifacts'));
  await createDatabase();
  cleanupFns.push(() => dropDatabase());

  runOrThrow('corepack', ['pnpm', 'build'], { timeout: 600_000 });
  runOrThrow('corepack', ['pnpm', '--filter', '@moyu/db', 'db:migrate'], {
    env: { DATABASE_URL },
    timeout: 120_000,
  });

  const seedProcess = runOrThrow(process.execPath, ['scripts/m6b/seed-fixture.mjs'], {
    env: {
      DATABASE_URL,
      M6B_SESSION_TOKEN: SESSION_TOKEN,
      M6B_OTHER_TOKEN: OTHER_TOKEN,
    },
  });
  const seed = parseJson(seedProcess.output);
  if (!seed) throw new Error(`seed fixture did not return JSON:\n${seedProcess.output}`);
  const worktrees = setupWorktrees(seed);

  startSupervisor();
  startApi('api-head', REPO, HEAD_PORT, path.join(REPO, 'apps/web/dist'), {
    SUPERVISOR_URL: `http://127.0.0.1:${SUP_PORT}`,
    SUPERVISOR_TOKEN: SUP_TOKEN,
  });
  const baseline = buildBaseline();
  startApi('api-before', baseline, BEFORE_PORT, path.join(baseline, 'apps/web/dist'));

  await waitFor(`${HEAD_URL}/readyz`, 'head API');
  await waitFor(`${BEFORE_URL}/readyz`, 'baseline API');
  // The supervisor's health route requires its Bearer token; an intentional 401
  // proves the listener is up without weakening the endpoint.
  await waitForSupervisor(`http://127.0.0.1:${SUP_PORT}/control/v1/health`);

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  cleanupFns.push(async () => db.end().catch(() => undefined));

  // The baseline page loads the same isolated database but its build lacks the
  // M6-B endpoints and components.
  const baselineNote =
    'The baseline build has no M6-B endpoint; the not-found handler is the raw output.';
  for (const [item, route] of [
    ['B1-red', '/api/v1/activity'],
    ['B2-red', '/api/v1/history/search?q=x'],
    ['B3-red', '/api/v1/cleanup/runs'],
  ]) {
    const result = await api(BEFORE_URL, SESSION_TOKEN, route);
    record(item, 'red', {
      command: `curl -s -o /dev/null -w '%{http_code}' -b 'moyu_session=<session>' ${BEFORE_URL}${route}`,
      output: `HTTP ${result.status}\n${baselineNote}\n${result.text.slice(0, 500)}`,
      exitCode: result.status === 200 ? 1 : 0,
    });
  }
  {
    const result = await api(BEFORE_URL, SESSION_TOKEN, '/api/v1/cleanup/preview', {
      method: 'POST',
      body: {},
    });
    record('B3-red', 'red', {
      command: `curl -s -X POST -H 'content-type: application/json' -d '{}' -b 'moyu_session=<session>' ${BEFORE_URL}/api/v1/cleanup/preview`,
      output: `HTTP ${result.status}\n${baselineNote}\n${result.text.slice(0, 500)}`,
      exitCode: result.status === 200 ? 1 : 0,
    });
  }

  const browser = await chromium.launch({ headless: true });
  cleanupFns.push(async () => browser.close());
  const records = [];
  const desktop = { width: 1440, height: 900 };
  const mobile = { width: 390, height: 844 };

  // --- baseline UI: proves the old build only had the M6 placeholder ---------
  for (const [label, viewport, theme] of [
    ['desktop-light', desktop, 'light'],
    ['mobile-dark', mobile, 'dark'],
  ]) {
    const { context, page } = await openPage(browser, BEFORE_URL, SESSION_TOKEN, viewport, theme);
    const activityText = await captureActivity(
      page,
      viewport,
      `before-activity-${label}`,
      records,
      {
        base: 'before',
        viewport,
        theme,
      },
    );
    const settingsText = await captureSettings(
      page,
      viewport,
      `before-settings-${label}`,
      records,
      { base: 'before', viewport, theme },
    );
    const placeholder = activityText.includes('活动中心与通知在 M6 接入');
    record('B1-red', 'red', {
      command: `playwright open ${BEFORE_URL} (${label}); 点击「活动中心」`,
      output: `activity placeholder present: ${placeholder}\nsettings has 通知 section: ${settingsText.includes('浏览器通知权限')}\nsettings has 清理 section: ${settingsText.includes('干跑预览可清理目录')}\n--- activity text ---\n${activityText.slice(0, 700)}`,
      exitCode: placeholder && !settingsText.includes('浏览器通知权限') ? 0 : 1,
    });
    await context.close();
  }

  // --- B1: real SSE event, two tabs, cross-tab and refresh dedupe ------------
  const notifInit = notificationInitScript();
  const notifArg = { ownerId: seed.ownerId, permission: 'granted', requestResult: 'granted' };
  // Two tabs in ONE browser context: localStorage and Web Locks are shared, so
  // this is a real multi-tab browser, not two isolated incognito sessions.
  const notifContext = await browser.newContext({
    viewport: desktop,
    colorScheme: 'light',
    locale: 'zh-CN',
  });
  await notifContext.addCookies([
    { name: 'moyu_session', value: SESSION_TOKEN, domain: '127.0.0.1', path: '/' },
  ]);
  await notifContext.addInitScript((mode) => {
    try {
      window.localStorage.setItem('moyu.theme', mode);
    } catch {
      // ignored
    }
  }, 'light');
  await notifContext.addInitScript(notifInit, notifArg);
  const pageA = await notifContext.newPage();
  await pageA.goto(HEAD_URL, { waitUntil: 'domcontentloaded' });
  await pageA.getByLabel('工作台导航').waitFor({ state: 'visible', timeout: 25_000 });
  await pageA.waitForTimeout(900);
  const pageB = await notifContext.newPage();
  await pageB.goto(HEAD_URL, { waitUntil: 'domcontentloaded' });
  await pageB.getByLabel('工作台导航').waitFor({ state: 'visible', timeout: 25_000 });
  await pageB.waitForTimeout(900);
  const tabA = { page: pageA };
  const tabB = { page: pageB };
  const sseA0 = await waitForSse(tabA.page, 1);
  const sseB0 = await waitForSse(tabB.page, 1);

  const questionText = `M6-B 通知去重事件 ${randomBytes(4).toString('hex')}`;
  const liveSummary = await taskSummary(db, seed.runningTaskId, {
    state: 'waiting_input',
    question: questionText,
  });
  await db.query(
    `insert into events (type, repository_id, conversation_id, task_id, payload, occurred_at)
     values ('task.question', $1, $2, $3, $4::jsonb, now())`,
    [
      seed.repositoryId,
      seed.runningConversationId,
      seed.runningTaskId,
      JSON.stringify({ task: liveSummary }),
    ],
  );
  await waitForSse(tabA.page, sseA0 + 1);
  await waitForSse(tabB.page, sseB0 + 1);
  await sleep(1200);
  const debugA = await tabA.page.evaluate(() => window.__m6b);
  const debugB = await tabB.page.evaluate(() => window.__m6b);
  const delivered = [...debugA.notifications, ...debugB.notifications];
  const dedupeTag = delivered[0]?.tag ?? null;
  record('B1-green', 'green', {
    command: `insert a real task.question event, then read window.__m6b from two Chromium tabs`,
    output: JSON.stringify(
      {
        eventQuestion: questionText,
        tabA: { sseReceived: debugA.sse, notifications: debugA.notifications },
        tabB: { sseReceived: debugB.sse, notifications: debugB.notifications },
        rawNotificationTotal: delivered.length,
        dedupeKey: dedupeTag,
      },
      null,
      2,
    ),
    exitCode: delivered.length === 1 ? 0 : 1,
  });

  // Click the one notification and prove the target conversation opens.
  let clickedTab = debugA.notifications.length > 0 ? tabA : tabB;
  const clickedDebug = await clickedTab.page.evaluate(() => {
    const instance = window.__m6b.instances[0];
    if (!instance) return null;
    instance.onclick?.();
    return { title: instance.title, body: instance.options?.body };
  });
  await sleep(1000);
  const activeConversation = await clickedTab.page
    .locator('[data-conversation-id][aria-current="true"]')
    .first()
    .getAttribute('data-conversation-id')
    .catch(() => null);
  record('B1-green', 'green', {
    command: `click window.__m6b.instances[0].onclick(), read the selected sidebar row`,
    output: JSON.stringify(
      {
        notification: clickedDebug,
        activeConversation,
        expectedConversation: seed.runningConversationId,
      },
      null,
      2,
    ),
    exitCode: activeConversation === seed.runningConversationId ? 0 : 1,
  });

  // Refresh: the SSE stream replays the recent question. The persisted claim by
  // event id must suppress a second OS notification.
  await tabA.page.reload({ waitUntil: 'domcontentloaded' });
  await tabA.page.getByLabel('工作台导航').waitFor({ state: 'visible', timeout: 25_000 });
  await waitForSse(tabA.page, 1);
  await sleep(2000);
  const afterReload = await tabA.page.evaluate(() => window.__m6b);
  record('B1-green', 'green', {
    command: `reload the first tab, read window.__m6b after SSE replay`,
    output: JSON.stringify(
      {
        sseReceivedAfterReload: afterReload.sse,
        notificationsAfterReload: afterReload.notifications,
        dedupeKey: dedupeTag,
      },
      null,
      2,
    ),
    exitCode: afterReload.notifications.length === 0 && afterReload.sse > 0 ? 0 : 1,
  });

  // Ordinary progress must never become a system notification.
  const progressCountBefore = afterReload.notifications.length;
  await db.query(
    `insert into events (type, repository_id, conversation_id, task_id, payload, occurred_at)
     values ('task.progress', $1, $2, $3, $4::jsonb, now())`,
    [
      seed.repositoryId,
      seed.runningConversationId,
      seed.runningTaskId,
      JSON.stringify({
        ticketId: seed.tickets.running,
        text: '普通进度不通知',
        at: new Date().toISOString(),
      }),
    ],
  );
  await sleep(2200);
  const afterProgress = await tabA.page.evaluate(() => window.__m6b);
  record('B1-green', 'green', {
    command: `insert a task.progress event and wait one SSE poll`,
    output: JSON.stringify(
      {
        notificationsBefore: progressCountBefore,
        notificationsAfter: afterProgress.notifications.length,
      },
      null,
      2,
    ),
    exitCode: afterProgress.notifications.length === progressCountBefore ? 0 : 1,
  });

  await notifContext.close();

  // Permission denied: actionable text, no automatic request, main flow usable.
  const deniedInit = notificationInitScript();
  const denied = await openPage(browser, HEAD_URL, SESSION_TOKEN, desktop, 'light', deniedInit, {
    ownerId: seed.ownerId,
    permission: 'denied',
    requestResult: 'denied',
  });
  await openMobileNav(denied.page);
  await denied.page.getByLabel('工作台导航').getByRole('button', { name: '设置' }).click();
  const deniedDialog = denied.page.getByRole('dialog', { name: '设置' });
  await deniedDialog.waitFor();
  const deniedText = await deniedDialog.innerText();
  const deniedRequests = await denied.page.evaluate(() => window.__m6b.permissionRequests);
  await deniedDialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await sleep(2200);
  const deniedDebug = await denied.page.evaluate(() => window.__m6b);
  record('B1-green', 'green', {
    command: `Chromium with Notification.permission='denied'; open Settings and a real event`,
    output: JSON.stringify(
      {
        hasActionableDeniedText: deniedText.includes('浏览器已拒绝通知'),
        permissionRequestsTriggeredAutomatically: deniedRequests,
        notificationsDeliveredWhileDenied: deniedDebug.notifications.length,
        mainFlowVisible: await denied.page.getByRole('combobox', { name: '选择仓库' }).isVisible(),
      },
      null,
      2,
    ),
    exitCode:
      deniedText.includes('浏览器已拒绝通知') &&
      deniedRequests === 0 &&
      deniedDebug.notifications.length === 0
        ? 0
        : 1,
  });
  await denied.context.close();

  // Explicit permission request is one owner action, not a page-load prompt.
  const defaultInit = notificationInitScript();
  const granted = await openPage(browser, HEAD_URL, SESSION_TOKEN, desktop, 'light', defaultInit, {
    ownerId: seed.ownerId,
    permission: 'default',
    requestResult: 'granted',
  });
  await openMobileNav(granted.page);
  await granted.page.getByLabel('工作台导航').getByRole('button', { name: '设置' }).click();
  const grantedDialog = granted.page.getByRole('dialog', { name: '设置' });
  await grantedDialog.waitFor();
  const requestsBefore = await granted.page.evaluate(() => window.__m6b.permissionRequests);
  await grantedDialog.getByRole('button', { name: '允许通知' }).click();
  await sleep(400);
  const requestsAfter = await granted.page.evaluate(() => window.__m6b.permissionRequests);
  record('B1-green', 'green', {
    command: `open Settings with permission='default' and click「允许通知」once`,
    output: JSON.stringify(
      {
        requestsOnPageLoad: requestsBefore,
        requestsAfterExplicitClick: requestsAfter,
        requestButtonGone:
          (await grantedDialog.getByRole('button', { name: '允许通知' }).count()) === 0,
      },
      null,
      2,
    ),
    exitCode: requestsBefore === 0 && requestsAfter === 1 ? 0 : 1,
  });
  await granted.context.close();

  // --- B2: history search ----------------------------------------------------
  const search = async (query) => api(HEAD_URL, SESSION_TOKEN, `/api/v1/history/search?${query}`);
  {
    const first = await search(`q=${encodeURIComponent('星河')}&limit=1`);
    const firstData = first.body?.data;
    const second = await search(
      `q=${encodeURIComponent('星河')}&limit=1&cursor=${encodeURIComponent(firstData?.nextCursor ?? '')}`,
    );
    const secondData = second.body?.data;
    const overlap =
      firstData?.items?.some((item) =>
        secondData?.items?.some((other) => other.conversation.id === item.conversation.id),
      ) ?? false;
    record('B2-green', 'green', {
      command: `GET /api/v1/history/search?q=星河&limit=1, then the returned cursor`,
      output: `HTTP ${first.status}\n${JSON.stringify(firstData, null, 2).slice(0, 2500)}\nHTTP ${second.status}\n${JSON.stringify(secondData, null, 2).slice(0, 1500)}`,
      exitCode:
        first.status === 200 && second.status === 200 && firstData.items.length === 1 && !overlap
          ? 0
          : 1,
    });
    const cross = await search(`q=${encodeURIComponent('cross owner secret')}`);
    record('B2-green', 'green', {
      command: `GET /api/v1/history/search?q=cross owner secret`,
      output: `HTTP ${cross.status}\n${JSON.stringify(cross.body?.data, null, 2)}`,
      exitCode: cross.status === 200 && cross.body?.data?.items?.length === 0 ? 0 : 1,
    });
    const special = await search(`q=${encodeURIComponent('100%_safe')}`);
    const long = await search(`q=${encodeURIComponent('星'.repeat(1500))}`);
    const empty = await search('q=');
    const wrongCursor = await search(
      `q=${encodeURIComponent('100%_safe')}&cursor=${encodeURIComponent(firstData?.nextCursor ?? '')}`,
    );
    record('B2-green', 'green', {
      command: `special / overlong / empty keyword and a cursor from another query`,
      output: [
        `special HTTP ${special.status}: ${JSON.stringify(special.body?.data?.items?.[0]?.snippet ?? null)}`,
        `overlong HTTP ${long.status}: ${JSON.stringify(long.body?.data?.items ?? [])}`,
        `empty HTTP ${empty.status}: ${empty.body?.data?.items?.length ?? 0} recent items`,
        `cursor-reuse HTTP ${wrongCursor.status}: ${JSON.stringify(wrongCursor.body?.error ?? {})}`,
      ].join('\n'),
      exitCode:
        special.status === 200 &&
        special.body?.data?.items?.length === 1 &&
        long.status === 200 &&
        empty.status === 200 &&
        wrongCursor.status === 422
          ? 0
          : 1,
    });
  }

  // --- B3: dry run, explicit confirmation, real deletion ---------------------
  const preview = await api(HEAD_URL, SESSION_TOKEN, '/api/v1/cleanup/preview', {
    method: 'POST',
    body: {},
  });
  const previewRun = preview.body?.data?.run;
  const byTicket = Object.fromEntries(
    (previewRun?.items ?? []).map((item) => [item.ticketId, item]),
  );
  const cleanItem = byTicket[seed.tickets.clean];
  const dirtyItem = byTicket[seed.tickets.dirty];
  const occupiedItem = byTicket[seed.tickets.occupied];
  const outsideItem = byTicket[seed.tickets.outside];
  const unmergedItem = byTicket[seed.tickets.unmerged];
  record('B3-green', 'green', {
    command: `curl -s -X POST -d '{}' ${HEAD_URL}/api/v1/cleanup/preview`,
    output: `HTTP ${preview.status}\n${JSON.stringify(previewRun, null, 2).slice(0, 6000)}`,
    exitCode:
      preview.status === 200 &&
      previewRun?.summary?.eligible === 1 &&
      cleanItem?.eligible === true &&
      dirtyItem?.eligible === false &&
      occupiedItem?.eligible === false &&
      outsideItem?.eligible === false &&
      unmergedItem?.eligible === false
        ? 0
        : 1,
  });
  // The explicit-confirmation UI is captured before the run is executed, so the
  // danger button and its warning are in the screenshot while they are real.
  {
    const { context, page } = await openPage(browser, HEAD_URL, SESSION_TOKEN, desktop, 'light');
    await openMobileNav(page);
    await page.getByLabel('工作台导航').getByRole('button', { name: '设置' }).click();
    const dialog = page.getByRole('dialog', { name: '设置' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '干跑预览可清理目录' }).click();
    await dialog.getByText('预览：').first().waitFor({ timeout: 25_000 });
    await page.waitForTimeout(1200);
    const previewText = await dialog.innerText();
    const deleteButton = dialog.getByRole('button', { name: /删除预览中的/ });
    const hasDeleteButton = (await deleteButton.count()) > 0;
    if (hasDeleteButton) await deleteButton.click();
    const confirmBox = dialog.getByText('确认删除下列');
    await confirmBox.waitFor({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const confirmText = await dialog.innerText();
    await screenshot(page, 'after-cleanup-confirm-desktop-light', records, {
      base: 'after',
      viewport: desktop,
      theme: 'light',
    });
    record('B3-green', 'green', {
      command: `open Settings → 清理 → 干跑预览 → 删除预览中的目录…（不确认）`,
      output: `preview shows path/reason/size: ${previewText.includes('预览：') && previewText.includes('PR #') && previewText.includes('已合并且无未保存修改')}\nexplicit delete button present: ${hasDeleteButton}\nexplicit confirmation text present: ${confirmText.includes('确认删除下列')}\n--- preview ---\n${previewText.slice(-3000)}`,
      exitCode:
        hasDeleteButton && previewText.includes('预览：') && confirmText.includes('确认删除下列')
          ? 0
          : 1,
    });
    await context.close();
  }

  const cleanExistedBefore = existsSync(worktrees.clean);
  const worktreeListBefore = runOrThrow('git', ['worktree', 'list', '--porcelain'], {
    cwd: worktrees.source,
  });
  const execute = await api(HEAD_URL, SESSION_TOKEN, '/api/v1/cleanup/execute', {
    method: 'POST',
    body: { runId: previewRun?.id },
  });
  const executeRun = execute.body?.data?.run;
  const retry = await api(HEAD_URL, SESSION_TOKEN, '/api/v1/cleanup/execute', {
    method: 'POST',
    body: { runId: previewRun?.id },
  });
  const retryData = retry.body?.data;
  const worktreeListAfter = runOrThrow('git', ['worktree', 'list', '--porcelain'], {
    cwd: worktrees.source,
  });
  const removedItem = executeRun?.items?.find((item) => item.ticketId === seed.tickets.clean);
  const survived = {
    dirty: existsSync(worktrees.dirty),
    occupied: existsSync(worktrees.occupied),
    outside: existsSync(path.join(worktrees.outside, 'secret.txt')),
    unmerged: existsSync(worktrees.unmerged),
    cleanGone: !existsSync(worktrees.clean),
  };
  record('B3-green', 'green', {
    command: `POST /api/v1/cleanup/execute {runId}; then repeat; then check the real directories`,
    output: JSON.stringify(
      {
        http: execute.status,
        summary: executeRun?.summary,
        duplicateOnRetry: retryData?.duplicate,
        cleanExistedBefore,
        survived,
        worktreePruned: removedItem?.detail?.worktreePruned ?? null,
        worktreePruneError: removedItem?.detail?.worktreePruneError ?? null,
        cleanRecordGone: !worktreeListAfter.output.includes(worktrees.clean),
        items: executeRun?.items?.map((item) => ({
          ticket: item.ticketId,
          state: item.state,
          reason: item.reason,
        })),
      },
      null,
      2,
    ),
    exitCode:
      execute.status === 200 &&
      executeRun?.summary?.removed === 1 &&
      retryData?.duplicate === true &&
      survived.cleanGone &&
      survived.dirty &&
      survived.occupied &&
      survived.outside &&
      survived.unmerged &&
      removedItem?.detail?.worktreePruned === true &&
      !worktreeListAfter.output.includes(worktrees.clean)
        ? 0
        : 1,
  });
  record('B3-green', 'green', {
    command: `git -C ${worktrees.source} worktree list --porcelain (before and after cleanup)`,
    output: `--- before ---\n${worktreeListBefore.output}--- after ---\n${worktreeListAfter.output}clean directory record pruned: ${!worktreeListAfter.output.includes(worktrees.clean)}`,
    exitCode: !worktreeListAfter.output.includes(worktrees.clean) ? 0 : 1,
  });
  const runs = await api(HEAD_URL, SESSION_TOKEN, '/api/v1/cleanup/runs');
  record('B3-green', 'green', {
    command: `GET /api/v1/cleanup/runs`,
    output: `HTTP ${runs.status}\n${JSON.stringify(runs.body?.data?.runs, null, 2).slice(0, 4000)}`,
    exitCode: runs.status === 200 && (runs.body?.data?.runs?.length ?? 0) >= 2 ? 0 : 1,
  });

  // --- UI after captures -----------------------------------------------------
  for (const [label, viewport, theme] of [
    ['desktop-light', desktop, 'light'],
    ['mobile-dark', mobile, 'dark'],
  ]) {
    const { context, page } = await openPage(browser, HEAD_URL, SESSION_TOKEN, viewport, theme);
    const activityText = await captureActivity(page, viewport, `after-activity-${label}`, records, {
      base: 'after',
      viewport,
      theme,
    });
    const settingsText = await captureSettings(page, viewport, `after-settings-${label}`, records, {
      base: 'after',
      viewport,
      theme,
    });
    record('B1-green', 'green', {
      command: `playwright open ${HEAD_URL} (${label}); read activity and settings`,
      output: `activity has real records: ${activityText.includes('提醒') && !activityText.includes('M6 接入')}\nsettings has notification permission: ${settingsText.includes('浏览器通知权限')}\nsettings has cleanup preview: ${settingsText.includes('干跑预览可清理目录')}`,
      exitCode:
        activityText.includes('提醒') &&
        !activityText.includes('M6 接入') &&
        settingsText.includes('浏览器通知权限') &&
        settingsText.includes('干跑预览可清理目录')
          ? 0
          : 1,
    });
    await context.close();
  }

  {
    const { context, page } = await openPage(browser, HEAD_URL, SESSION_TOKEN, desktop, 'light');
    await openMobileNav(page);
    await page.getByLabel('工作台导航').getByRole('button', { name: '历史搜索' }).click();
    const dialog = page.getByRole('dialog', { name: '历史搜索' });
    await dialog.waitFor();
    await dialog.getByLabel('搜索历史任务').fill('星河');
    await page.waitForTimeout(1200);
    await screenshot(page, 'after-history-desktop-light', records, {
      base: 'after',
      viewport: desktop,
      theme: 'light',
    });
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await context.close();
  }

  writeFileSync(path.join(OUT, 'records.json'), `${JSON.stringify(records, null, 2)}\n`);
  writeFileSync(
    path.join(OUT, 'ui-records.json'),
    `${JSON.stringify(
      records.map((record) => ({
        name: record.name,
        base: record.base,
        theme: record.theme,
        viewport: record.viewport,
      })),
      null,
      2,
    )}\n`,
  );
  writeEvidenceFiles();
  process.stdout.write(`M6-B evidence written to ${path.relative(REPO, OUT)}\n`);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
} finally {
  for (const cleanup of cleanupFns.reverse()) {
    try {
      await cleanup();
    } catch {
      // best-effort
    }
  }
  await stopChildren();
}
process.exitCode = exitCode;
