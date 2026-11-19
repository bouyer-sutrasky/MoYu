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
 * Focuses an existing workbench window and asks it to route in place; only a
 * clientless click opens a new window at the same addressable URL. Routing in
 * place keeps the owner's drafts and open panels, and the page keeps its own
 * 403/404 fallback for a conversation that no longer exists.
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
  if (target) {
    try {
      await target.focus();
      target.postMessage(clickTarget(data));
      return;
    } catch {
      // The window can close between matchAll and focus; open a fresh one.
    }
  }
  if (typeof self.clients.openWindow === 'function') {
    await self.clients.openWindow(notificationUrl(data));
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data));
});
