import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://moyu.example/';

function worker(options = {}) {
  const listeners = new Map();
  const opened = [];
  const messages = [];
  const focusCalls = [];
  const navigations = [];
  const calls = { skipWaiting: 0, claim: 0 };
  const clients = (options.clients ?? []).map((client) => ({
    url: client.url ?? `${SCOPE}?repo=r0`,
    focused: client.focused ?? false,
    visibilityState: client.visibilityState ?? 'visible',
    async focus() {
      if (client.focusError) throw new Error('window closed');
      focusCalls.push(client.url ?? `${SCOPE}?repo=r0`);
    },
    postMessage(message, transfer) {
      messages.push(message);
      if (client.ack && Array.isArray(transfer)) {
        transfer[0]?.postMessage({ type: 'moyu:notification-consumed' });
      }
    },
    async navigate(url) {
      if (client.navigateError) throw new Error('window closed');
      navigations.push(url);
    },
  }));
  const self = {
    location: new URL(SCOPE),
    registration: { scope: SCOPE },
    clients: {
      async matchAll() {
        return clients;
      },
      async openWindow(url) {
        opened.push(url);
      },
      async claim() {
        calls.claim += 1;
      },
    },
    skipWaiting() {
      calls.skipWaiting += 1;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  vm.runInNewContext(source, { self, URL, MessageChannel, setTimeout, clearTimeout, console });
  return { listeners, opened, messages, focusCalls, navigations, calls };
}

function clickEvent(data) {
  let closed = 0;
  let waited;
  return {
    closed: () => closed,
    wait: () => waited,
    event: {
      notification: {
        close() {
          closed += 1;
        },
        data,
      },
      waitUntil(promise) {
        waited = promise;
      },
    },
  };
}

test('install takes over immediately and activate claims existing clients', async () => {
  const fake = worker();
  fake.listeners.get('install')();
  assert.equal(fake.calls.skipWaiting, 1);

  let waited;
  fake.listeners.get('activate')({
    waitUntil(promise) {
      waited = promise;
    },
  });
  await waited;
  assert.equal(fake.calls.claim, 1);
});

test('a click focuses a workbench window and routes in place', async () => {
  const fake = worker({
    clients: [
      { url: `${SCOPE}?repo=r0`, focused: false, visibilityState: 'hidden' },
      { url: `${SCOPE}?repo=r9`, focused: true, ack: true },
    ],
  });
  const click = clickEvent({ repositoryId: 'repo-a', conversationId: 'conv-a' });
  fake.listeners.get('notificationclick')(click.event);
  await click.wait();

  assert.equal(click.closed(), 1);
  assert.equal(fake.opened.length, 0);
  assert.deepEqual(fake.navigations, []);
  assert.deepEqual(fake.focusCalls, [`${SCOPE}?repo=r9`]);
  assert.equal(fake.messages.length, 1);
  assert.equal(fake.messages[0].type, 'moyu:notification-open');
  assert.equal(fake.messages[0].repositoryId, 'repo-a');
  assert.equal(fake.messages[0].conversationId, 'conv-a');
});

test('without a window it opens the addressable conversation URL', async () => {
  const fake = worker();
  const click = clickEvent({ repositoryId: 'repo-a', conversationId: 'conv-a' });
  fake.listeners.get('notificationclick')(click.event);
  await click.wait();

  assert.equal(click.closed(), 1);
  assert.deepEqual(fake.opened, [`${SCOPE}?repo=repo-a&conversation=conv-a`]);
  assert.equal(fake.messages.length, 0);
});

test('a payload without ids opens the workbench instead of a corrupt URL', async () => {
  const fake = worker();
  const click = clickEvent({});
  fake.listeners.get('notificationclick')(click.event);
  await click.wait();

  assert.deepEqual(fake.opened, [SCOPE]);
  assert.deepEqual(fake.messages, []);
});

test('a window that cannot focus is navigated to the target URL', async () => {
  const fake = worker({ clients: [{ focused: true, focusError: true }] });
  const click = clickEvent({ repositoryId: 'repo-a', conversationId: 'conv-a' });
  fake.listeners.get('notificationclick')(click.event);
  await click.wait();

  assert.equal(click.closed(), 1);
  assert.deepEqual(fake.navigations, [`${SCOPE}?repo=repo-a&conversation=conv-a`]);
  assert.deepEqual(fake.opened, []);
  assert.equal(fake.messages.length, 1);
});

test('an unconfirmed window, such as the login page, is navigated to the target URL', async () => {
  const fake = worker({ clients: [{ focused: true, ack: false }] });
  const click = clickEvent({ repositoryId: 'repo-a', conversationId: 'conv-a' });
  fake.listeners.get('notificationclick')(click.event);
  await click.wait();

  assert.equal(click.closed(), 1);
  assert.equal(fake.messages.length, 1);
  assert.deepEqual(fake.navigations, [`${SCOPE}?repo=repo-a&conversation=conv-a`]);
  assert.deepEqual(fake.opened, []);
});

test('a later confirmed workbench window consumes the click without navigation', async () => {
  const fake = worker({
    clients: [
      { url: `${SCOPE}login`, focused: true, ack: false },
      { url: `${SCOPE}?repo=r9`, focused: false, ack: true },
    ],
  });
  const click = clickEvent({ repositoryId: 'repo-a', conversationId: 'conv-a' });
  fake.listeners.get('notificationclick')(click.event);
  await click.wait();

  assert.equal(click.closed(), 1);
  assert.equal(fake.messages.length, 2);
  assert.deepEqual(fake.focusCalls, [`${SCOPE}login`, `${SCOPE}?repo=r9`]);
  assert.deepEqual(fake.navigations, []);
  assert.deepEqual(fake.opened, []);
});

test('a failed navigation falls back to opening a new window', async () => {
  const fake = worker({ clients: [{ focused: true, ack: false, navigateError: true }] });
  const click = clickEvent({ repositoryId: 'repo-a', conversationId: 'conv-a' });
  fake.listeners.get('notificationclick')(click.event);
  await click.wait();

  assert.deepEqual(fake.navigations, []);
  assert.deepEqual(fake.opened, [`${SCOPE}?repo=repo-a&conversation=conv-a`]);
});
