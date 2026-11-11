import { useCallback, useEffect, useRef, useState } from 'react';

import type { HistorySearchItem, RepositorySummary, TaskState } from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { formatUpdatedAt, taskStateLabel } from '../lib/format';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import styles from './HistoryDialog.module.css';

interface HistoryDialogProps {
  repositories: RepositorySummary[];
  initialRepositoryId: string | null;
  onClose: () => void;
  onOpenConversation: (target: { conversationId: string; repositoryId: string }) => void;
  onSessionLost: () => void;
}

const STATE_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'waiting_input', label: '需要回复' },
  { value: 'running', label: '运行中' },
  { value: 'awaiting_review', label: '待审阅' },
  { value: 'stopped', label: '已停止' },
  { value: 'completed', label: '已完成' },
  { value: 'closed_unmerged', label: '已关闭未合并' },
  { value: 'failed', label: '失败' },
  { value: 'blocked', label: '受阻' },
  { value: 'none', label: '无任务' },
];

export function HistoryDialog({
  repositories,
  initialRepositoryId,
  onClose,
  onOpenConversation,
  onSessionLost,
}: HistoryDialogProps) {
  const [query, setQuery] = useState('');
  const [repositoryId, setRepositoryId] = useState(initialRepositoryId ?? '');
  const [state, setState] = useState('');
  const [items, setItems] = useState<HistorySearchItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [moreStatus, setMoreStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const requestRef = useRef(0);

  const search = useCallback(
    async (reset: boolean, cursor?: string | null) => {
      if (!reset && !cursor) return;
      const token = ++requestRef.current;
      if (reset) {
        setStatus('loading');
        setError(null);
        setMoreStatus('idle');
      } else {
        setMoreStatus('loading');
      }
      try {
        const result = await api.searchHistory({
          ...(query.trim() ? { q: query.trim() } : {}),
          ...(repositoryId ? { repositoryId } : {}),
          ...(state ? { state } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 30,
        });
        if (token !== requestRef.current) return;
        setItems((current) => (reset ? result.items : [...current, ...result.items]));
        setNextCursor(result.nextCursor);
        setHasMore(result.hasMore);
        setStatus('ready');
        setMoreStatus('idle');
      } catch (caught) {
        if (token !== requestRef.current) return;
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        if (reset) {
          setStatus('error');
          setError(describeApiError(caught));
        } else {
          setMoreStatus('error');
        }
      }
    },
    [onSessionLost, query, repositoryId, state],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void search(true);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [search]);

  function resetFilters() {
    setQuery('');
    setRepositoryId(initialRepositoryId ?? '');
    setState('');
  }

  return (
    <Modal
      title="历史搜索"
      description="按文本、仓库与任务状态检索自己的历史任务与会话。结果按最近活动分页，同一游标不重不漏。"
      onClose={onClose}
      wide
    >
      <div className={styles.content}>
        <form className={styles.searchForm} onSubmit={(event) => event.preventDefault()}>
          <label className={styles.searchBox}>
            <Icon name="search" size={16} />
            <span className="visually-hidden">搜索关键词</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={500}
              placeholder="搜索任务标题或消息正文…"
              aria-label="搜索历史任务"
            />
          </label>
          <label className={styles.selectLabel}>
            <span>仓库</span>
            <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
              <option value="">全部仓库</option>
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.selectLabel}>
            <span>状态</span>
            <select value={state} onChange={(event) => setState(event.target.value)}>
              {STATE_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={styles.secondaryButton} onClick={resetFilters}>
            重置
          </button>
        </form>

        <div className={styles.summaryRow} role="status">
          {status === 'loading'
            ? '正在搜索…'
            : status === 'ready'
              ? `${items.length} 个结果${hasMore ? '（可继续加载）' : ''}`
              : '搜索失败'}
        </div>

        {status === 'error' ? (
          <div className={styles.errorBox} role="alert">
            <p>{error ?? '搜索不可用'}</p>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void search(true)}
            >
              重试
            </button>
          </div>
        ) : status === 'ready' && items.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              <Icon name="search" size={22} />
            </span>
            <strong>{query.trim() ? '没有匹配的历史任务' : '还没有历史任务'}</strong>
            <p>
              关键词按字面匹配标题与消息正文；可清空关键词浏览最近任务，或换一个仓库与状态范围。
            </p>
          </div>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.conversation.id}>
                <button
                  type="button"
                  className={styles.item}
                  onClick={() =>
                    onOpenConversation({
                      conversationId: item.conversation.id,
                      repositoryId: item.repository.id,
                    })
                  }
                  data-conversation-id={item.conversation.id}
                >
                  <span className={styles.itemTop}>
                    <strong>{item.conversation.title ?? '未命名任务'}</strong>
                    <span
                      className={styles.stateTag}
                      data-state={item.conversation.task?.state ?? 'none'}
                    >
                      {taskStateLabel((item.conversation.task?.state ?? null) as TaskState | null)}
                    </span>
                  </span>
                  {item.snippet ? <span className={styles.snippet}>{item.snippet}</span> : null}
                  <span className={styles.itemMeta}>
                    {item.repository.fullName} · {formatUpdatedAt(item.conversation.updatedAt)}
                    {item.matched === 'title' ? ' · 标题匹配' : ''}
                    {item.matched === 'message' ? ' · 正文匹配' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {hasMore ? (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void search(false, nextCursor)}
            disabled={moreStatus === 'loading'}
          >
            {moreStatus === 'loading' ? '正在加载…' : '加载更多结果'}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
