/*
 * MoYu notification service worker.
 *
 * The page keeps the SSE connection and the notification settings. Mobile
 * browsers reject the page-level `new Notification(...)` constructor, so the
 * page calls `registration.showNotification(...)` instead; this worker owns the
 * click that follows. It never caches the app shell and never subscribes to
 * push: notifications still require the page to be open and to have received
 * the event.
 */

const CLICK_MESSAGE = 'moyu:notification-open';
const CONSUME_TIMEOUT_MS = 600;

self.addEventListener('install', () => {
  // A waiting worker would delay the first notification fallback; the page
  // and worker share no caches, so activating immediately is safe.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Builds the addressable conversation URL from the notification payload. */
function notificationUrl(data) {
  const url = new URL(self.registration.scope);
  if (data && typeof data.repositoryId === 'string' && data.repositoryId) {
    url.searchParams.set('repo', data.repositoryId);
  }
  if (data && typeof data.conversationId === 'string' && data.conversationId) {
    url.searchParams.set('conversation', data.conversationId);
  }
  return url.href;
}

function clickTarget(data) {
  return {
    type: CLICK_MESSAGE,
    repositoryId: data && typeof data.repositoryId === 'string' ? data.repositoryId : null,
    conversationId: data && typeof data.conversationId === 'string' ? data.conversationId : null,
  };
}

/**
 * Asks one window to route and waits for the page to confirm it has a mounted
 * consumer. A login page (or any window that is not the workbench) is still a
 * same-origin client, but its postMessage would be dropped: without this
 * acknowledgement the click would focus the login page and leave no target in
 * the address, so a later sign-in could not restore the conversation.
 */
function askClient(client, data) {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') {
      resolve(false);
      return;
    }
    const channel = new MessageChannel();
    let settled = false;
    const finish = (consumed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(consumed);
    };
    const timer = setTimeout(() => finish(false), CONSUME_TIMEOUT_MS);
    channel.port1.onmessage = () => finish(true);
    try {
      // Post before focusing: window activation can be slow on a busy desktop,
      // and the acknowledgement must not wait behind it. The page focuses
      // itself when it accepts the route.
      client.postMessage(clickTarget(data), [channel.port2]);
      void client.focus().catch(() => {});
    } catch {
      finish(false);
    }
  });
}

/**
 * Routes a click to a window that confirms consumption, otherwise navigates
 * the focused window to the addressable URL so sign-in can restore the target.
 * A clientless click opens the same URL in a new window.
 */
async function openNotificationTarget(data) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const sameOrigin = windows.filter((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  const target =
    sameOrigin.find((client) => client.focused) ??
    sameOrigin.find((client) => client.visibilityState === 'visible') ??
    sameOrigin[0];
  const ordered = target
    ? [target, ...sameOrigin.filter((client) => client !== target)]
    : sameOrigin;
  for (const client of ordered) {
    if (await askClient(client, data)) return;
  }

  const url = notificationUrl(data);
  if (target) {
    try {
      await target.navigate(url);
      return;
    } catch {
      // The window can close between matchAll and navigate; open a fresh one.
    }
  }
  if (typeof self.clients.openWindow === 'function') {
    await self.clients.openWindow(url);
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data));
});
