#!/usr/bin/env node
/**
 * M6-C D rework regression: a notification click must not be lost when the
 * focused same-origin window is the login page (the workbench is not mounted).
 *
 * It uses the real API, a real durable event and the real notification worker.
 * The click is dispatched as a `notificationclick` event inside the worker so
 * the test exercises the same acknowledgement/fallback path as a system click.
 * Sign-in is a real Passkey ceremony with Playwright's virtual authenticator.
 *
 * Usage:
 *   M6C_RUNTIME_CALLBACK_TOKEN=... M6C_TEST_DATABASE_URL=postgres://... \
 *   node scripts/m6c/notifications-expired-session.mjs \
 *     --base-url http://localhost:3104 \
 *     --storage-state /tmp/storage.json \
 *     --credentials /tmp/credentials.json \
 *     --repository <uuid> --conversation <uuid> \
 *     --out /tmp/evidence
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';

import { fail, parseArgs, printHelpAndExit, writeJson } from './lib.mjs';

const HELP = [
  '--base-url <url>           MoYu origin (loopback HTTP or HTTPS)',
  '--storage-state <file>     Playwright storage-state JSON with a valid session',
  '--credentials <file>       WebAuthn credential array saved by bootstrap-owner.mjs',
  '--repository <uuid>        target repository id',
  '--conversation <uuid>      target conversation id',
  '--out <dir>                evidence directory',
  '--allow-production         allow https://moyu.sutrasky.com',
  '--help                     show this help without launching a browser',
];

const { values } = parseArgs(process.argv.slice(2));
if (values.help) {
  printHelpAndExit('Run the expired-session notification click regression', HELP, [
    'M6C_RUNTIME_CALLBACK_TOKEN=... M6C_TEST_DATABASE_URL=... node scripts/m6c/notifications-expired-session.mjs --base-url http://localhost:3104 --storage-state /tmp/storage.json --credentials /tmp/credentials.json --repository <uuid> --conversation <uuid> --out /tmp/evidence',
  ]);
}
for (const key of [
  'base-url',
  'storage-state',
  'credentials',
  'repository',
  'conversation',
  'out',
]) {
  if (!values[key]) fail(`notifications-expired-session: --${key} is required`, 2);
}
const baseUrl = new URL(String(values['base-url']));
if (!['http:', 'https:'].includes(baseUrl.protocol)) {
  fail('notifications-expired-session: base URL must be HTTP(S)', 2);
}
if (baseUrl.hostname === 'moyu.sutrasky.com' && values['allow-production'] !== true) {
  fail('notifications-expired-session: production origin needs --allow-production', 2);
}
if (
  baseUrl.protocol === 'http:' &&
  !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(baseUrl.hostname)
) {
  fail('notifications-expired-session: plain HTTP is allowed only on loopback', 2);
}
if (!process.env.DISPLAY && process.env.WAYLAND_DISPLAY === undefined) {
  fail('notifications-expired-session: a headed browser needs DISPLAY', 2);
}
const callbackToken = process.env.M6C_RUNTIME_CALLBACK_TOKEN;
if (!callbackToken) {
  fail('notifications-expired-session: M6C_RUNTIME_CALLBACK_TOKEN is required', 2);
}
const databaseUrl = process.env.M6C_TEST_DATABASE_URL;
if (!databaseUrl) {
  fail('notifications-expired-session: M6C_TEST_DATABASE_URL is required', 2);
}

const storageState = JSON.parse(readFileSync(resolve(String(values['storage-state'])), 'utf8'));
const credentials = JSON.parse(readFileSync(resolve(String(values.credentials)), 'utf8'));
if (!Array.isArray(credentials) || credentials.length === 0) {
  fail('notifications-expired-session: --credentials has no WebAuthn credential', 2);
}
const sessionCookie = Array.isArray(storageState.cookies)
  ? storageState.cookies.find((cookie) => /moyu_session$/.test(String(cookie.name)))
  : null;
if (!sessionCookie) {
  fail('notifications-expired-session: storage state has no moyu_session cookie', 1);
}

const out = resolve(String(values.out));
const repository = String(values.repository);
const conversation = String(values.conversation);
const sessionHash = createHash('sha256').update(sessionCookie.value).digest('hex');
mkdirSync(out, { recursive: true, mode: 0o700 });

let playwright;
try {
  playwright = await import('playwright');
} catch {
  fail('notifications-expired-session: playwright is not installed in this workspace', 2);
}

const record = {
  baseUrl: baseUrl.toString(),
  repository,
  conversation,
  startedAt: new Date().toISOString(),
  steps: [],
  failures: [],
  screenshots: [],
};
const step = (name, detail = {}) => {
  record.steps.push({ name, at: new Date().toISOString(), ...detail });
  process.stdout.write(`[step] ${name} ${JSON.stringify(detail)}\n`);
};

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
// The regression revokes this fixture session when it expires it. Restore it
// so a rerun starts from the same state, then reset the server counter so the
// virtual authenticator's first assertion is strictly greater.
await pool.query(
  "update sessions set revoked_at = null, expires_at = now() + interval '1 day' where token_hash = $1",
  [sessionHash],
);
await pool.query('update passkey_credentials set counter = 0 where credential_id = $1', [
  String(credentials[0].credentialId).replace(/=+$/, ''),
]);
const browser = await playwright.chromium.launch({
  headless: false,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const context = await browser.newContext({
    storageState,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    permissions: ['notifications'],
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  });
  await context.addInitScript(() => {
    globalThis.__moyuNotifyDebug = { attempts: [], delivered: [] };
    globalThis.__moyuPageInstance = window.crypto.randomUUID();
    // Simulate the mobile browser behaviour that motivated the fallback: the
    // page-level constructor throws, so delivery must use the worker.
    const realNotification = window.Notification;
    class MobileNotification {
      constructor() {
        throw new TypeError('Illegal constructor (simulated mobile browser)');
      }
      static get permission() {
        return realNotification ? realNotification.permission : 'default';
      }
      static requestPermission() {
        return Promise.resolve(MobileNotification.permission);
      }
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: MobileNotification,
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => record.failures.push(`pageerror: ${error.message}`));

  const shot = async (name) => {
    const path = `${out}/${name}.png`;
    await page.screenshot({ path, fullPage: true });
    record.screenshots.push(path);
  };

  const targetPattern = (url) => {
    const search = url.searchParams;
    return search.get('repo') === repository && search.get('conversation') === conversation;
  };

  async function waitConnected(page) {
    await page.getByText('实时连接', { exact: true }).waitFor({ timeout: 20_000 });
  }

  async function me() {
    return page.evaluate(() =>
      fetch('/api/v1/auth/me', { credentials: 'include' }).then(async (response) => ({
        status: response.status,
        body: response.ok ? await response.json() : null,
      })),
    );
  }

  async function requestEvent(text) {
    const deliveredBefore = await page.evaluate(
      () => globalThis.__moyuNotifyDebug?.delivered?.length ?? 0,
    );
    const sourceEventId = `m6c-d-expired-${Date.now()}`;
    const response = await fetch(`${baseUrl.origin}/api/internal/v1/runtime-events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callbackToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sourceEventId,
        type: 'channel.message',
        conversationId: conversation,
        ticketId: null,
        messageKind: 'question',
        text,
        at: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      fail(`notifications-expired-session: runtime callback failed (${response.status})`, 1);
    }
    await page.waitForFunction(
      (count) => (globalThis.__moyuNotifyDebug?.delivered?.length ?? 0) > count,
      deliveredBefore,
      { timeout: 20_000 },
    );
  }

  async function notificationData() {
    return page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const items = await registration.getNotifications();
      return (
        items
          .map((item) => ({ title: item.title, tag: item.tag, data: item.data }))
          .find((item) => item.data?.conversationId) ?? null
      );
    });
  }

  async function closeNotifications() {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      for (const item of await registration.getNotifications()) item.close();
    });
  }

  async function dispatchClick(data) {
    const workers = context.serviceWorkers();
    const worker = workers.find((item) => item.url().startsWith(baseUrl.origin)) ?? workers[0];
    if (!worker) fail('notifications-expired-session: notification worker is not available', 1);
    await worker.evaluate(async (payload) => {
      let waited;
      const event = new Event('notificationclick');
      Object.defineProperty(event, 'notification', {
        value: { data: payload, close() {} },
      });
      event.waitUntil = (promise) => {
        waited = promise;
      };
      self.dispatchEvent(event);
      await waited;
    }, data);
  }

  await page.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitConnected(page);
  const authenticated = await me();
  if (authenticated.status !== 200) {
    fail('notifications-expired-session: the storage state is not authenticated', 1);
  }
  await page.evaluate(
    ({ key }) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          mode: 'always',
          categories: { needs_reply: true, review: true, completed: true, failed: true },
        }),
      ),
    { key: `moyu.notify.settings.v1:${authenticated.body.data.owner.id}` },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitConnected(page);
  await page.waitForTimeout(1500);
  step('workbench-ready', { url: page.url() });

  // Positive path: a mounted workbench acknowledges the worker and routes in
  // place. The page instance marker must survive; a fallback navigation would
  // replace it.
  await requestEvent('同源工作台点击确认：这条应原地打开。');
  const inPlaceData = await notificationData();
  if (!inPlaceData) fail('notifications-expired-session: no in-place notification was created', 1);
  const markerBeforeClick = await page.evaluate(() => globalThis.__moyuPageInstance);
  await shot('click-in-place-before');
  // A person clicks after the event has settled; wait for the workbench to
  // finish its own event-time rendering so the acknowledgement is not racing a
  // busy main thread.
  await page.waitForTimeout(1200);
  await dispatchClick(inPlaceData.data);
  await page.waitForFunction(
    ({ repositoryId, conversationId }) => {
      const params = new URLSearchParams(location.search);
      return params.get('repo') === repositoryId && params.get('conversation') === conversationId;
    },
    { repositoryId: repository, conversationId: conversation },
    { timeout: 10_000 },
  );
  const markerAfterClick = await page.evaluate(() => globalThis.__moyuPageInstance);
  await shot('click-in-place-after');
  step('click-in-place', {
    url: page.url(),
    markerBeforeClick,
    markerAfterClick,
    markerSurvived: markerBeforeClick === markerAfterClick,
  });
  if (markerBeforeClick !== markerAfterClick) {
    fail('notifications-expired-session: the in-place click reloaded the workbench', 1);
  }
  await closeNotifications();
  const conversationTitle = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/conversations/${encodeURIComponent(id)}`, {
      credentials: 'include',
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.data?.conversation?.title ?? null;
  }, conversation);
  if (!conversationTitle) {
    fail('notifications-expired-session: the target conversation is not readable', 1);
  }

  // Start the expired-session path from the repository root, so the click's
  // fallback has to add the conversation to the address.
  await page.goto(`${baseUrl.origin}/?repo=${encodeURIComponent(repository)}`, {
    waitUntil: 'domcontentloaded',
  });
  await waitConnected(page);
  await page.waitForTimeout(800);

  // Expired-session path: create a notification, revoke the session, reload to
  // the login page, then click. The worker must not stop at the unconfirmed
  // login window; it must navigate it to the addressable target URL.
  await requestEvent('会话过期后的通知点击：登录后应回到这个会话。');
  const expiredData = await notificationData();
  if (!expiredData) fail('notifications-expired-session: no expired-session notification', 1);
  const revoked = await pool.query(
    'update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null returning id',
    [sessionHash],
  );
  if (revoked.rowCount !== 1) {
    fail('notifications-expired-session: could not revoke the fixture session', 1);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '使用 Passkey 登录' }).waitFor({ timeout: 15_000 });
  await shot('expired-login-before-click');
  step('expired-login-ready', { url: page.url() });

  await dispatchClick(expiredData.data);
  await page.waitForURL((url) => targetPattern(url), { timeout: 10_000 }).catch(() => null);
  if (!targetPattern(new URL(page.url()))) {
    const targetPage = context.pages().find((candidate) => {
      try {
        return targetPattern(new URL(candidate.url()));
      } catch {
        return false;
      }
    });
    if (!targetPage) {
      fail('notifications-expired-session: the click did not navigate a window to the target', 1);
    }
    await targetPage.waitForLoadState('domcontentloaded');
  }
  const loginPage =
    context.pages().find((candidate) => {
      try {
        return targetPattern(new URL(candidate.url()));
      } catch {
        return false;
      }
    }) ?? page;
  await loginPage.getByRole('heading', { name: '使用 Passkey 登录' }).waitFor({ timeout: 10_000 });
  if (!targetPattern(new URL(loginPage.url()))) {
    fail('notifications-expired-session: the login window did not receive the target URL', 1);
  }
  await loginPage.screenshot({ path: `${out}/expired-login-after-navigate.png`, fullPage: true });
  record.screenshots.push(`${out}/expired-login-after-navigate.png`);
  step('expired-login-after-navigate', { url: loginPage.url() });

  const cdp = await context.newCDPSession(loginPage);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  for (const credential of credentials) {
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  await loginPage.getByRole('button', { name: '使用 Passkey 登录' }).click();
  await loginPage.waitForFunction(
    (title) => {
      const nav = document.querySelector('nav[aria-label="当前位置"]');
      return Boolean(nav && title && nav.textContent?.includes(title));
    },
    conversationTitle,
    { timeout: 30_000 },
  );
  const breadcrumb = await loginPage.locator('nav[aria-label="当前位置"]').innerText();
  await loginPage.screenshot({ path: `${out}/expired-after-login-target.png`, fullPage: true });
  record.screenshots.push(`${out}/expired-after-login-target.png`);
  step('expired-after-login', { url: loginPage.url(), breadcrumb });
  if (!targetPattern(new URL(loginPage.url()))) {
    fail('notifications-expired-session: sign-in did not preserve the target address', 1);
  }
  if (!breadcrumb.includes(conversationTitle)) {
    fail('notifications-expired-session: sign-in did not open the target conversation', 1);
  }

  record.ok = record.failures.length === 0;
  record.finishedAt = new Date().toISOString();
  writeJson(`${out}/expired-session-result.json`, record);
  process.stdout.write(
    `${JSON.stringify({ ok: record.ok, steps: record.steps.length, failures: record.failures }, null, 2)}\n`,
  );
  if (!record.ok) process.exitCode = 1;
} catch (error) {
  record.ok = false;
  record.failures.push(error instanceof Error ? error.message : String(error));
  record.finishedAt = new Date().toISOString();
  writeJson(`${out}/expired-session-error.json`, record);
  throw error;
} finally {
  await browser.close();
  await pool.end();
}
