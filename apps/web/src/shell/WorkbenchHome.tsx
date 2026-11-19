import type { ConversationSummary, RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import {
  formatUpdatedAt,
  repositoryRuntimeLabel,
  runtimeResourceLabel,
  taskStateLabel,
  waitingForLabel,
} from '../lib/format';
import styles from './WorkspaceShell.module.css';

/** How many rows each list shows: this page is a cockpit, not a history browser. */
const HOME_ROWS = 3;

function PendingRow({
  conversation,
  onOpen,
}: {
  conversation: ConversationSummary;
  onOpen: (conversationId: string) => void;
}) {
  const task = conversation.task;
  return (
    <li className={styles.homeRow}>
      <button
        type="button"
        className={styles.homeRowButton}
        onClick={() => onOpen(conversation.id)}
      >
        <span className={styles.homeRowTitle}>
          {conversation.title ?? task?.question ?? '未命名任务'}
        </span>
        <span className={styles.homeRowMeta}>
          <span className={styles.homeRowState}>
            {taskStateLabel(task?.state ?? null, task?.decision)}
          </span>
          {task?.prUrl ? <span className={styles.homeRowTag}>PR</span> : null}
          <span className={styles.homeRowTime}>{formatUpdatedAt(conversation.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The workbench home: one screen holding the current repository, its instance
 * state, the new-task action and a few rows that want attention. History, logs,
 * resources and forms live on their own pages (sidebar entries and the details
 * panel), not here.
 */
export function WorkbenchHome({
  repository,
  conversations,
  conversationsLoading,
  pendingConversations,
  pendingCount,
  pendingHasMore,
  pendingLoading,
  onNewTask,
  onOpenConversation,
  onViewAllPending,
}: {
  repository: RepositorySummary;
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  /** Server-ordered pending tasks, independent of the loaded history page. */
  pendingConversations: ConversationSummary[];
  pendingCount: number;
  pendingHasMore: boolean;
  pendingLoading: boolean;
  onNewTask: () => void;
  onOpenConversation: (conversationId: string) => void;
  onViewAllPending: () => void;
}) {
  const runtime = repository.runtime ?? null;
  const instance = repositoryRuntimeLabel(runtime);
  const waiting = waitingForLabel(runtime?.waitingFor);
  const resource = runtimeResourceLabel(runtime?.resource);
  const attention = pendingConversations.slice(0, HOME_ROWS);
  const pendingIds = new Set(attention.map((conversation) => conversation.id));
  const recent = conversations
    .filter((conversation) => !pendingIds.has(conversation.id))
    .slice(0, HOME_ROWS);
  const executionSlot =
    runtime?.executionSlot === 'busy'
      ? '占用'
      : runtime?.executionSlot === 'free'
        ? '空闲'
        : '未知';
  const listener =
    runtime?.listener === 'active' ? '接收中' : runtime?.listener === 'paused' ? '已暂停' : '未知';

  return (
    <div className={styles.home}>
      <header className={styles.homeHeader}>
        <div className={styles.homeIdentity}>
          <p className={styles.homeEyebrow}>当前仓库</p>
          <h1 className={styles.homeTitle}>{repository.fullName}</h1>
          <p className={styles.homeSubtitle}>
            默认分支 {repository.defaultBranch}
            <span className={styles.homeDot} aria-hidden="true">
              ·
            </span>
            {instance}
            {waiting ? `，${waiting}` : ''}
            {runtime?.executionSlot === 'busy' ? '，执行槽占用中' : ''}
          </p>
          {resource ? <p className={styles.homeSubtitle}>{resource}</p> : null}
          <div className={styles.homeActions}>
            <button type="button" className={styles.primaryButton} onClick={onNewTask}>
              <Icon name="plus" />
              新建任务
            </button>
          </div>
        </div>
        <dl className={styles.homeFacts}>
          <div>
            <dt>执行槽</dt>
            <dd>{executionSlot}</dd>
          </div>
          <div>
            <dt>监听</dt>
            <dd>{listener}</dd>
          </div>
          <div>
            <dt>检查命令</dt>
            <dd>
              {repository.checkCommands
                ? `本仓库 ${repository.checkCommands.length} 条`
                : '继承全局默认'}
            </dd>
          </div>
        </dl>
      </header>

      <section className={styles.homeSection} aria-labelledby="home-attention-heading">
        <div className={styles.homeSectionHeading}>
          <h2 id="home-attention-heading">待处理</h2>
          <span className={styles.homeCount}>{pendingCount}</span>
          {pendingHasMore || pendingCount > HOME_ROWS ? (
            <button type="button" className={styles.secondaryButton} onClick={onViewAllPending}>
              查看全部
            </button>
          ) : null}
        </div>
        {pendingLoading && pendingCount === 0 ? (
          <p className={styles.homeEmpty}>正在读取…</p>
        ) : attention.length === 0 ? (
          <p className={styles.homeEmpty}>没有需要你现在处理的任务。</p>
        ) : (
          <ul className={styles.homeList}>
            {attention.map((conversation) => (
              <PendingRow
                key={conversation.id}
                conversation={conversation}
                onOpen={onOpenConversation}
              />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.homeSection} aria-labelledby="home-recent-heading">
        <div className={styles.homeSectionHeading}>
          <h2 id="home-recent-heading">最近</h2>
        </div>
        {conversationsLoading && recent.length === 0 ? (
          <p className={styles.homeEmpty}>正在读取…</p>
        ) : recent.length === 0 ? (
          <p className={styles.homeEmpty}>这个仓库还没有会话。</p>
        ) : (
          <ul className={styles.homeList}>
            {recent.map((conversation) => (
              <PendingRow
                key={conversation.id}
                conversation={conversation}
                onOpen={onOpenConversation}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
