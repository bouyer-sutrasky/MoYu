import type { ActivityCategory, WorkspaceEvent } from '@moyu/contracts';

import {
  ACTIVITY_CATEGORY_LABELS,
  categoryForEvent,
  summaryForEvent,
  type NotificationSettings,
} from './activity.ts';

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

/** Which browser API actually displayed the notification. */
export type NotificationDeliveryPath = 'window' | 'service-worker';

export interface NotificationTarget {
  conversationId: string;
  repositoryId: string;
}

export interface DeliveryResult {
  delivered: boolean;
  reason:
    | 'delivered'
    | 'no-category'
    | 'disabled'
    | 'background-only'
    | 'no-permission'
    | 'duplicate'
    | 'unsupported'
    | 'error';
}

const DEDUPE_KEY = 'moyu.notify.dedupe.v1';
const DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEDUPE_CAP = 1000;
const LOCK_NAME = 'moyu.notify.dedupe.lock.v1';
const NOTIFICATION_SW_URL = '/sw.js';
const NOTIFICATION_SW_TIMEOUT_MS = 10_000;
const DEBUG_CAP = 100;

interface NotificationDebug {
  attempts?: Array<{
    id: string;
    category: ActivityCategory;
    result: DeliveryResult['reason'];
    via?: NotificationDeliveryPath;
  }>;
  delivered?: Array<{
    id: string;
    title: string;
    body: string;
    tag: string;
    via: NotificationDeliveryPath;
  }>;
}

/**
 * Delivery diagnostics live in memory only. They are bounded so a long-lived
 * page cannot accumulate one entry per event, and they never include tokens or
 * anything other than the notification text the owner could already see.
 */
function debug(): NotificationDebug {
  const scope = globalThis as { __moyuNotifyDebug?: NotificationDebug };
  scope.__moyuNotifyDebug ??= { attempts: [], delivered: [] };
  return scope.__moyuNotifyDebug;
}

function pushBounded<T>(list: T[] | undefined, value: T): void {
  if (!Array.isArray(list)) return;
  list.push(value);
  if (list.length > DEBUG_CAP) list.splice(0, list.length - DEBUG_CAP);
}

let notificationWorker: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Registers the notification worker and waits for it to activate. Mobile
 * Chrome rejects the page-level constructor, so the worker must already be
 * active before the first event reaches `showNotification`. A failed
 * registration is not cached: a later event retries after a transient failure.
 */
export function ensureNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (notificationWorker) return notificationWorker;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  notificationWorker = (async () => {
    try {
      await navigator.serviceWorker.register(NOTIFICATION_SW_URL, { scope: '/' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), NOTIFICATION_SW_TIMEOUT_MS);
      });
      let registration: ServiceWorkerRegistration | null = null;
      try {
        registration = await Promise.race([navigator.serviceWorker.ready, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      // An activation timeout is retried by a later event rather than pinning
      // this page to the failure for its whole lifetime.
      if (!registration) notificationWorker = null;
      return registration;
    } catch {
      notificationWorker = null;
      return null;
    }
  })();
  return notificationWorker;
}

export function notificationPermission(): NotificationPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * Requests permission only from an explicit owner action. Once the browser has
 * answered, asking again has no effect, so denied/default states are handled by
 * the settings text instead of repeated prompts.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

