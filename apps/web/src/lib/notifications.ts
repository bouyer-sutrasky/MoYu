import type { ActivityCategory, WorkspaceEvent } from '@moyu/contracts';

import {
  ACTIVITY_CATEGORY_LABELS,
  categoryForEvent,
  summaryForEvent,
  type NotificationSettings,
} from './activity';

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

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

interface NotificationDebug {
  attempts?: Array<{ id: string; category: ActivityCategory; result: DeliveryResult['reason'] }>;
  delivered?: Array<{ id: string; title: string; body: string; tag: string }>;
}

function debug(): NotificationDebug | null {
  return (globalThis as { __moyuNotifyDebug?: NotificationDebug }).__moyuNotifyDebug ?? null;
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
  const record = (result: DeliveryResult['reason']) => {
    const hooks = debug();
    hooks?.attempts?.push({ id: input.event.id, category: category ?? 'needs_reply', result });
    return { delivered: result === 'delivered', reason: result } satisfies DeliveryResult;
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
  try {
    const notification = new Notification(title, {
      body,
      tag: `moyu:${input.event.id}`,
      data: {
        conversationId: input.event.conversationId,
        repositoryId: input.event.repositoryId,
      },
    });
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
    debug()?.delivered?.push({
      id: input.event.id,
      title,
      body,
      tag: `moyu:${input.event.id}`,
    });
    return record('delivered');
  } catch {
    return record('error');
  }
}
