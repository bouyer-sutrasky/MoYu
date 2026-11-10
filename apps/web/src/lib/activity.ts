import type { ActivityCategory, WorkspaceEvent } from '@moyu/contracts';

import { ACTIVITY_CATEGORY_LABELS } from '@moyu/contracts';

export { ACTIVITY_CATEGORY_LABELS };
export type { ActivityCategory };

export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  'needs_reply',
  'review',
  'completed',
  'failed',
];

/** Maps one SSE event to the activity category it would alert for, if any. */
export function categoryForEvent(event: WorkspaceEvent): ActivityCategory | null {
  if (event.type === 'task.question') {
    return 'needs_reply';
  }
  if (event.type !== 'task.state_changed') {
    return null;
  }
  switch (event.data.task.state) {
    case 'waiting_input':
      return 'needs_reply';
    case 'awaiting_review':
      return 'review';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'blocked':
    case 'closed_unmerged':
      return 'failed';
    default:
      return null;
  }
}

/** A short, human-readable summary of the alert; never the raw event payload. */
export function summaryForEvent(event: WorkspaceEvent): string {
  if (event.type === 'task.question') {
    const question = event.data.task.question?.trim();
    return question ? question.slice(0, 180) : '执行器正在等待你的回复';
  }
  if (event.type !== 'task.state_changed') {
    return '';
  }
  switch (event.data.task.state) {
    case 'waiting_input':
      return '任务等待你的回复';
    case 'awaiting_review':
      return '任务已提交，等待审阅';
    case 'completed':
      return '任务已完成';
    case 'closed_unmerged':
      return 'PR 已关闭但未合并';
    case 'blocked':
      return '任务受阻，需要人工处理';
    case 'failed':
      return '任务执行失败';
    default:
      return '任务状态已更新';
  }
}

export interface NotificationSettings {
  mode: 'off' | 'background' | 'always';
  categories: Record<ActivityCategory, boolean>;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  mode: 'background',
  categories: {
    needs_reply: true,
    review: true,
    completed: true,
    failed: true,
  },
};

const settingsKey = (ownerId: string) => `moyu.notify.settings.v1:${ownerId}`;
const readKey = (ownerId: string) => `moyu.activity.read.v1:${ownerId}`;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadNotificationSettings(ownerId: string): NotificationSettings {
  const store = storage();
  if (!store) return DEFAULT_NOTIFICATION_SETTINGS;
  try {
    const raw = store.getItem(settingsKey(ownerId));
    if (!raw) return DEFAULT_NOTIFICATION_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
    return {
      mode:
        parsed.mode === 'off' || parsed.mode === 'always' || parsed.mode === 'background'
          ? parsed.mode
          : DEFAULT_NOTIFICATION_SETTINGS.mode,
      categories: {
        needs_reply: parsed.categories?.needs_reply !== false,
        review: parsed.categories?.review !== false,
        completed: parsed.categories?.completed !== false,
        failed: parsed.categories?.failed !== false,
      },
    };
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

export function saveNotificationSettings(ownerId: string, settings: NotificationSettings): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(settingsKey(ownerId), JSON.stringify(settings));
  } catch {
    // A browser that refuses storage keeps the in-memory selection for this page.
  }
}

const READ_CAP = 1000;

export function loadActivityReadIds(ownerId: string): Set<string> {
  const store = storage();
  if (!store) return new Set();
  try {
    const raw = store.getItem(readKey(ownerId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

export function markActivityRead(ownerId: string, ids: string[]): Set<string> {
  const store = storage();
  const next = loadActivityReadIds(ownerId);
  for (const id of ids) {
    next.add(id);
  }
  const bounded = [...next];
  const kept = bounded.slice(Math.max(0, bounded.length - READ_CAP));
  if (store) {
    try {
      store.setItem(readKey(ownerId), JSON.stringify(kept));
    } catch {
      // Keep the returned set even when persistence is unavailable.
    }
  }
  return new Set(kept);
}