function readDedupe(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(DEDUPE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

function writeDedupe(values: Record<string, number>): void {
  try {
    window.localStorage.setItem(DEDUPE_KEY, JSON.stringify(values));
  } catch {
    // In-memory delivery still works for this page; only cross-refresh dedupe
    // is lost when the browser refuses storage.
  }
}

function pruneDedupe(values: Record<string, number>): Record<string, number> {
  const cutoff = Date.now() - DEDUPE_TTL_MS;
  const kept = Object.entries(values)
    .filter(([, at]) => Number.isFinite(at) && at >= cutoff)
    .sort((left, right) => left[1] - right[1])
    .slice(-DEDUPE_CAP);
  return Object.fromEntries(kept);
}

/**
 * Claims one event id exactly once across tabs and refreshes. A Web Lock
 * serialises the read-check-write across tabs; the stored timestamp keeps the
 * claim across reloads. The event id (the persisted SSE id) is the dedupe key.
 */
async function claimEvent(eventId: string): Promise<boolean> {
  const claim = (): boolean => {
    const values = pruneDedupe(readDedupe());
    if (typeof values[eventId] === 'number') {
      return false;
    }
    values[eventId] = Date.now();
    writeDedupe(pruneDedupe(values));
    return true;
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && typeof locks.request === 'function') {
    try {
      return await locks.request(LOCK_NAME, claim);
    } catch {
      return claim();
    }
  }
  return claim();
}

/**
 * Releases a claim whose display failed in both paths. Without this, a single
 * transient failure would suppress the same durable event for seven days, even
 * after a reconnect or reload.
 */
async function releaseEvent(eventId: string): Promise<void> {
  const release = (): void => {
    const values = readDedupe();
    if (typeof values[eventId] !== 'number') return;
    delete values[eventId];
    writeDedupe(values);
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks && typeof locks.request === 'function') {
    try {
      await locks.request(LOCK_NAME, release);
      return;
    } catch {
      release();
      return;
    }
  }
  release();
}

function permitted(settings: NotificationSettings): boolean {
  return (
    settings.mode !== 'off' &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  );
}

function titleFor(
  event: WorkspaceEvent,
  category: ActivityCategory,
  repositories: Array<{ id: string; fullName: string }>,
): string {
  const repository = repositories.find((item) => item.id === event.repositoryId);
  return `${repository?.fullName ?? 'MoYu'} · ${ACTIVITY_CATEGORY_LABELS[category]}`;
}

/**
 * Delivers one real-time event as a browser notification. The event must come
 * from the SSE handler; this function performs no polling and never fetches the
 * event list. The in-app unread badge is updated by the caller regardless of the
 * permission or dedupe outcome.
 */
export async function deliverWebNotification(input: {
  event: WorkspaceEvent;
  settings: NotificationSettings;
  repositories: Array<{ id: string; fullName: string }>;
  onOpen: (target: NotificationTarget) => void;
}): Promise<DeliveryResult> {
  const category = categoryForEvent(input.event);
  const record = (
    result: DeliveryResult['reason'],
    via?: NotificationDeliveryPath,
  ): DeliveryResult => {
    pushBounded(debug().attempts, {
      id: input.event.id,
      category: category ?? 'needs_reply',
      result,
      ...(via ? { via } : {}),
    });
    return { delivered: result === 'delivered', reason: result };
  };

  if (!category) return record('no-category');
  if (input.settings.mode === 'off' || !input.settings.categories[category]) {
    return record('disabled');
  }
  if (typeof Notification === 'undefined') return record('unsupported');
  if (input.settings.mode === 'background' && document.visibilityState === 'visible') {
    return record('background-only');
  }
  if (!permitted(input.settings)) return record('no-permission');
  if (!(await claimEvent(input.event.id))) return record('duplicate');

  const title = titleFor(input.event, category, input.repositories);
  const body = summaryForEvent(input.event) || '任务状态已更新';
  const tag = `moyu:${input.event.id}`;
  const data = {
    conversationId: input.event.conversationId,
    repositoryId: input.event.repositoryId,
    eventId: input.event.id,
  };

  // Desktop browsers construct a page-level notification and route the click
  // without leaving the document.
  try {
    const notification = new Notification(title, { body, tag, data });
    notification.onclick = () => {
      window.focus();
      if (input.event.conversationId && input.event.repositoryId) {
        input.onOpen({
          conversationId: input.event.conversationId,
          repositoryId: input.event.repositoryId,
        });
      }
      notification.close();
    };
    pushBounded(debug().delivered, { id: input.event.id, title, body, tag, via: 'window' });
    return record('delivered', 'window');
  } catch {
    // Nearly every mobile browser throws from this constructor; fall through to
    // the persistent notification path instead of reporting a silent failure.
  }

  const registration = await ensureNotificationServiceWorker();
  if (registration) {
    try {
      await registration.showNotification(title, { body, tag, data });
      pushBounded(debug().delivered, {
        id: input.event.id,
        title,
        body,
        tag,
        via: 'service-worker',
      });
      return record('delivered', 'service-worker');
    } catch {
      // The worker can be evicted or reject a malformed payload; release the
      // claim so a replayed durable event can try again.
    }
  }

  await releaseEvent(input.event.id);
  return record('error');
}
