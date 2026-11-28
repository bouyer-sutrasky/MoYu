import type { ConversationSummary, RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import {
  formatElapsed,
  formatUpdatedAt,
  repositoryActivationLabel,
  repositoryPreparationLabel,
  taskStateLabel,
} from '../lib/format';
import styles from './WorkspaceShell.module.css';

/** How many rows each list shows: this page is a cockpit, not a history browser. */
const HOME_ROWS = 3;

function PendingRow({
  conversation,
  onOpen,
  pending = false,
}: {
  conversation: ConversationSummary;
  onOpen: (conversationId: string) => void;
  pending?: boolean;
}) {
  const task = conversation.task;
  return (
    <li className={styles.homeRow}>
      <button
        type="button"
        className={styles.homeRowButton}
        data-pending={pending}
        onClick={() => onOpen(conversation.id)}
      >
        <span className={styles.homeRowIcon} data-state={task?.state ?? 'unknown'}>
          <Icon name={task?.state === 'awaiting_review' ? 'task' : 'chat'} size={17} />
        </span>
        <span className={styles.homeRowText}>
          <strong className={styles.homeRowTitle}>
            {conversation.title ?? task?.question ?? '未命名任务'}
          </strong>
          {pending ? (
            <span className={styles.homeRowState}>
              {taskStateLabel(task?.state ?? null, task?.decision)}
            </span>
          ) : null}
        </span>
        {!pending ? (
          <span className={styles.homeRowMeta}>
            <span className={styles.homeRowState} data-state={task?.state ?? 'unknown'}>
              {taskStateLabel(task?.state ?? null, task?.decision)}
            </span>
            {task?.prUrl ? <span className={styles.homeRowTag}>PR</span> : null}
            <span>{formatUpdatedAt(conversation.updatedAt)}</span>
          </span>
        ) : (
          <span className={styles.homeRowChevron}>
            <Icon name="chevron-down" size={16} />
          </span>
        )}
      </button>
    </li>
  );
}

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
  onRepositoryAction,
  repositoryActionBusy,
  repositoryActionError,
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
  onRepositoryAction: (action: 'wake' | 'sleep' | 'retry' | 'retry_stop' | 'prepare') => void;
  repositoryActionBusy: boolean;
  repositoryActionError: string | null;
}) {
  const runtime = repository.runtime ?? null;
  const attention = pendingConversations.slice(0, HOME_ROWS);
  const recent = conversations.slice(0, 4);
  const activation = runtime?.activation;
  const failedPreparation = runtime?.preparation.state === 'failed' ? runtime.preparation : null;
  const activationLabel =
    repositoryActivationLabel(activation) ??
    (failedPreparation ? repositoryPreparationLabel(failedPreparation) : null);
  const activationElapsed = activation ? formatElapsed(activation.elapsedMs) : null;
  const retryAction =
    activation?.retryAction ??
    (failedPreparation &&
    runtime?.actions.some((action) => action.action === 'prepare' && action.enabled)
      ? 'prepare'
      : null);
  return (
    <div className={styles.home}>
      <header className={styles.homeHeader}>
        <div className={styles.homeIdentity}>
          <p className={styles.homeEyebrow}>
            <Icon name="repository" size={14} /> 当前仓库
          </p>
          <h1 className={styles.homeTitle} title={repository.fullName}>
            {repository.fullName.split('/').at(-1)}
          </h1>
          <div className={styles.homeActions}>
            <button type="button" className={styles.primaryButton} onClick={onNewTask}>
              <Icon name="plus" />
              新建任务
            </button>
          </div>
        </div>
        <div className={styles.homeArt} aria-hidden="true">
          <div />
          <div />
          <div>
            <span>
              <Icon name="branch" size={13} /> {repository.defaultBranch}
            </span>
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
      </header>

      {activationLabel ? (
        <div
          className={styles.activationBanner}
          data-state={failedPreparation ? 'failed' : activation?.phase}
          role="status"
        >
          <div className={styles.activationRow}>
            <strong>{activationLabel}</strong>
            {activationElapsed ? <span>已用时 {activationElapsed}</span> : null}
            {retryAction && !repositoryActionBusy ? (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => onRepositoryAction(retryAction)}
              >
                {retryAction === 'prepare'
                  ? '重试准备'
                  : retryAction === 'wake'
                    ? '唤醒'
                    : '重试启动'}
              </button>
            ) : null}
          </div>
          {(activation?.detail ?? failedPreparation?.detail) ? (
            <p className={styles.activationDetail}>
              {activation?.detail ?? failedPreparation?.detail}
            </p>
          ) : null}
        </div>
      ) : null}

      {repositoryActionError ? (
        <p className={styles.runtimeError} role="alert">
          {repositoryActionError}
        </p>
      ) : null}

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
          <ul className={styles.homePendingList}>
            {attention.map((conversation) => (
              <PendingRow
                key={conversation.id}
                conversation={conversation}
                onOpen={onOpenConversation}
                pending
              />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.homeSection} aria-labelledby="home-recent-heading">
        <div className={styles.homeSectionHeading}>
          <h2 id="home-recent-heading">最近会话</h2>
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
