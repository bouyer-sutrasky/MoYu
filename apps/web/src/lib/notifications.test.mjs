import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliverWebNotification,
  ensureNotificationServiceWorker,
  notificationPermission,
} from './notifications.ts';

const REPOSITORY = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEDUPE_KEY = 'moyu.notify.dedupe.v1';

const repositories = [{ id: REPOSITORY, fullName: 'Bouyer12/alpha-fixture' }];
const settings = {
  mode: 'always',
  categories: { needs_reply: true, review: true, completed: true, failed: true },
};

function memoryStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

let localStorage = memoryStorage();

function installWindow() {
  globalThis.window = {
    localStorage,
    focus() {},
  };
  globalThis.document = { visibilityState: 'hidden' };
}

function installNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value });
}

function installNotification(value) {
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value });
}

function event(id, overrides = {}) {
  return {
    id,
    seq: '1',
    repositoryId: REPOSITORY,
    conversationId: CONVERSATION,
    occurredAt: new Date().toISOString(),
    type: 'task.state_changed',
    data: { task: { id: 'task-1', state: 'completed' } },
    ...overrides,
  };
}

function debug() {
  return globalThis.__moyuNotifyDebug;
}

function reset() {
  localStorage = memoryStorage();
  globalThis.__moyuNotifyDebug = { attempts: [], delivered: [] };
  installWindow();
  installNavigator({ locks: undefined });
}

test('an unsupported browser reports unsupported before any delivery attempt', async () => {
  reset();
  installNotification(undefined);
  assert.equal(notificationPermission(), 'unsupported');
  const result = await deliverWebNotification({
    event: event('e-unsupported'),
    settings,
    repositories,
    onOpen() {},
  });
  assert.deepEqual(result, { delivered: false, reason: 'unsupported' });
});

test('non-alerting events, disabled settings, background-only and denied permission stop early', async () => {
  reset();
  class Granted {
    static permission = 'granted';
    constructor() {
      throw new Error('must not construct');
    }
  }
  installNotification(Granted);

  const noCategory = await deliverWebNotification({
    event: event('e-progress', { type: 'task.progress', data: { text: 'working', at: '' } }),
    settings,
    repositories,
    onOpen() {},
  });
  assert.equal(noCategory.reason, 'no-category');

  const disabled = await deliverWebNotification({
    event: event('e-disabled'),
    settings: { ...settings, mode: 'off' },
    repositories,
    onOpen() {},
  });
  assert.equal(disabled.reason, 'disabled');

  globalThis.document.visibilityState = 'visible';
  const backgroundOnly = await deliverWebNotification({
    event: event('e-visible'),
    settings: { ...settings, mode: 'background' },
    repositories,
    onOpen() {},
  });
  assert.equal(backgroundOnly.reason, 'background-only');

  class Denied {
    static permission = 'denied';
    constructor() {
      throw new Error('must not construct');
    }
  }
  installNotification(Denied);
  const denied = await deliverWebNotification({
    event: event('e-denied'),
    settings,
    repositories,
    onOpen() {},
  });
  assert.equal(denied.reason, 'no-permission');
  assert.equal(debug().delivered.length, 0);
});

test('a page-level notification routes its click and claims the event once', async () => {
  reset();
  const created = [];
  const opened = [];
  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) {
      this.title = title;
      this.options = options;
      created.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  installNotification(FakeNotification);

  const first = await deliverWebNotification({
    event: event('e-window'),
    settings,
    repositories,
    onOpen: (target) => opened.push(target),
  });
  assert.deepEqual(first, { delivered: true, reason: 'delivered' });
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Bouyer12/alpha-fixture · 已完成');
  assert.equal(created[0].options.body, '任务已完成');
  assert.deepEqual(created[0].options.data, {
    conversationId: CONVERSATION,
    repositoryId: REPOSITORY,
    eventId: 'e-window',
  });
  assert.equal(debug().delivered[0].via, 'window');

  created[0].onclick();
  assert.deepEqual(opened, [{ conversationId: CONVERSATION, repositoryId: REPOSITORY }]);
  assert.equal(created[0].closed, true);

  const duplicate = await deliverWebNotification({
    event: event('e-window'),
    settings,
    repositories,
    onOpen() {},
  });
  assert.deepEqual(duplicate, { delivered: false, reason: 'duplicate' });
  assert.equal(created.length, 1);
});

test('a mobile constructor failure falls back to the Service Worker and retries a rejected display', async () => {
  reset();
  const shown = [];
  let registrations = 0;
  let failNext = true;
  const registration = {
    scope: 'https://moyu.example/',
    active: {},
    async showNotification(title, options) {
      if (failNext) {
        failNext = false;
        throw new Error('worker unavailable');
      }
      shown.push({ title, options });
    },
  };
  installNavigator({
    locks: undefined,
    serviceWorker: {
      async register(url, options) {
        registrations += 1;
        assert.equal(url, '/sw.js');
        assert.deepEqual(options, { scope: '/' });
        return registration;
      },
      ready: Promise.resolve(registration),
    },
  });
  class RejectedConstructor {
    static permission = 'granted';
    constructor() {
      throw new TypeError('Illegal constructor');
    }
  }
  installNotification(RejectedConstructor);

  const failed = await deliverWebNotification({
    event: event('e-worker'),
    settings,
    repositories,
    onOpen() {},
  });
  assert.deepEqual(failed, { delivered: false, reason: 'error' });
  assert.equal(debug().attempts.at(-1).result, 'error');
  // The rejected display must not suppress the durable event for seven days.
  assert.equal(JSON.parse(localStorage.getItem(DEDUPE_KEY))['e-worker'], undefined);

  const retried = await deliverWebNotification({
    event: event('e-worker'),
    settings,
    repositories,
    onOpen() {},
  });
  assert.deepEqual(retried, { delivered: true, reason: 'delivered' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Bouyer12/alpha-fixture · 已完成');
  assert.deepEqual(shown[0].options.data, {
    conversationId: CONVERSATION,
    repositoryId: REPOSITORY,
    eventId: 'e-worker',
  });
  assert.equal(debug().delivered[0].via, 'service-worker');
  assert.equal(debug().attempts.at(-1).via, 'service-worker');

  assert.equal(await ensureNotificationServiceWorker(), registration);
  assert.equal(await ensureNotificationServiceWorker(), registration);
  assert.equal(registrations, 1);
});
