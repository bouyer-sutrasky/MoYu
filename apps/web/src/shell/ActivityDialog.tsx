import { useCallback, useEffect, useState } from 'react';

import {
  ACTIVITY_CATEGORY_LABELS,
  type ActivityCategory,
  type ActivityData,
  type ActivityItem,
  type ActivityRunningItem,
} from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { ACTIVITY_CATEGORIES, loadActivityReadIds, markActivityRead } from '../lib/activity';
import { describeApiError } from '../lib/errors';
import { formatUpdatedAt, taskStateLabel } from '../lib/format';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import styles from './ActivityDialog.module.css';

interface ActivityDialogProps {
  ownerId: string;
  onClose: () => void;
  onOpenConversation: (target: { conversationId: string; repositoryId: string }) => void;
  onUnreadChange: (count: number) => void;
  onSessionLost: () => void;
}

type Filter = 'all' | ActivityCategory;

export function ActivityDialog({
  ownerId,
  onClose,
  onOpenConversation,
  onUnreadChange,
  onSessionLost,
}: ActivityDialogProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<ActivityItem[]>([]);
  const [running, setRunning] = useState<ActivityRunningItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [moreStatus, setMoreStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [filter, setFilter] = useState<Filter>('all');
  const [readIds, setReadIds] = useState<Set<string>>(() => loadActivityReadIds(ownerId));
  const [marking, setMarking] = useState(false);

  const unread = notifications.filter((item) => !readIds.has(item.id)).length;

  useEffect(() => {
    onUnreadChange(unread);
  }, [unread, onUnreadChange]);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const result: ActivityData = await api.activity({ limit: 50 });
      setNotifications(result.notifications);
      setRunning(result.running);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
      setStatus('ready');
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setStatus('error');
      setError(describeApiError(caught));
    }
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor || moreStatus === 'loading') return;
    setMoreStatus('loading');
    try {
      const result = await api.activity({ beforeSeq: nextCursor, limit: 50 });
      setNotifications((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const item of result.notifications) byId.set(item.id, item);
        return [...byId.values()];
      });
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
      setMoreStatus('idle');
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setMoreStatus('error');
    }
  }

  function markAllRead() {
    setMarking(true);
    try {
      const next = markActivityRead(
        ownerId,
        notifications.map((item) => item.id),
      );
      setReadIds(next);
    } finally {
      setMarking(false);
    }
  }

  function openItem(item: ActivityItem) {
    markActivityRead(ownerId, [item.id]);
    onOpenConversation({ conversationId: item.conversationId, repositoryId: item.repositoryId });
    onClose();
  }

  function openRunning(item: ActivityRunningItem) {
    onOpenConversation({ conversationId: item.conversationId, repositoryId: item.repositoryId });
    onClose();
  }

  const visible =
    filter === 'all' ? notifications : notifications.filter((item) => item.category === filter);

  return (
    <Modal
      title="活动中心"
      description="持久事件流产生的未读提醒；点击任一条可定位到对应会话。网页关闭后不再推送，重新打开后在此补看。"
      onClose={onClose}
      wide
    >
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <div className={styles.filters} role="group" aria-label="活动分类">
            <button
              type="button"
              className={filter === 'all' ? styles.filterActive : styles.filterButton}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              全部
              <span className={styles.filterCount}>{notifications.length}</span>
            </button>
            {ACTIVITY_CATEGORIES.map((category) => {
              const count = notifications.filter((item) => item.category === category).length;
              return (
                <button
                  key={category}
                  type="button"
                  className={filter === category ? styles.filterActive : styles.filterButton}
                  aria-pressed={filter === category}
                  onClick={() => setFilter(category)}
                >
                  {ACTIVITY_CATEGORY_LABELS[category]}
                  <span className={styles.filterCount}>{count}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={markAllRead}
            disabled={marking || unread === 0}
          >
            全部标为已读{unread > 0 ? `（${unread}）` : ''}
          </button>
        </div>

        {status === 'loading' ? (
          <p className={styles.muted}>正在读取持久活动记录…</p>
        ) : status === 'error' ? (
          <div className={styles.errorBox} role="alert">
            <p>{error ?? '活动记录不可用'}</p>
            <button type="button" className={styles.secondaryButton} onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : (
          <>
            {running.length > 0 ? (
              <section className={styles.section} aria-labelledby="running-heading">
                <h3 id="running-heading">正在执行</h3>
                <ul className={styles.list}>
                  {running.map((item) => (
                    <li key={item.taskId}>
                      <button
                        type="button"
                        className={styles.runningItem}
                        onClick={() => openRunning(item)}
                      >
                        <span className={styles.dotRunning} aria-hidden="true" />
                        <span className={styles.itemMain}>
                          <strong>{item.title ?? '未命名任务'}</strong>
                          <span>
                            {item.repositoryName} · {taskStateLabel(item.state)} ·{' '}
                            {formatUpdatedAt(item.updatedAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className={styles.section} aria-labelledby="notifications-heading">
              <h3 id="notifications-heading">提醒</h3>
              {visible.length === 0 ? (
                <div className={styles.empty}>
                  <span className={styles.emptyIcon}>
                    <Icon name="bell" size={22} />
                  </span>
                  <strong>
                    {notifications.length === 0 ? '还没有活动提醒' : '该分类暂无提醒'}
                  </strong>
                  <p>需要回复、待审阅、已完成与失败会在这里形成未读记录；普通进度不会弹出通知。</p>
                </div>
              ) : (
                <ul className={styles.list}>
                  {visible.map((item) => {
                    const isUnread = !readIds.has(item.id);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={isUnread ? styles.itemUnread : styles.item}
                          onClick={() => openItem(item)}
                          data-activity-id={item.id}
                          data-unread={isUnread ? 'true' : 'false'}
                        >
                          <span className={styles.categoryTag} data-category={item.category}>
                            {ACTIVITY_CATEGORY_LABELS[item.category]}
                          </span>
                          <span className={styles.itemMain}>
                            <strong>{item.title ?? '未命名任务'}</strong>
                            <span>{item.summary}</span>
                            <span className={styles.itemMeta}>
                              {item.repositoryName} · {formatUpdatedAt(item.occurredAt)}
                            </span>
                          </span>
                          {isUnread ? (
                            <span className={styles.unreadDot} aria-label="未读" />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {hasMore ? (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void loadMore()}
                  disabled={moreStatus === 'loading'}
                >
                  {moreStatus === 'loading' ? '正在加载…' : '加载更早提醒'}
                </button>
              ) : null}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
