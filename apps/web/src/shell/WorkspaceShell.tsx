import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import {
  workspaceEventSchema,
  type AuthMeData,
  type AuthStateData,
  type ConversationSummary,
  type Message,
  type RepositorySummary,
  type TaskReview,
  type WorkspaceEvent,
} from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { categoryForEvent, loadActivityReadIds, loadNotificationSettings } from '../lib/activity';
import { deliverWebNotification } from '../lib/notifications';
import { clearOwnerDrafts, moveDraftToAlias } from '../lib/drafts';
import { describeApiError } from '../lib/errors';
import { Icon } from '../components/Icon';
import { useTheme } from '../theme/ThemeProvider';
import { ActivityDialog } from './ActivityDialog';
import { HistoryDialog } from './HistoryDialog';
import { Composer } from './Composer';
import { ConversationPane } from './ConversationPane';
import { DetailsPanel } from './DetailsPanel';
import { SettingsDialog } from './SettingsDialog';
import { AddRepositoryDialog } from './AddRepositoryDialog';
import { Sidebar } from './Sidebar';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type PageStatus = 'idle' | 'loading' | 'error';
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

const MESSAGE_PAGE_SIZE = 100;
const CONVERSATION_PAGE_SIZE = 50;
/** How many additional `after` pages one SSE merge may fetch before leaving the rest. */
const SSE_MERGE_PAGE_LIMIT = 5;

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

/**
 * Merges one server page into the loaded history without re-sorting it. The
 * server orders by `(created_at, id)` with full PostgreSQL precision; sorting
 * the serialized ISO milliseconds again could reorder messages whose
 * microseconds differ inside one millisecond. A page that overlaps the current
 * list replaces that block (delivery updates), an older page is prepended and a
 * newer page appended.
 */
function mergeMessages(
  current: Message[],
  incoming: Message[],
  direction: 'older' | 'newer',
): Message[] {
  if (incoming.length === 0) {
    return current;
  }
  const incomingIds = new Set(incoming.map((message) => message.id));
  if (current.length === 0) {
    return incoming;
  }
  const firstOverlap = current.findIndex((message) => incomingIds.has(message.id));
  if (firstOverlap === -1) {
    // Disjoint pages keep the server order; the caller knows whether the page
    // is older or newer than the loaded range, so no timestamp re-comparison is
    // needed at a boundary that may share a millisecond.
    return direction === 'older' ? [...incoming, ...current] : [...current, ...incoming];
  }
  let lastOverlap = current.length - 1;
  while (lastOverlap > firstOverlap && !incomingIds.has(current[lastOverlap]!.id)) {
    lastOverlap -= 1;
  }
  return [...current.slice(0, firstOverlap), ...incoming, ...current.slice(lastOverlap + 1)];
}

