#!/usr/bin/env node
/**
 * M6-C D: browser acceptance for the mobile notification fallback.
 *
 * It drives a real app + API + PostgreSQL event stream in a headed Chromium
 * session. The Notification constructor is replaced with the behaviour mobile
 * browsers actually have (it throws) and permission-dependence is simulated per
 * mode; the event itself is a real `channel.message` posted through the runtime
 * callback API, not a mocked SSE frame.
 *
 * This is NOT real-device evidence. Android Chrome and iOS Safari still need the
 * owner's devices; see docs/M6-C-D-NOTIFICATIONS.md.
 *
 * Usage (headed browser needs DISPLAY, for example Xvfb :99):
 *   M6C_RUNTIME_CALLBACK_TOKEN=... node scripts/m6c/notifications-browser.mjs \
 *     --base-url http://127.0.0.1:3102 \
 *     --storage-state /tmp/storage.json \
 *     --repository <uuid> --conversation <uuid> \
 *     --label after --expect delivered --out /tmp/evidence
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { fail, parseArgs, printHelpAndExit, writeJson } from './lib.mjs';

const HELP = [
  '--base-url <url>           MoYu origin (loopback HTTP or HTTPS)',
  '--storage-state <file>     Playwright storage-state JSON with a logged-in cookie (required)',
  '--repository <uuid>        repository that owns the target conversation (required)',
  '--conversation <uuid>      target conversation id (required)',
  '--out <dir>                evidence directory (required)',
  '--label <name>             evidence prefix, for example before/after (default: run)',
  '--mode <mobile|denied|unsupported>  simulated browser capability (default: mobile)',
  '--expect <delivered|error|no-permission|unsupported>  expected notification result',
  '--event-text <text>        question text posted through the runtime callback',
  '--allow-production         allow https://moyu.sutrasky.com',
  '--help                     show this help without launching a browser',
];

const { values } = parseArgs(process.argv.slice(2));
if (values.help) {
  printHelpAndExit('Run the M6-C D mobile notification browser scenarios', HELP, [
    'M6C_RUNTIME_CALLBACK_TOKEN=... node scripts/m6c/notifications-browser.mjs --base-url http://127.0.0.1:3102 --storage-state /tmp/storage.json --repository <uuid> --conversation <uuid> --label after --expect delivered --out /tmp/evidence',
  ]);
}
for (const key of ['base-url', 'storage-state', 'repository', 'conversation', 'out']) {
  if (!values[key]) fail(`notifications-browser: --${key} is required`, 2);
}
const baseUrl = new URL(String(values['base-url']));
if (!['http:', 'https:'].includes(baseUrl.protocol)) {
  fail('notifications-browser: base URL must be HTTP(S)', 2);
}
if (baseUrl.hostname === 'moyu.sutrasky.com' && values['allow-production'] !== true) {
  fail('notifications-browser: production origin needs --allow-production', 2);
}
if (
  baseUrl.protocol === 'http:' &&
  !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(baseUrl.hostname)
) {
  fail('notifications-browser: plain HTTP is allowed only on loopback', 2);
}
if (!process.env.DISPLAY && process.env.WAYLAND_DISPLAY === undefined) {
  fail('notifications-browser: a headed browser needs DISPLAY (for example Xvfb :99)', 2);
}

const storageState = resolve(String(values['storage-state']));
const out = resolve(String(values.out));
const repository = String(values.repository);
const conversation = String(values.conversation);
const label = String(values.label ?? 'run');
const mode = String(values.mode ?? 'mobile');
const expect =
  String(values.expect ?? '') ||
  (mode === 'denied' ? 'no-permission' : mode === 'unsupported' ? 'unsupported' : 'delivered');
const eventText = String(values['event-text'] ?? '真机通知复测：请确认是否继续。');
const callbackToken = process.env.M6C_RUNTIME_CALLBACK_TOKEN ?? values['callback-token'];
if (!callbackToken) {
  fail('notifications-browser: set M6C_RUNTIME_CALLBACK_TOKEN to post the real runtime event', 2);
}
if (!['mobile', 'denied', 'unsupported'].includes(mode)) {
  fail('notifications-browser: --mode must be mobile, denied or unsupported', 2);
}
if (!['delivered', 'error', 'no-permission', 'unsupported'].includes(expect)) {
  fail('notifications-browser: --expect is not a supported result', 2);
}

mkdirSync(out, { recursive: true, mode: 0o700 });

let playwright;
try {
  playwright = await import('playwright');
} catch {
  fail('notifications-browser: playwright is not installed in this workspace', 2);
}

const record = {
  baseUrl: baseUrl.toString(),
  label,
  mode,
  expect,
  startedAt: new Date().toISOString(),
  steps: [],
  failures: [],
  screenshots: [],
};
const step = (name, detail = {}) => {
  record.steps.push({ name, at: new Date().toISOString(), ...detail });
  process.stdout.write(`[step] ${name} ${JSON.stringify(detail)}\n`);
};

async function readState(page) {
  return page.evaluate(async () => {
    const debug = globalThis.__moyuNotifyDebug ?? null;
    const test = globalThis.__moyuNotificationTest ?? null;
    let registrations = [];
    try {
      registrations = await navigator.serviceWorker.getRegistrations();
    } catch {
      registrations = [];
    }
    let notifications = [];
    if (registrations.length > 0) {
      try {
        notifications = (await registrations[0].getNotifications()).map((item) => ({
          title: item.title,
          body: item.body,
          tag: item.tag,
          data: item.data,
        }));
      } catch {
        notifications = [];
      }
    }
    return {
      url: location.href,
      permission: (() => {
        try {
          return Notification.permission;
        } catch {
          return 'undefined';
        }
      })(),
      debug,
      test,
      registrations: registrations.map((registration) => registration.scope),
      notifications,
      connection:
        [...document.querySelectorAll('span')]
          .map((span) => span.textContent?.trim() ?? '')
          .find((text) => ['实时连接', '重连中', '已断开'].includes(text)) ?? null,
    };
  });
}

async function waitConnected(page) {
  await page.getByText('实时连接', { exact: true }).waitFor({ timeout: 20_000 });
}

async function unreadCount(page) {
  const text = await page.locator('button[aria-label="打开活动中心"]').innerText();
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

async function stableUnread(page) {
  let previous = -1;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await unreadCount(page);
    if (current === previous) return current;
    previous = current;
    await page.waitForTimeout(250);
  }
  return previous;
}

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
  await context.addInitScript(
    ({ mode }) => {
      const state = {
        mode,
        constructorCalls: 0,
        shown: [],
        forcedPermission: mode === 'denied' ? 'denied' : null,
      };
      globalThis.__moyuNotificationTest = state;
      globalThis.__moyuNotifyDebug = { attempts: [], delivered: [] };
      const Real = globalThis.Notification;
      class TestNotification {
        constructor() {
          state.constructorCalls += 1;
          throw new TypeError('Illegal constructor (simulated mobile browser)');
        }
        static get permission() {
          return state.forcedPermission ?? (Real ? Real.permission : 'default');
        }
        static requestPermission() {
          return Promise.resolve(TestNotification.permission);
        }
      }
      Object.defineProperty(globalThis, 'Notification', {
        configurable: true,
        value: mode === 'unsupported' ? undefined : TestNotification,
      });
      const prototype = globalThis.ServiceWorkerRegistration?.prototype;
      if (prototype && typeof prototype.showNotification === 'function') {
        const original = prototype.showNotification;
        prototype.showNotification = function showNotification(title, options) {
          state.shown.push({ title, options });
          return original.call(this, title, options);
        };
      }
    },
    { mode },
  );

  const page = await context.newPage();
  page.on('pageerror', (error) => record.failures.push(`pageerror: ${error.message}`));

  const shot = async (name) => {
    const path = `${out}/${name}.png`;
    await page.screenshot({ path, fullPage: true });
    record.screenshots.push(path);
  };

  await page.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitConnected(page);
  const me = await page.evaluate(() =>
    fetch('/api/v1/auth/me', { credentials: 'include' }).then((response) => response.json()),
  );
  const ownerId = me?.data?.owner?.id;
  if (!ownerId) fail('notifications-browser: the storage state is not authenticated', 1);
  const conversationDetail = await page.evaluate(
    (id) =>
      fetch(`/api/v1/conversations/${encodeURIComponent(id)}`, { credentials: 'include' }).then(
        (response) => response.json(),
      ),
    conversation,
  );
  const conversationTitle = conversationDetail?.data?.conversation?.title ?? null;
  if (!conversationTitle) fail('notifications-browser: the target conversation is not readable', 1);
  step('authenticated', { owner: me.data.owner.displayName, conversationTitle });

  // The default mode is background-only; force "always" so a foreground event
  // still exercises the notification path. The visibility rule has its own
  // unit test.
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: `moyu.notify.settings.v1:${ownerId}`,
    value: {
      mode: 'always',
      categories: { needs_reply: true, review: true, completed: true, failed: true },
    },
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitConnected(page);
  await page.waitForTimeout(1500);
  const before = await readState(page);
  const unreadBefore = await stableUnread(page);
  step('page-ready', {
    url: before.url,
    permission: before.permission,
    registrations: before.registrations,
    unread: unreadBefore,
  });
  await shot(`${label}-home-mobile`);

  const sourceEventId = `m6c-d-${label}-${Date.now()}`;
  const callback = await fetch(`${baseUrl.origin}/api/internal/v1/runtime-events`, {
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
      text: eventText,
      at: new Date().toISOString(),
    }),
  });
  const callbackBody = await callback.json().catch(() => ({}));
  if (!callback.ok) {
    fail(
      `notifications-browser: runtime callback failed (${callback.status}): ${JSON.stringify(callbackBody)}`,
      1,
    );
  }
  step('runtime-event-posted', { sourceEventId, messageId: callbackBody?.data?.messageId ?? null });

  await page.waitForFunction(
    () => (globalThis.__moyuNotifyDebug?.attempts?.length ?? 0) > 0,
    undefined,
    { timeout: 20_000 },
  );
  const after = await readState(page);
  const unreadAfter = await unreadCount(page);
  const attempt = after.debug?.attempts?.at(-1) ?? null;
  const delivered = after.debug?.delivered ?? [];
  step('notification-attempt', {
    attempt,
    delivered,
    shown: after.test?.shown?.length ?? 0,
    notifications: after.notifications.length,
    unread: unreadAfter,
  });
  if (!attempt || attempt.result !== expect) {
    fail(
      `notifications-browser: expected ${expect}, got ${attempt?.result ?? 'no attempt'} (${JSON.stringify(attempt)})`,
      1,
    );
  }
  if (unreadAfter - unreadBefore !== 1) {
    fail(
      `notifications-browser: unread badge moved ${unreadBefore} -> ${unreadAfter}, expected +1`,
      1,
    );
  }

  const dialog = page.getByRole('dialog', { name: '活动中心' });
  await page.locator('button[aria-label="打开活动中心"]').click();
  await dialog.waitFor({ timeout: 10_000 });
  const activityText = await dialog.getByText(eventText, { exact: false }).count();
  await shot(`${label}-activity-${mode}`);
  step('activity-fallback', { activityText });
  if (activityText === 0) {
    fail('notifications-browser: the in-app activity dialog did not show the event', 1);
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

  if (expect === 'delivered') {
    if (!delivered.some((item) => item.via === 'service-worker')) {
      fail('notifications-browser: the delivery was not recorded through the Service Worker', 1);
    }
    if ((after.test?.constructorCalls ?? 0) !== 1) {
      fail('notifications-browser: the page-level constructor was not attempted exactly once', 1);
    }
    if ((after.test?.shown?.length ?? 0) !== 1) {
      fail('notifications-browser: showNotification was not called exactly once', 1);
    }
    if (after.notifications.length !== 1) {
      fail('notifications-browser: the persistent notification was not registered', 1);
    }
    const notification = after.notifications[0];
    if (
      notification.data?.repositoryId !== repository ||
      notification.data?.conversationId !== conversation
    ) {
      fail('notifications-browser: the notification payload lost its target', 1);
    }
    step('service-worker-notification', notification);

    // The page receives exactly the message the worker posts for a click. The
    // worker's own click/focus branch is covered by the Node VM tests.
    await page.evaluate(
      ({ repositoryId, conversationId }) => {
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'moyu:notification-open', repositoryId, conversationId },
          }),
        );
      },
      { repositoryId: repository, conversationId: conversation },
    );
    await page.waitForFunction(
      ({ repositoryId, conversationId }) => {
        const params = new URLSearchParams(location.search);
        return params.get('repo') === repositoryId && params.get('conversation') === conversationId;
      },
      { repositoryId: repository, conversationId: conversation },
      { timeout: 10_000 },
    );
    await page.waitForTimeout(1000);
    const breadcrumb = await page.locator('nav[aria-label="当前位置"]').innerText();
    await shot(`${label}-click-route-mobile`);
    step('notification-click-route', { url: page.url(), breadcrumb });
    if (!breadcrumb.includes(conversationTitle)) {
      fail(
        `notifications-browser: breadcrumb lost the conversation title (${JSON.stringify(breadcrumb)})`,
        1,
      );
    }

    // A click whose conversation is gone keeps the repository and shows the
    // existing Chinese fallback instead of a wrong empty conversation.
    const missing = '99999999-9999-4999-8999-999999999999';
    await page.evaluate(
      ({ repositoryId, conversationId }) => {
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'moyu:notification-open', repositoryId, conversationId },
          }),
        );
      },
      { repositoryId: repository, conversationId: missing },
    );
    await page.getByText('不存在或没有访问权限', { exact: false }).waitFor({ timeout: 10_000 });
    const invalidParams = await page.evaluate(() => location.search);
    await shot(`${label}-click-invalid-target-mobile`);
    step('notification-click-invalid-target', { search: invalidParams });
    if (invalidParams.includes(missing)) {
      fail('notifications-browser: a missing target stayed in the address', 1);
    }

    // Reload replays the durable event from seq 0. The localStorage claim must
    // suppress the duplicate while the in-app reminder stays present.
    const eventId = attempt.id;
    await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        for (const item of await registration.getNotifications()) item.close();
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitConnected(page);
    await page.waitForFunction(
      (id) =>
        globalThis.__moyuNotifyDebug?.attempts?.some(
          (entry) => entry.id === id && entry.result === 'duplicate',
        ),
      eventId,
      { timeout: 20_000 },
    );
    const replayed = await readState(page);
    await shot(`${label}-duplicate-after-reload-mobile`);
    step('duplicate-after-reload', {
      attempt: replayed.debug?.attempts?.at(-1) ?? null,
      shown: replayed.test?.shown?.length ?? 0,
      notifications: replayed.notifications.length,
    });
    if ((replayed.test?.shown?.length ?? 0) !== 0 || replayed.notifications.length !== 0) {
      fail('notifications-browser: a reload replay produced a second notification', 1);
    }

    // Reconnect after a network drop: the EventSource uses Last-Event-ID and
    // must not redeliver the already claimed event.
    const attemptsBeforeDrop = replayed.debug?.attempts?.length ?? 0;
    await context.setOffline(true);
    await page.waitForTimeout(1200);
    await context.setOffline(false);
    await waitConnected(page);
    await page.waitForTimeout(2500);
    const reconnected = await readState(page);
    await shot(`${label}-reconnect-mobile`);
    step('reconnect', {
      before: attemptsBeforeDrop,
      after: reconnected.debug?.attempts?.length ?? 0,
      shown: reconnected.test?.shown?.length ?? 0,
    });
    if ((reconnected.debug?.attempts?.length ?? 0) !== attemptsBeforeDrop) {
      fail('notifications-browser: reconnect replayed an already claimed event', 1);
    }
    if ((reconnected.test?.shown?.length ?? 0) !== 0) {
      fail('notifications-browser: reconnect produced another notification', 1);
    }

    await page.goto(
      `${baseUrl.origin}/?repo=${encodeURIComponent(repository)}&settings=notifications`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForTimeout(1000);
    await shot(`${label}-settings-mobile`);
  } else {
    if ((after.test?.shown?.length ?? 0) !== 0 || after.notifications.length !== 0) {
      fail('notifications-browser: a blocked notification was still displayed', 1);
    }
    if (expect === 'error' && (after.test?.constructorCalls ?? 0) < 1) {
      fail('notifications-browser: the page-level constructor was not exercised', 1);
    }
    await page.goto(
      `${baseUrl.origin}/?repo=${encodeURIComponent(repository)}&settings=notifications`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForTimeout(1000);
    await shot(`${label}-settings-${mode}`);
  }

  record.authenticated = true;
  record.ok = record.failures.length === 0;
  record.finishedAt = new Date().toISOString();
  writeJson(`${out}/${label}-${mode}-result.json`, record);
  process.stdout.write(
    `${JSON.stringify({ ok: record.ok, label, mode, expect, steps: record.steps.length, failures: record.failures }, null, 2)}\n`,
  );
  if (!record.ok) process.exitCode = 1;
} catch (error) {
  record.ok = false;
  record.failures.push(error instanceof Error ? error.message : String(error));
  record.finishedAt = new Date().toISOString();
  writeJson(`${out}/${label}-${mode}-error.json`, record);
  throw error;
} finally {
  await browser.close();
}
