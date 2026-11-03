import clsx from 'clsx';

import type { ConversationSummary, Message, RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import {
  DELIVERY_STATE_LABELS,
  MESSAGE_KIND_LABELS,
  formatMessageTime,
  formatModel,
  formatPrLabel,
  shortCommit,
  taskStateLabel,
} from '../lib/format';
import { NewTaskPanel } from './NewTaskPanel';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProgressEntry {
  id: string;
  text: string;
  at: string;
}

interface ConversationPaneProps {
  mode: Mode;
  repository: RepositorySummary | null;
  conversation: ConversationSummary | null;
  conversationStatus: LoadStatus;
  conversationError: string | null;
  messages: Message[];
  messagesStatus: LoadStatus;
  messagesError: string | null;
  progress: ProgressEntry[];
  creatingTask: boolean;
  onRetryConversation: () => void;
  onRetryMessages: () => void;
  onOpenDetails: () => void;
  onNewTask: () => void;
  onCancelNewTask: () => void;
  onCreatedTask: (conversation: ConversationSummary) => void;
  onSessionLost: () => void;
}

const STATUS_LABELS: Record<RepositorySummary['status'], string> = {
  provisioning: '实例待准备',
  active: '实例在线',
  sleeping: '实例休眠',
  error: '实例异常',
};

function DeliveryBadge({ message }: { message: Message }) {
  const delivery = message.delivery;
  if (!delivery) {
    return null;
  }
  return (
    <span
      className={styles.deliveryBadge}
      data-state={delivery.state}
      title={delivery.lastError ?? undefined}
    >
      {DELIVERY_STATE_LABELS[delivery.state]}
    </span>
  );
}

function MessageItem({ message }: { message: Message }) {
  const inbound = message.direction === 'inbound';
  return (
    <div className={clsx(styles.messageRow, inbound && styles.messageRowInbound)}>
      <article
        className={clsx(
          styles.messageBubble,
          inbound ? styles.messageBubbleInbound : styles.messageBubbleOutbound,
        )}
      >
        <header className={styles.messageMeta}>
          <span className={styles.messageAuthor}>
            {inbound ? '你' : MESSAGE_KIND_LABELS[message.kind]}
          </span>
          <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
          {inbound ? <DeliveryBadge message={message} /> : null}
        </header>
        <p className={styles.messageBody}>{message.body}</p>
      </article>
    </div>
  );
}

export function ConversationPane({
  mode,
  repository,
  conversation,
  conversationStatus,
  conversationError,
  messages,
  messagesStatus,
  messagesError,
  progress,
  creatingTask,
  onRetryConversation,
  onRetryMessages,
  onOpenDetails,
  onNewTask,
  onCancelNewTask,
  onCreatedTask,
  onSessionLost,
}: ConversationPaneProps) {
  if (mode === 'chat') {
    return (
      <div className={styles.conversation}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}>
            <Icon name="chat" size={26} />
          </span>
          <p className={styles.heroEyebrow}>Chat 模式</p>
          <h1 className={styles.heroTitle}>Chat 尚未接入</h1>
          <p className={styles.heroLead}>
            Chat
            只提供模式入口与布局。机器人身份、聊天消息接口与回复路由会在后续阶段接入；当前不会发送或保存任何内容。
          </p>
          <span className={styles.phasePill}>预留接口 · 当前不可用</span>
        </div>
      </div>
    );
  }

  if (!repository) {
    return (
      <div className={styles.conversation}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}>
            <Icon name="cloud" size={26} />
          </span>
          <p className={styles.heroEyebrow}>Work 模式</p>
          <h1 className={styles.heroTitle}>先选择一个仓库</h1>
          <p className={styles.heroLead}>
            仓库列表来自服务端真实数据。选择仓库后可以查看已有会话或新建任务；添加仓库与实例准备在后续阶段接入。
          </p>
          <span className={styles.phasePill}>没有可用仓库</span>
        </div>
      </div>
    );
  }

  if (creatingTask) {
    return (
      <NewTaskPanel
        repository={repository}
        onCancel={onCancelNewTask}
        onCreated={onCreatedTask}
        onSessionLost={onSessionLost}
      />
    );
  }

  if (conversationStatus === 'loading' && !conversation) {
    return (
      <div className={styles.conversationView}>
        <div className={styles.paneState} aria-busy="true">
          <Icon name="session" size={16} />
          正在读取会话…
        </div>
      </div>
    );
  }

  if (conversationStatus === 'error' && !conversation) {
    return (
      <div className={styles.conversationView}>
        <div className={styles.paneError} role="alert">
          <strong>会话加载失败</strong>
          <p>{conversationError ?? '无法读取该会话。'}</p>
          <button type="button" className={styles.secondaryButton} onClick={onRetryConversation}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className={styles.conversation}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}>
            <Icon name="work" size={26} />
          </span>
          <p className={styles.heroEyebrow}>
            {repository.fullName} · {STATUS_LABELS[repository.status]}
          </p>
          <h1 className={styles.heroTitle}>选择会话或新建任务</h1>
          <p className={styles.heroLead}>
            一个会话对应一个任务。新建任务会冻结仓库、起点分支与执行方式；发送第一条消息后才会投递给执行器。
          </p>
          <div className={styles.heroActions}>
            <button type="button" className={styles.primaryButton} onClick={onNewTask}>
              <Icon name="plus" />
              新建任务
            </button>
            <button type="button" className={styles.secondaryButton} onClick={onOpenDetails}>
              <Icon name="panel" />
              查看右侧详情
            </button>
          </div>
        </div>
      </div>
    );
  }

  const task = conversation.task;
  const baseBranch = task?.baseBranch ?? conversation.baseBranch;
  const baseCommit = task?.baseCommit ?? conversation.baseCommit;
  const latestProgress = progress.length > 0 ? progress[progress.length - 1] : null;

  return (
    <div className={styles.conversationView}>
      <header className={styles.conversationHeader}>
        <div className={styles.conversationHeaderMain}>
          <div className={styles.conversationTitleRow}>
            <h1 className={styles.conversationHeading}>{conversation.title ?? '未命名任务'}</h1>
            <span className={styles.statePill} data-state={task?.state ?? 'unknown'}>
              <span className={styles.stateDot} aria-hidden="true" />
              {taskStateLabel(task?.state)}
            </span>
          </div>
          <div className={styles.conversationMeta}>
            <span className={styles.metaItem}>
              <Icon name="branch" size={13} />
              {repository.fullName}
            </span>
            <span className={styles.metaItem}>
              分支 {baseBranch}
              {baseCommit ? (
                <>
                  {' @ '}
                  <span className={styles.metaCommit}>{shortCommit(baseCommit)}</span>
                </>
              ) : (
                ' · 起点待记录'
              )}
            </span>
            <span className={styles.metaItem}>
              模型 {formatModel(task?.model ?? conversation.model)}
            </span>
            {task?.prUrl ? (
              <a
                className={styles.prLink}
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {formatPrLabel(task.prNumber)}
              </a>
            ) : null}
          </div>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={onOpenDetails}>
          <Icon name="panel" />
          详情
        </button>
      </header>

      {latestProgress ? (
        <div className={styles.progressStrip}>
          <span className={styles.progressLabel}>最新进度</span>
          <p className={styles.progressText}>{latestProgress.text}</p>
          <time className={styles.progressTime} dateTime={latestProgress.at}>
            {formatMessageTime(latestProgress.at)}
          </time>
          <details className={styles.progressLog}>
            <summary>进度日志（{progress.length}）</summary>
            <ol>
              {progress.map((entry) => (
                <li key={entry.id}>
                  <time dateTime={entry.at}>{formatMessageTime(entry.at)}</time>
                  <span>{entry.text}</span>
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : null}

      {task?.question ? (
        <div className={styles.questionBanner} role="status">
          <span className={styles.questionIcon}>
            <Icon name="chat" size={16} />
          </span>
          <div>
            <strong>执行器正在等待回复</strong>
            <p>{task.question}</p>
          </div>
        </div>
      ) : null}

      <section className={styles.messageList} aria-label="会话消息">
        {messagesStatus === 'loading' && messages.length === 0 ? (
          <p className={styles.paneHint} aria-busy="true">
            正在读取消息…
          </p>
        ) : null}

        {messagesStatus === 'error' ? (
          <div className={styles.paneError} role="alert">
            <strong>消息加载失败</strong>
            <p>{messagesError ?? '无法读取消息。'}</p>
            <button type="button" className={styles.textButton} onClick={onRetryMessages}>
              重试
            </button>
          </div>
        ) : null}

        {messagesStatus !== 'loading' && messages.length === 0 && messagesStatus !== 'error' ? (
          <div className={styles.messageEmpty}>
            <Icon name="chat" size={18} />
            <p>还没有消息</p>
            <span>在下方输入任务，发送后才会投递给执行器；任务当前处于待接单状态。</span>
          </div>
        ) : null}

        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
      </section>
    </div>
  );
}