function mergeConversations(
  current: ConversationSummary[],
  incoming: ConversationSummary[],
): ConversationSummary[] {
  if (incoming.length === 0) {
    return current;
  }
  const byId = new Map(current.map((conversation) => [conversation.id, conversation]));
  for (const conversation of incoming) {
    byId.set(conversation.id, conversation);
  }
  return [...byId.values()].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt < right.updatedAt ? 1 : -1;
    }
    return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
  });
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
  const [conversationsNextCursor, setConversationsNextCursor] = useState<string | null>(null);
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [conversationsMoreStatus, setConversationsMoreStatus] = useState<PageStatus>('idle');
  const [conversationsMoreError, setConversationsMoreError] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [conversationStatus, setConversationStatus] = useState<LoadStatus>('idle');
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesStatus, setMessagesStatus] = useState<LoadStatus>('idle');
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messagesNextCursor, setMessagesNextCursor] = useState<string | null>(null);
  const [messagesNewerCursor, setMessagesNewerCursor] = useState<string | null>(null);
  const [messagesHasMoreOlder, setMessagesHasMoreOlder] = useState(false);
  const [messagesOlderStatus, setMessagesOlderStatus] = useState<PageStatus>('idle');
  const [messagesOlderError, setMessagesOlderError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [creatingTask, setCreatingTask] = useState(false);
  const [taskCommandBusy, setTaskCommandBusy] = useState(false);
  const [taskCommandError, setTaskCommandError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [review, setReview] = useState<TaskReview | null>(null);
  const [reviewStatus, setReviewStatus] = useState<LoadStatus>('idle');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<'changes' | 'checks' | null>(null);
  const reviewTaskRef = useRef<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addRepositoryOpen, setAddRepositoryOpen] = useState(false);
  const [repositoryActionBusy, setRepositoryActionBusy] = useState(false);
  const [repositoryActionError, setRepositoryActionError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const conversationRequestRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const conversationsRequestRef = useRef(0);
  const conversationsMoreRef = useRef(0);
  const conversationsMoreInFlightRef = useRef(false);
  const messagesOlderRef = useRef(0);
  const messagesOlderInFlightRef = useRef(false);
  const messagesMergeRef = useRef(0);
  const messagesInitialLoadingRef = useRef(false);
  const messagesDirtyRef = useRef(false);
  const pendingDeliveryIdsRef = useRef<Set<string>>(new Set());
  const deliveryRefreshSeqRef = useRef(0);
  const deliveryRefreshTokensRef = useRef<Map<string, number>>(new Map());
  const reviewRequestRef = useRef(0);
  const mainRef = useRef<HTMLElement | null>(null);
  const scrollAdjustRef = useRef<{
    conversationId: string;
    height: number;
    top: number;
    toBottom: boolean;
    anchorId?: string;
    anchorTop?: number;
  } | null>(null);
  const messagesNextCursorRef = useRef<string | null>(null);
  const messagesNewerCursorRef = useRef<string | null>(null);
  const conversationsNextCursorRef = useRef<string | null>(null);
  const selectedConversationIdRef = useRef<string | null>(selectedConversationId);
  const selectedRepositoryIdRef = useRef<string | null>(selectedRepositoryId);
  const repositoriesRef = useRef<RepositorySummary[]>(repositories);
  const pendingOpenRef = useRef<{ conversationId: string; repositoryId: string } | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const pageOpenedAtRef = useRef(Date.now());
  selectedConversationIdRef.current = selectedConversationId;
  selectedRepositoryIdRef.current = selectedRepositoryId;
  repositoriesRef.current = repositories;
  messagesNextCursorRef.current = messagesNextCursor;
  messagesNewerCursorRef.current = messagesNewerCursor;
  conversationsNextCursorRef.current = conversationsNextCursor;

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

  const handleRepositoryAction = useCallback(
    async (action: 'wake' | 'sleep' | 'retry' | 'retry_stop') => {
      const repositoryId = selectedRepositoryIdRef.current;
      if (!repositoryId) return;
      setRepositoryActionBusy(true);
      setRepositoryActionError(null);
      try {
        if (action === 'sleep' || action === 'retry_stop') {
          await api.sleepRepository(repositoryId);
        } else {
          await api.wakeRepository(repositoryId);
        }
        await loadRepositories();
      } catch (caught) {
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        setRepositoryActionError(describeApiError(caught));
      } finally {
        setRepositoryActionBusy(false);
      }
    },
    [loadRepositories, onSessionLost],
  );

  const loadConversations = useCallback(
    async (repositoryId: string, options: { silent?: boolean; cursor?: string | null } = {}) => {
      const cursor = options.cursor ?? null;
      if (cursor) {
        if (conversationsMoreInFlightRef.current) {
          return;
        }
        conversationsMoreInFlightRef.current = true;
        const token = ++conversationsMoreRef.current;
        setConversationsMoreStatus('loading');
        setConversationsMoreError(null);
        try {
          const result = await api.conversations(repositoryId, {
            limit: CONVERSATION_PAGE_SIZE,
            cursor,
          });
          if (
            token !== conversationsMoreRef.current ||
            selectedRepositoryIdRef.current !== repositoryId
          ) {
            return;
          }
          setConversations((current) => mergeConversations(current, result.conversations));
          setConversationsNextCursor(result.nextCursor);
          setConversationsHasMore(result.hasMore && result.nextCursor !== null);
          setConversationsMoreStatus('idle');
        } catch (caught) {
          if (
            token !== conversationsMoreRef.current ||
            selectedRepositoryIdRef.current !== repositoryId
          ) {
            return;
          }
          if (caught instanceof ApiClientError && caught.status === 401) {
            onSessionLost();
            return;
          }
          setConversationsMoreStatus('error');
          setConversationsMoreError(describeApiError(caught));
        } finally {
          conversationsMoreInFlightRef.current = false;
        }
        return;
      }

      const token = ++conversationsRequestRef.current;
      const silent = options.silent === true;
      if (!silent) {
        setConversationsStatus('loading');
        setConversationsError(null);
      }
      try {
        const result = await api.conversations(repositoryId, { limit: CONVERSATION_PAGE_SIZE });
        if (
          token !== conversationsRequestRef.current ||
          selectedRepositoryIdRef.current !== repositoryId
        ) {
          return;
        }
        setConversations((current) =>
          silent ? mergeConversations(current, result.conversations) : result.conversations,
        );
        setConversationsNextCursor((current) => {
          // A silent refresh only fetches the newest page. Keep the cursor of
          // already loaded older pages; otherwise adopt the response cursor.
          if (silent && current && result.conversations.length > 0) {
            return current;
          }
          return result.nextCursor;
        });
        setConversationsHasMore((current) => (silent && current ? current : result.hasMore));
        setConversationsStatus('ready');
        setConversationsError(null);
        setConversationsMoreStatus('idle');
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

  const loadMoreConversations = useCallback(async () => {
    const repositoryId = selectedRepositoryIdRef.current;
    const cursor = conversationsNextCursorRef.current;
    if (!repositoryId || !cursor || conversationsMoreStatus === 'loading') {
      return;
    }
    await loadConversations(repositoryId, { cursor });
  }, [conversationsMoreStatus, loadConversations]);

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
        // A GET can resolve a hidden merged alias to its target. Move any
        // draft state before the selected id changes, otherwise a source send
        // whose response was lost would leave its unresolved key invisible.
        if (result.conversation.id !== conversationId) {
          moveDraftToAlias(
            me.owner.id,
            result.conversation.repositoryId,
            conversationId,
            result.conversation.id,
          );
          setSelectedConversationId(result.conversation.id);
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

  /**
   * Refreshes one already loaded message. Delivery transitions (`delivered`,
   * `read`) target existing rows, which a strict `after` page cannot return; the
   * event carries the message id so only that row is refetched.
   */
  const refreshMessage = useCallback(async (conversationId: string, messageId: string) => {
    if (selectedConversationIdRef.current !== conversationId) {
      return;
    }
    if (messagesInitialLoadingRef.current) {
      pendingDeliveryIdsRef.current.add(messageId);
      messagesDirtyRef.current = true;
      return;
    }
    // Delivery events can overlap (delivered, then read). Responses may arrive
    // out of order, so only the newest request for this message may write; a
    // stale delivered response must not overwrite a newer read projection.
    const key = `${conversationId}:${messageId}`;
    const token = ++deliveryRefreshSeqRef.current;
    deliveryRefreshTokensRef.current.set(key, token);
    try {
      const result = await api.message(conversationId, messageId);
      if (
        selectedConversationIdRef.current !== conversationId ||
        deliveryRefreshTokensRef.current.get(key) !== token
      ) {
        return;
      }
      deliveryRefreshTokensRef.current.delete(key);
      setMessages((current) =>
        current.map((message) => (message.id === result.message.id ? result.message : message)),
      );
    } catch {
      // A later delivery event or a manual refresh retries the same row.
    }
  }, []);

  /**
   * Fetches messages newer than a cursor and merges them by id. Used for SSE
   * arrivals and for catch-up after an initial page; it appends without
   * replacing already loaded older pages.
   */
  const mergeNewerMessages = useCallback(
    async (conversationId: string, startingCursor?: string | null) => {
      if (selectedConversationIdRef.current !== conversationId) {
        return;
      }
      if (messagesInitialLoadingRef.current) {
        // The initial response may predate this event; catch up after it lands.
        messagesDirtyRef.current = true;
        return;
      }
      const token = ++messagesMergeRef.current;
      let cursor = startingCursor === undefined ? messagesNewerCursorRef.current : startingCursor;
      try {
        for (let pageIndex = 0; pageIndex < SSE_MERGE_PAGE_LIMIT; pageIndex += 1) {
          const result = await api.messages(conversationId, {
            ...(cursor ? { after: cursor } : {}),
            limit: MESSAGE_PAGE_SIZE,
          });
          if (
            token !== messagesMergeRef.current ||
            selectedConversationIdRef.current !== conversationId
          ) {
            return;
          }
          const container = mainRef.current;
          const nearBottom =
            !container ||
            container.scrollHeight - container.scrollTop - container.clientHeight < 120;
          if (nearBottom && result.messages.length > 0) {
            scrollAdjustRef.current = {
              conversationId,
              height: container?.scrollHeight ?? 0,
              top: container?.scrollTop ?? 0,
              toBottom: true,
            };
          }
          setMessages((current) => mergeMessages(current, result.messages, 'newer'));
          if (!cursor) {
            setMessagesNextCursor((current) => current ?? result.nextCursor);
            setMessagesHasMoreOlder((current) => current || result.nextCursor !== null);
          }
          const nextCursor = result.newerCursor ?? cursor;
          if (nextCursor) {
            cursor = nextCursor;
            setMessagesNewerCursor(nextCursor);
          }
          if (!result.hasNewer) {
            return;
          }
        }
      } catch {
        // A later SSE event or a manual refresh retries the same keyset window.
      }
    },
    [],
  );

  const loadMessages = useCallback(
    async (conversationId: string, silent = false) => {
      // A silent refresh during the first page would supersede the initial
      // request and could lose either response. Record the need to catch up and
      // let the initial page finish first.
      if (silent && messagesInitialLoadingRef.current) {
        messagesDirtyRef.current = true;
        return;
      }
      const token = ++messagesRequestRef.current;
      if (!silent) {
        messagesInitialLoadingRef.current = true;
        setMessagesStatus('loading');
        setMessagesError(null);
      }
      try {
        const result = await api.messages(conversationId, { limit: MESSAGE_PAGE_SIZE });
        if (
          token !== messagesRequestRef.current ||
          selectedConversationIdRef.current !== conversationId
        ) {
          return;
        }
        // Update the cursor ref before the catch-up uses it: React state is not
        // applied until after this callback finishes.
        messagesNewerCursorRef.current = result.newerCursor;
        setMessages((current) =>
          silent ? mergeMessages(current, result.messages, 'newer') : result.messages,
        );
        setMessagesNextCursor((current) => (silent && current ? current : result.nextCursor));
        setMessagesNewerCursor(result.newerCursor);
        setMessagesHasMoreOlder((current) =>
          silent && current ? current : result.nextCursor !== null,
        );
        setMessagesStatus('ready');
        setMessagesError(null);
        setMessagesOlderStatus('idle');
        setMessagesOlderError(null);
        if (!silent) {
          messagesInitialLoadingRef.current = false;
          const dirty = messagesDirtyRef.current;
          const pendingDeliveryIds = [...pendingDeliveryIdsRef.current];
          messagesDirtyRef.current = false;
          pendingDeliveryIdsRef.current.clear();
          if (dirty) {
            // The first query may have run before an SSE event that was then
            // ignored as "loading"; fetch everything after the returned cursor
            // and refresh any delivery transitions observed in the gap.
            void mergeNewerMessages(conversationId, result.newerCursor);
            for (const messageId of pendingDeliveryIds) {
              void refreshMessage(conversationId, messageId);
            }
          }
        }
      } catch (caught) {
        if (token !== messagesRequestRef.current) {
          return;
        }
        if (!silent) {
          messagesInitialLoadingRef.current = false;
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
    [mergeNewerMessages, onSessionLost, refreshMessage],
  );

  /**
   * Loads the page immediately older than the loaded history and keeps the
   * reader's viewport anchored to the same message.
   */
  const loadOlderMessages = useCallback(async () => {
    const conversationId = selectedConversationIdRef.current;
    const cursor = messagesNextCursorRef.current;
    if (!conversationId || !cursor || messagesOlderInFlightRef.current) {
      return;
    }
    messagesOlderInFlightRef.current = true;
    const token = ++messagesOlderRef.current;
    setMessagesOlderStatus('loading');
    setMessagesOlderError(null);
    const container = mainRef.current;
    const height = container?.scrollHeight ?? 0;
    const top = container?.scrollTop ?? 0;
    // Remember the message currently at the top of the viewport, so the same
    // row can be held at the same screen position after older rows are added.
    const anchor = mainRef.current?.querySelector<HTMLElement>('[data-message-id]');
    const visible = (() => {
      const mainTop = container?.getBoundingClientRect().top ?? 0;
      const rows = container?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [];
      for (const row of rows) {
        if (row.getBoundingClientRect().bottom > mainTop + 1) {
          return { id: row.dataset.messageId ?? '', top: row.getBoundingClientRect().top };
        }
      }
      return null;
    })();
    try {
      const result = await api.messages(conversationId, {
        before: cursor,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (
        token !== messagesOlderRef.current ||
        selectedConversationIdRef.current !== conversationId ||
        messagesNextCursorRef.current !== cursor
      ) {
        return;
      }
      scrollAdjustRef.current = {
        conversationId,
        height,
        top,
        toBottom: false,
        anchorId: visible?.id ?? anchor?.dataset.messageId,
        anchorTop: visible?.top,
      };
      setMessages((current) => mergeMessages(current, result.messages, 'older'));
      setMessagesNextCursor(result.nextCursor);
      setMessagesHasMoreOlder(result.nextCursor !== null);
      setMessagesOlderStatus('idle');
    } catch (caught) {
      if (
        token !== messagesOlderRef.current ||
        selectedConversationIdRef.current !== conversationId
      ) {
        return;
      }
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setMessagesOlderStatus('error');
      setMessagesOlderError(describeApiError(caught));
    } finally {
      messagesOlderInFlightRef.current = false;
    }
  }, [onSessionLost]);

  // After a page is prepended, restore the viewport by the added height; after
  // new messages arrive at the bottom, follow them only when already near it.
  useLayoutEffect(() => {
    const pending = scrollAdjustRef.current;
    const container = mainRef.current;
    if (!pending || !container || pending.conversationId !== selectedConversationIdRef.current) {
      scrollAdjustRef.current = null;
      return;
    }
    if (pending.toBottom) {
      container.scrollTop = container.scrollHeight;
    } else if (pending.anchorId && typeof pending.anchorTop === 'number') {
      const anchor = container.querySelector<HTMLElement>(
        `[data-message-id="${pending.anchorId}"]`,
      );
      if (anchor) {
        container.scrollTop += anchor.getBoundingClientRect().top - pending.anchorTop;
      } else {
        const added = container.scrollHeight - pending.height;
        if (added > 0) {
          container.scrollTop = pending.top + added;
        }
      }
    } else {
      const added = container.scrollHeight - pending.height;
      if (added > 0) {
        container.scrollTop = pending.top + added;
      }
    }
    scrollAdjustRef.current = null;
  }, [messages]);

  useEffect(() => {
    // On a conversation switch the first page is the newest one; start at the
    // bottom like a chat client, not at the oldest loaded message.
    if (!selectedConversationId || messagesStatus !== 'ready') {
      return;
    }
    const container = mainRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [selectedConversationId, messagesStatus]);

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  // The unread badge is derived from the durable activity feed and this
  // browser's read markers, so reopening a page restores what is still unread.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.activity({ limit: 100 });
        if (cancelled) return;
        const readIds = loadActivityReadIds(me.owner.id);
        setUnreadCount(result.notifications.filter((item) => !readIds.has(item.id)).length);
      } catch {
        if (!cancelled) setUnreadCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me.owner.id]);

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
    conversationsRequestRef.current += 1;
    conversationsMoreRef.current += 1;
    conversationsMoreInFlightRef.current = false;
    setSelectedConversationId(null);
    setCreatingTask(false);
    setConversationsNextCursor(null);
    setConversationsHasMore(false);
    setConversationsMoreStatus('idle');
    setConversationsMoreError(null);
    if (!selectedRepositoryId) {
      setConversations([]);
      setConversationsStatus('idle');
      setConversationsError(null);
      return;
    }
    setConversations([]);
    setConversationsStatus('loading');
    setConversationsError(null);
    const pending = pendingOpenRef.current;
    if (pending && pending.repositoryId === selectedRepositoryId) {
      pendingOpenRef.current = null;
      setSelectedConversationId(pending.conversationId);
    }
    void loadConversations(selectedRepositoryId);
  }, [selectedRepositoryId, loadConversations]);

  useEffect(() => {
    conversationRequestRef.current += 1;
    messagesRequestRef.current += 1;
    messagesOlderRef.current += 1;
    messagesOlderInFlightRef.current = false;
    messagesMergeRef.current += 1;
    messagesInitialLoadingRef.current = false;
    messagesDirtyRef.current = false;
    pendingDeliveryIdsRef.current.clear();
    deliveryRefreshTokensRef.current.clear();
    scrollAdjustRef.current = null;
    setConversation(null);
    setConversationError(null);
    setMessages([]);
    setMessagesError(null);
    setMessagesNextCursor(null);
    setMessagesNewerCursor(null);
    setMessagesHasMoreOlder(false);
    setMessagesOlderStatus('idle');
    setMessagesOlderError(null);
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

  const openConversationTarget = useCallback(
    (target: { conversationId: string; repositoryId: string }) => {
      setMode('work');
      setCreatingTask(false);
      setActivityOpen(false);
      setHistoryOpen(false);
      setSidebarOpen(false);
      if (selectedRepositoryIdRef.current !== target.repositoryId) {
        pendingOpenRef.current = target;
        setSelectedRepositoryId(target.repositoryId);
      } else {
        setSelectedConversationId(target.conversationId);
      }
    },
    [],
  );

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
      if (openConversationId && conversationMatches) {
        void loadConversation(openConversationId, true);
        if (event.type === 'message.created') {
          // New messages are caught up from the newest cursor.
          void mergeNewerMessages(openConversationId);
        } else if (event.type === 'message.delivery_changed') {
          // Delivery/read changes belong to an already loaded row; `after`
          // cannot return it, so refresh the specific message by id.
          void refreshMessage(openConversationId, event.data.messageId);
        }
      } else if (openConversationId && repositoryMatches) {
        // A task/artifact event in another conversation of this repository
        // still affects the open header and task projection.
        void loadConversation(openConversationId, true);
      }
      if (repositoryId && repositoryMatches) {
        void loadConversations(repositoryId, { silent: true });
      }

      // Browser notifications consume the same durable SSE event. Replayed
      // history older than the grace window is ignored; a recently replayed
      // event still reaches the cross-tab/cross-refresh dedupe claim.
      const category = categoryForEvent(event);
      if (category && !seenEventIdsRef.current.has(event.id)) {
        seenEventIdsRef.current.add(event.id);
        if (seenEventIdsRef.current.size > 1000) {
          const first = seenEventIdsRef.current.values().next().value;
          if (first) seenEventIdsRef.current.delete(first);
        }
        const occurredAt = Date.parse(event.occurredAt);
        const recent =
          !Number.isFinite(occurredAt) || occurredAt >= pageOpenedAtRef.current - 60_000;
        if (recent) {
          const readIds = loadActivityReadIds(me.owner.id);
          if (!readIds.has(event.id)) {
            setUnreadCount((current) => current + 1);
          }
          void deliverWebNotification({
            event,
            settings: loadNotificationSettings(me.owner.id),
            repositories: repositoriesRef.current,
            onOpen: (target) => openConversationTarget(target),
          });
        }
      }
    },
    [
      loadConversation,
      loadConversations,
      me.owner.id,
      mergeNewerMessages,
      openConversationTarget,
      refreshMessage,
    ],
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
    async (
      conversationId: string,
      text: string,
      clientMessageId: string,
      attachmentIds: string[] = [],
    ) => {
      const repositoryId = selectedRepositoryIdRef.current;
      try {
        const result = await api.sendMessage(conversationId, {
          clientMessageId,
          text,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        });
        // The API merged a Web message naming an existing GitHub requirement into
        // that imported conversation and removed the empty Web one. Only follow
        // it if the user is still looking at the conversation they sent from.
        if (result.message.conversationId !== conversationId) {
          if (selectedConversationIdRef.current === conversationId) {
            openConversation(result.message.conversationId);
          }
          if (repositoryId) void loadConversations(repositoryId, { silent: true });
          return result;
        }
        if (selectedConversationIdRef.current === conversationId) {
          await Promise.all([
            loadMessages(conversationId, true),
            loadConversation(conversationId, true),
          ]);
        }
        if (repositoryId) {
          void loadConversations(repositoryId, { silent: true });
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

  /**
   * Loads the stored review projection. `collect` asks the runtime (through the
   * API and the host supervisor) for a fresh worktree diff; plain loads only
   * read persisted artifacts, so opening the panel never runs anything.
   */
  const loadReview = useCallback(
    async (taskId: string, options: { collect?: boolean } = {}) => {
      const token = ++reviewRequestRef.current;
      setReviewStatus('loading');
      setReviewError(null);
      if (options.collect) setReviewBusy('changes');
      try {
        const result = options.collect
          ? await api.refreshTaskReview(taskId)
          : await api.taskReview(taskId);
        if (token !== reviewRequestRef.current) return;
        setReview(result.review);
        setReviewStatus('ready');
        reviewTaskRef.current = taskId;
      } catch (caught) {
        if (token !== reviewRequestRef.current) return;
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        setReviewStatus('error');
        setReviewError(describeApiError(caught));
      } finally {
        if (token === reviewRequestRef.current) {
          setReviewBusy((current) => (current === 'changes' ? null : current));
        }
      }
    },
    [onSessionLost],
  );

  const collectReviewChanges = useCallback(async () => {
    const taskId = conversation?.task?.id;
    if (!taskId || reviewBusy) return;
    await loadReview(taskId, { collect: true });
  }, [conversation?.task?.id, loadReview, reviewBusy]);

  const runReviewChecks = useCallback(async () => {
    const taskId = conversation?.task?.id;
    if (!taskId || reviewBusy) return;
    const token = ++reviewRequestRef.current;
    setReviewBusy('checks');
    setReviewError(null);
    try {
      const result = await api.runTaskChecks(taskId);
      if (token !== reviewRequestRef.current) return;
      setReview(result.review);
      setReviewStatus('ready');
    } catch (caught) {
      if (token !== reviewRequestRef.current) return;
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setReviewError(describeApiError(caught));
    } finally {
      if (token === reviewRequestRef.current) setReviewBusy(null);
    }
  }, [conversation?.task?.id, onSessionLost, reviewBusy]);

  // Load the stored review whenever the details panel opens for a task, and
  // collect once automatically when nothing has been stored yet. A task with no
  // runtime ticket simply shows the stated reason; no placeholder diff is made.
  useEffect(() => {
    const taskId = conversation?.task?.id ?? null;
    if (!detailsOpen || !taskId) {
      setReview(null);
      setReviewStatus('idle');
      setReviewError(null);
      reviewTaskRef.current = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      const token = ++reviewRequestRef.current;
      setReviewStatus('loading');
      setReviewError(null);
      try {
        const result = await api.taskReview(taskId);
        if (cancelled || token !== reviewRequestRef.current) return;
        setReview(result.review);
        setReviewStatus('ready');
        reviewTaskRef.current = taskId;
        if (
          result.review.changes.state === 'unavailable' &&
          result.review.changes.collectedAt === null &&
          conversation?.task?.upstreamTicketId
        ) {
          void loadReview(taskId, { collect: true });
        }
      } catch (caught) {
        if (cancelled || token !== reviewRequestRef.current) return;
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        setReviewStatus('error');
        setReviewError(describeApiError(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    detailsOpen,
    conversation?.task?.id,
    conversation?.task?.upstreamTicketId,
    loadReview,
    onSessionLost,
  ]);

  const runTaskCommand = useCallback(
    async (action: 'start' | 'stop' | 'resume' | 'retry') => {
      const task = conversation?.task ?? null;
      if (!task || taskCommandBusy) {
        return;
      }
      setTaskCommandBusy(true);
      setTaskCommandError(null);
      try {
        const result = await api.taskCommand(task.id, action, {
          expectedVersion: task.version,
          clientCommandId: crypto.randomUUID(),
          ...(action === 'start' ? { planRevision: (task.planRevision ?? 0) + 1 } : {}),
        });
        setConversation((current) =>
          current && current.id === result.task.conversationId
            ? { ...current, task: result.task }
            : current,
        );
        if (selectedConversationIdRef.current) {
          void loadConversation(selectedConversationIdRef.current, true);
          void loadMessages(selectedConversationIdRef.current, true);
        }
        if (selectedRepositoryIdRef.current) {
          void loadConversations(selectedRepositoryIdRef.current, { silent: true });
        }
      } catch (caught) {
        if (caught instanceof ApiClientError && caught.status === 401) {
          onSessionLost();
          return;
        }
        setTaskCommandError(describeApiError(caught));
      } finally {
        setTaskCommandBusy(false);
      }
    },
    [
      conversation?.task,
      taskCommandBusy,
      loadConversation,
      loadMessages,
      loadConversations,
      onSessionLost,
    ],
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
      // Explicit sign-out clears this owner's local drafts. A lost session keeps
      // them, so signing back in restores work in progress.
      clearOwnerDrafts(me.owner.id);
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
      void loadConversations(repositoryId, { silent: true });
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
          conversationsHasMore={conversationsHasMore}
          conversationsMoreStatus={conversationsMoreStatus}
          conversationsMoreError={conversationsMoreError}
          onLoadMoreConversations={() => void loadMoreConversations()}
          selectedConversationId={selectedConversationId}
          onSelectConversation={openConversation}
          onReloadConversations={() => {
            if (selectedRepositoryIdRef.current) {
              void loadConversations(selectedRepositoryIdRef.current);
            }
          }}
          onNewTask={startNewTask}
          onOpenAddRepository={() => {
            setAddRepositoryOpen(true);
            setSidebarOpen(false);
          }}
          onRepositoryAction={(action) => void handleRepositoryAction(action)}
          repositoryActionBusy={repositoryActionBusy}
          repositoryActionError={repositoryActionError}
          onOpenActivity={() => {
            setActivityOpen(true);
            setSidebarOpen(false);
          }}
          unreadCount={unreadCount}
          onOpenHistory={() => {
            setHistoryOpen(true);
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
                <span className={styles.topbarBadge} data-empty={unreadCount === 0}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
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

          <main ref={mainRef} id="main-content" className={styles.main} tabIndex={-1}>
            <ConversationPane
              mode={mode}
              repository={selectedRepository}
              repositories={repositories}
              conversation={conversation}
              conversationStatus={conversationStatus}
              conversationError={conversationError}
              messages={messages}
              messagesStatus={messagesStatus}
              messagesError={messagesError}
              messagesHasMoreOlder={messagesHasMoreOlder}
              messagesOlderStatus={messagesOlderStatus}
              messagesOlderError={messagesOlderError}
              onLoadOlderMessages={() => void loadOlderMessages()}
              onRetryOlderMessages={() => void loadOlderMessages()}
              progress={progress}
              creatingTask={creatingTask}
              taskCommandBusy={taskCommandBusy}
              taskCommandError={taskCommandError}
              onTaskCommand={runTaskCommand}
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
            ownerId={me.owner.id}
            onSend={sendMessage}
          />
        </div>

        <DetailsPanel
          open={detailsOpen}
          repository={selectedRepository}
          conversation={conversation}
          review={review}
          reviewStatus={reviewStatus}
          reviewError={reviewError}
          reviewBusy={reviewBusy}
          onRefreshChanges={collectReviewChanges}
          onRunChecks={runReviewChecks}
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

      {activityOpen ? (
        <ActivityDialog
          ownerId={me.owner.id}
          onClose={() => setActivityOpen(false)}
          onOpenConversation={openConversationTarget}
          onUnreadChange={setUnreadCount}
          onSessionLost={onSessionLost}
        />
      ) : null}

      {historyOpen ? (
        <HistoryDialog
          repositories={repositories}
          initialRepositoryId={selectedRepositoryId}
          onClose={() => setHistoryOpen(false)}
          onOpenConversation={openConversationTarget}
          onSessionLost={onSessionLost}
        />
      ) : null}

      {addRepositoryOpen ? (
        <AddRepositoryDialog
          onClose={() => setAddRepositoryOpen(false)}
          onAdded={async (repositoryId) => {
            await loadRepositories();
            setSelectedRepositoryId(repositoryId);
          }}
        />
      ) : null}
    </div>
  );
}
