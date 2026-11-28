import clsx from 'clsx';

import type { ConversationSummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SidebarProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  selectedRepositoryId: string | null;
  page: 'work' | 'repositories' | 'superagent' | 'settings';
  conversations: ConversationSummary[];
  conversationsStatus: LoadStatus;
  conversationsError: string | null;
  conversationsHasMore: boolean;
  conversationsMoreStatus: 'idle' | 'loading' | 'error';
  conversationsMoreError: string | null;
  onLoadMoreConversations: () => void;
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onReloadConversations: () => void;
  onNewTask: () => void;
  onOpenRepositories: () => void;
  onOpenSuperagent: () => void;
  onOpenSettings: () => void;
  mobileOpen: boolean;
  onClose: () => void;
}

export function Sidebar({
  mode,
  onModeChange,
  selectedRepositoryId,
  page,
  conversations,
  conversationsStatus,
  conversationsError,
  conversationsHasMore,
  conversationsMoreStatus,
  conversationsMoreError,
  onLoadMoreConversations,
  selectedConversationId,
  onSelectConversation,
  onReloadConversations,
  onNewTask,
  onOpenRepositories,
  onOpenSuperagent,
  onOpenSettings,
  mobileOpen,
  onClose,
}: SidebarProps) {
  return (
    <aside
      className={clsx(styles.sidebar, mobileOpen && styles.sidebarOpen)}
      aria-label="工作台导航"
    >
      <div className={styles.modeSwitch} role="tablist" aria-label="模式">
        <button
          type="button"
          role="tab"
          aria-selected={page === 'work' && mode === 'chat'}
          className={clsx(
            styles.modeButton,
            page === 'work' && mode === 'chat' && styles.modeButtonActive,
          )}
          onClick={() => onModeChange('chat')}
        >
          <Icon name="chat" />
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={page === 'work' && mode === 'work'}
          className={clsx(
            styles.modeButton,
            page === 'work' && mode === 'work' && styles.modeButtonActive,
          )}
          onClick={() => onModeChange('work')}
        >
          <Icon name="work" />
          Work
        </button>
      </div>

      <nav className={styles.managementNav} aria-label="管理">
        <button
          type="button"
          className={styles.navButton}
          aria-current={page === 'repositories' ? 'page' : undefined}
          onClick={onOpenRepositories}
        >
          <Icon name="repository" />
          仓库
        </button>
        <button
          type="button"
          className={styles.navButton}
          aria-current={page === 'superagent' ? 'page' : undefined}
          onClick={onOpenSuperagent}
        >
          <Icon name="sparkles" />
          SuperAgent
        </button>
      </nav>

      <section className={styles.sidebarSection} aria-labelledby="conversation-heading">
        <div className={styles.sectionHeading}>
          <h2 id="conversation-heading">会话</h2>
          <div className={styles.sectionHeadingActions}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={onNewTask}
              aria-label="新建任务"
              title="新建任务"
              disabled={!selectedRepositoryId}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
        </div>

        <div className={styles.conversationScroll}>
          {!selectedRepositoryId ? (
            <p className={styles.sectionHint}>先选择仓库，再查看该仓库的会话。</p>
          ) : conversationsStatus === 'loading' && conversations.length === 0 ? (
            <p className={styles.sectionHint}>正在读取会话…</p>
          ) : conversationsStatus === 'error' ? (
            <div className={styles.sectionError}>
              <p>{conversationsError ?? '会话列表不可用'}</p>
              <button type="button" className={styles.textButton} onClick={onReloadConversations}>
                重试
              </button>
            </div>
          ) : conversations.length === 0 ? (
            <div className={styles.emptyList}>
              <Icon name="task" />
              <p>还没有任务会话</p>
              <span>新建任务后，会话会按仓库汇总在这里。</span>
            </div>
          ) : (
            <ul className={styles.conversationList}>
              {conversations.map((conversation) => {
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={clsx(
                        styles.conversationItem,
                        page === 'work' &&
                          mode === 'work' &&
                          conversation.id === selectedConversationId &&
                          styles.conversationItemActive,
                      )}
                      onClick={() => onSelectConversation(conversation.id)}
                      aria-current={
                        page === 'work' &&
                        mode === 'work' &&
                        conversation.id === selectedConversationId
                          ? 'true'
                          : undefined
                      }
                      data-conversation-id={conversation.id}
                    >
                      <Icon name="chat" size={14} />
                      <span className={styles.conversationTitle}>
                        {conversation.title ?? '未命名任务'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {conversationsHasMore || conversationsMoreStatus === 'error' ? (
            <div className={styles.sectionMore}>
              {conversationsMoreStatus === 'error' ? (
                <>
                  <p>{conversationsMoreError ?? '加载更多任务失败'}</p>
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={onLoadMoreConversations}
                  >
                    重试
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={onLoadMoreConversations}
                  disabled={conversationsMoreStatus === 'loading'}
                >
                  {conversationsMoreStatus === 'loading' ? '正在加载更多任务…' : '加载更多任务'}
                </button>
              )}
            </div>
          ) : null}
        </div>
      </section>

      <nav className={styles.sidebarNav} aria-label="设置入口">
        <button
          type="button"
          className={styles.navButton}
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
          设置
        </button>
      </nav>
      <button type="button" className={styles.mobileClose} aria-label="关闭导航" onClick={onClose}>
        <Icon name="x" />
      </button>
    </aside>
  );
}
