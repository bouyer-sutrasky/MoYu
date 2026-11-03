import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import {
  workspaceEventSchema,
  type AuthMeData,
  type AuthStateData,
  type ConversationSummary,
  type Message,
  type RepositorySummary,
  type WorkspaceEvent,
} from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { Icon } from '../components/Icon';
import { useTheme } from '../theme/ThemeProvider';
import { ActivityDialog } from './ActivityDialog';
import { Composer } from './Composer';
import { ConversationPane } from './ConversationPane';
import { DetailsPanel } from './DetailsPanel';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar } from './Sidebar';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: '重连中',
  connected: '实时连接',
  disconnected: '已断开',
};

interface ProgressEntry {
  id: string;
  text: string;
  at: string;
}

interface WorkspaceShellProps {
  me: AuthMeData;
  authState: AuthStateData;
  onSessionLost: () => void;
  onRefreshMe: () => Promise<void>;
  onLoggedOut: () => void;
}

export function WorkspaceShell({
  me,
  authState,
  onSessionLost,
  onRefreshMe,
  onLoggedOut,
}: WorkspaceShellProps) {
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const [mode, setMode] = useState<Mode>('work');
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [repositoriesStatus, setRepositoriesStatus] = useState<LoadStatus>('loading');
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsStatus, setConversationsStatus] = useState<LoadStatus>('idle');
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [conversationStatus, setConversationStatus] = useState<LoadStatus>('idle');
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesStatus, setMessagesStatus] = useState<LoadStatus>('idle');
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [creatingTask, setCreatingTask] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const conversationRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const conversationsRequestRef = useRef(0);
  const selectedConversationIdRef = useRef<string | null>(selectedConversationId);
  const selectedRepositoryIdRef = useRef<string | null>(selectedRepositoryId);
  selectedConversationIdRef.current = selectedConversationId;
  selectedRepositoryIdRef.current = selectedRepositoryId;

  const loadRepositories = useCallback(async () => {
    setRepositoriesStatus('loading');
    setRepositoriesError(null);
    try {
      const result = await api.repositories();
      setRepositories(result.repositories);
      setRepositoriesStatus('ready');
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setRepositoriesStatus('error');
      setRepositoriesError(describeApiError(caught));
    }
  }, [onSessionLost]);

  const loadConversations = useCallback(
    async (repositoryId: string, silent = false) => {
      const token = ++conversationsRequestRef.current;
      if (!silent) {
        setConversationsStatus('loading');
        setConversationsError(null);
      }
      try {
        const result = await api.conversations(repositoryId);
        if (
          token !== conversationsRequestRef.current ||
          selectedRepositoryIdRef.current !== repositoryId
        ) {
          return;
        }
        setConversations(result.conversations);
        setConversationsStatus('ready');
        setConversationsError(null);
      } catch (caught) {
        if (token !== conversationsRequestRef.current) {
          return;
        }
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        if (silent) {
          return;
        }
        setConversationsStatus('error');
        setConversationsError(describeApiError(caught));
      }
    },
    [onSessionLost],
  );

  const loadConversation = useCallback(
    async (conversationId: string, silent = false) => {
      const token = ++conversationRequestRef.current;
      if (!silent) {
        setConversationStatus('loading');
        setConversationError(null);
      }
      try {
        const result = await api.conversation(conversationId);
        if (
          token !== conversationRequestRef.current ||
          selectedConversationIdRef.current !== conversationId
        ) {
          return;
        }
        setConversation(result.conversation);
        setConversationStatus('ready');
        setConversationError(null);
      } catch (caught) {
        if (token !== conversationRequestRef.current) {
          return;
        }
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        if (silent) {
          return;
        }
        setConversationStatus('error');
        setConversationError(describeApiError(caught));
      }
    },
    [onSessionLost],
  );

  const loadMessages = useCallback(
    async (conversationId: string, silent = false) => {
      const token = ++messagesRequestRef.current;
      if (!silent) {
        setMessagesStatus('loading');
        setMessagesError(null);
      }
      try {
        const result = await api.messages(conversationId);
        if (
          token !== messagesRequestRef.current ||
          selectedConversationIdRef.current !== conversationId
        ) {
          return;
        }
        setMessages(result.messages);
        setMessagesStatus('ready');
        setMessagesError(null);
      } catch (caught) {
        if (token !== messagesRequestRef.current) {
          return;
        }
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        if (silent) {
          return;
        }
        setMessagesStatus('error');
        setMessagesError(describeApiError(caught));
      }
    },
    [onSessionLost],
  );

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  useEffect(() => {
    if (repositories.length === 0) {
      setSelectedRepositoryId(null);
      return;
    }
    if (
      !selectedRepositoryId ||
      !repositories.some((repository) => repository.id === selectedRepositoryId)
    ) {
      setSelectedRepositoryId(repositories[0]?.id ?? null);
    }
  }, [repositories, selectedRepositoryId]);

  useEffect(() => {
    setSelectedConversationId(null);
    setCreatingTask(false);
    if (!selectedRepositoryId) {
      setConversations([]);
      setConversationsStatus('idle');
      setConversationsError(null);
      return;
    }
    setConversations([]);
    setConversationsStatus('loading');
    setConversationsError(null);
    void loadConversations(selectedRepositoryId);
  }, [selectedRepositoryId, loadConversations]);

  useEffect(() => {
    conversationRequestRef.current += 1;
    messagesRequestRef.current += 1;
    setConversation(null);
    setConversationError(null);
    setMessages([]);
    setMessagesError(null);
    setProgress([]);
    if (!selectedConversationId) {
      setConversationStatus('idle');
      setMessagesStatus('idle');
      return;
    }
    setConversationStatus('loading');
    setMessagesStatus('loading');
    void loadConversation(selectedConversationId);
    void loadMessages(selectedConversationId);
  }, [selectedConversationId, loadConversation, loadMessages]);

  const handleWorkspaceEvent = useCallback(
    (event: WorkspaceEvent) => {
      const openConversationId = selectedConversationIdRef.current;
      const repositoryId = selectedRepositoryIdRef.current;

      if (event.type === 'task.progress' && event.conversationId === openConversationId) {
        const entry: ProgressEntry = {
          id: event.id,
          text: event.data.text,
          at: event.data.at,
        };
        setProgress((current) => {
          if (current.some((item) => item.id === entry.id)) {
            return current;
          }
          const next = [...current, entry];
          return next.length > 50 ? next.slice(next.length - 50) : next;
        });
      }

      const conversationMatches =
        openConversationId !== null && event.conversationId === openConversationId;
      const repositoryMatches = repositoryId !== null && event.repositoryId === repositoryId;
      if (openConversationId && (conversationMatches || repositoryMatches)) {
        void loadConversation(openConversationId, true);
        void loadMessages(openConversationId, true);
      }
      if (repositoryId && repositoryMatches) {
        void loadConversations(repositoryId, true);
      }
    },
    [loadConversation, loadMessages, loadConversations],
  );

  const eventHandlerRef = useRef<(event: WorkspaceEvent) => void>(handleWorkspaceEvent);
  useEffect(() => {
    eventHandlerRef.current = handleWorkspaceEvent;
  }, [handleWorkspaceEvent]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setConnection('disconnected');
      return;
    }
    const source = new EventSource('/api/v1/events');
    let disposed = false;

    const onOpen = () => {
      if (!disposed) {
        setConnection('connected');
      }
    };
    const onError = () => {
      if (disposed) {
        return;
      }
      setConnection(source.readyState === EventSource.CLOSED ? 'disconnected' : 'connecting');
    };
    const onWorkspaceEvent = (raw: Event) => {
      if (!(raw instanceof MessageEvent) || typeof raw.data !== 'string') {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.data);
      } catch {
        return;
      }
      const parsed = workspaceEventSchema.safeParse(payload);
      if (parsed.success) {
        eventHandlerRef.current(parsed.data);
      }
    };
    const onSessionRevoked = () => {
      source.close();
      setConnection('disconnected');
      onSessionLost();
    };

    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    source.addEventListener('workspaceEvent', onWorkspaceEvent);
    source.addEventListener('session.revoked', onSessionRevoked);
    return () => {
      disposed = true;
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.removeEventListener('workspaceEvent', onWorkspaceEvent);
      source.removeEventListener('session.revoked', onSessionRevoked);
      source.close();
    };
  }, [onSessionLost]);

  const selectedRepository = useMemo(
    () => repositories.find((repository) => repository.id === selectedRepositoryId) ?? null,
    [repositories, selectedRepositoryId],
  );

  const sendMessage = useCallback(
    async (text: string, clientMessageId: string) => {
      const conversationId = selectedConversationIdRef.current;
      if (!conversationId) {
        throw new ApiClientError(409, 'no_conversation', '当前没有打开的会话');
      }
      try {
        const result = await api.sendMessage(conversationId, { clientMessageId, text });
        if (selectedConversationIdRef.current === conversationId) {
          await Promise.all([
            loadMessages(conversationId, true),
            loadConversation(conversationId, true),
          ]);
        }
        const repositoryId = selectedRepositoryIdRef.current;
        if (repositoryId) {
          void loadConversations(repositoryId, true);
        }
        return result;
      } catch (caught) {
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
        }
        throw caught;
      }
    },
    [loadConversations, loadConversation, loadMessages, onSessionLost],
  );

  async function logout() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    try {
      await api.logout();
    } catch (caught) {
      if (!(caught instanceof ApiClientError && caught.status === 401)) {
        setRepositoriesError(describeApiError(caught));
      }
    } finally {
      setLoggingOut(false);
      onLoggedOut();
    }
  }

  function cycleTheme() {
    setThemeMode(themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system');
  }

  function closeDrawers() {
    setSidebarOpen(false);
    setDetailsOpen(false);
  }

  function startNewTask() {
    setMode('work');
    setSelectedConversationId(null);
    setCreatingTask(true);
    setSidebarOpen(false);
  }

  function openConversation(id: string) {
    setMode('work');
    setCreatingTask(false);
    setSelectedConversationId(id);
    setSidebarOpen(false);
  }

  function handleCreatedTask(created: ConversationSummary) {
    setCreatingTask(false);
    setSelectedConversationId(created.id);
    setSidebarOpen(false);
    const repositoryId = selectedRepositoryIdRef.current;
    if (repositoryId) {
      void loadConversations(repositoryId, true);
    }
  }

  return (
    <div className={styles.app}>
      <a className={styles.skipLink} href="#main-content">
        跳到主内容
      </a>

      <div className={clsx(styles.shell, detailsOpen && styles.shellWithDetails)}>
        <Sidebar
          mode={mode}
          onModeChange={(next) => {
            setMode(next);
            setSidebarOpen(false);
          }}
          repositories={repositories}
          repositoriesStatus={repositoriesStatus}
          repositoriesError={repositoriesError}
          selectedRepositoryId={selectedRepositoryId}
          onSelectRepository={setSelectedRepositoryId}
          onReloadRepositories={() => void loadRepositories()}
          conversations={conversations}
          conversationsStatus={conversationsStatus}
          conversationsError={conversationsError}
          selectedConversationId={selectedConversationId}
          onSelectConversation={openConversation}
          onReloadConversations={() => {
            if (selectedRepositoryIdRef.current) {
              void loadConversations(selectedRepositoryIdRef.current);
            }
          }}
          onNewTask={startNewTask}
          onOpenActivity={() => {
            setActivityOpen(true);
            setSidebarOpen(false);
          }}
          onOpenSettings={() => {
            setSettingsOpen(true);
            setSidebarOpen(false);
          }}
          ownerName={me.owner.displayName}
          themeMode={themeMode}
          onCycleTheme={cycleTheme}
          mobileOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onLogout={() => void logout()}
        />

        <div
          className={clsx(
            styles.mobileScrim,
            (sidebarOpen || detailsOpen) && styles.mobileScrimVisible,
          )}
          onClick={closeDrawers}
          role="presentation"
        />

        <div className={styles.center}>
          <header className={styles.topbar}>
            <div className={styles.topbarLeft}>
              <button
                type="button"
                className={styles.mobileMenu}
                onClick={() => setSidebarOpen(true)}
                aria-label="打开导航"
              >
                <Icon name="menu" />
              </button>
              <nav className={styles.breadcrumb} aria-label="当前位置">
                <span>MoYu</span>
                <span className={styles.breadcrumbSeparator}>/</span>
                <span>{mode === 'work' ? 'Work' : 'Chat'}</span>
                {selectedRepository ? (
                  <>
                    <span className={styles.breadcrumbSeparator}>/</span>
                    <strong>{selectedRepository.fullName}</strong>
                  </>
                ) : null}
                {selectedRepository && conversation ? (
                  <>
                    <span className={styles.breadcrumbSeparator}>/</span>
                    <span className={styles.breadcrumbTitle}>
                      {conversation.title ?? '未命名任务'}
                    </span>
                  </>
                ) : null}
              </nav>
            </div>

            <div className={styles.topbarRight}>
              <span className={styles.connectionPill} data-state={connection}>
                <span className={styles.connectionDot} aria-hidden="true" />
                {CONNECTION_LABELS[connection]}
              </span>
              <span className={styles.sessionPill} title="会话长期保持，可随时撤销">
                <span className={styles.sessionDot} aria-hidden="true" />
                已登录
              </span>
              <button
                type="button"
                className={styles.topbarButton}
                onClick={() => setActivityOpen(true)}
                aria-label="打开活动中心"
                title="活动中心"
              >
                <Icon name="bell" />
                <span className={styles.topbarBadge}>0</span>
              </button>
              <button
                type="button"
                className={clsx(styles.topbarButton, detailsOpen && styles.topbarButtonActive)}
                onClick={() => setDetailsOpen((current) => !current)}
                aria-label={detailsOpen ? '收起右侧详情' : '展开右侧详情'}
                aria-expanded={detailsOpen}
                title={detailsOpen ? '收起详情' : '展开详情'}
              >
                <Icon name="panel" />
              </button>
            </div>
          </header>

          <main id="main-content" className={styles.main} tabIndex={-1}>
            <ConversationPane
              mode={mode}
              repository={selectedRepository}
              conversation={conversation}
              conversationStatus={conversationStatus}
              conversationError={conversationError}
              messages={messages}
              messagesStatus={messagesStatus}
              messagesError={messagesError}
              progress={progress}
              creatingTask={creatingTask}
              onRetryConversation={() => {
                if (selectedConversationIdRef.current) {
                  void loadConversation(selectedConversationIdRef.current);
                }
              }}
              onRetryMessages={() => {
                if (selectedConversationIdRef.current) {
                  void loadMessages(selectedConversationIdRef.current);
                }
              }}
              onOpenDetails={() => setDetailsOpen(true)}
              onNewTask={startNewTask}
              onCancelNewTask={() => setCreatingTask(false)}
              onCreatedTask={handleCreatedTask}
              onSessionLost={onSessionLost}
            />
          </main>

          <Composer
            mode={mode}
            repository={selectedRepository}
            conversation={conversation}
            conversationLoading={conversationStatus === 'loading'}
            onSend={sendMessage}
          />
        </div>

        <DetailsPanel
          open={detailsOpen}
          repository={selectedRepository}
          conversation={conversation}
          onClose={() => setDetailsOpen(false)}
        />
      </div>

      {settingsOpen ? (
        <SettingsDialog
          me={me}
          authState={authState}
          onClose={() => setSettingsOpen(false)}
          onRefreshMe={onRefreshMe}
          onLoggedOut={onLoggedOut}
          onSessionLost={onSessionLost}
        />
      ) : null}

      {activityOpen ? <ActivityDialog onClose={() => setActivityOpen(false)} /> : null}
    </div>
  );
}
