import { useEffect, useRef, useState } from 'react';

import type { ConversationSummary, CreateMessageData, RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import { ApiClientError } from '../lib/api';
import {
  consumeDraftNotice,
  draftForSend,
  loadDraft,
  markDraftNotice,
  migrateDraftToConversation,
  removeDraft,
  saveDraft,
  type Draft,
} from '../lib/drafts';
import { describeApiError } from '../lib/errors';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';

interface ComposerProps {
  mode: Mode;
  repository: RepositorySummary | null;
  conversation: ConversationSummary | null;
  conversationLoading: boolean;
  ownerId: string;
  /**
   * Sends to the conversation that was open when the user pressed send, not to
   * whatever happens to be selected when the request finishes.
   */
  onSend: (
    conversationId: string,
    text: string,
    clientMessageId: string,
  ) => Promise<CreateMessageData>;
}

export function Composer({
  mode,
  repository,
  conversation,
  conversationLoading,
  ownerId,
  onSend,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [sendingFor, setSendingFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef<Draft | null>(null);
  const conversationIdRef = useRef<string | null>(conversation?.id ?? null);
  const repositoryIdRef = useRef<string | null>(repository?.id ?? null);
  conversationIdRef.current = conversation?.id ?? null;
  repositoryIdRef.current = repository?.id ?? null;

  const terminal =
    conversation?.task?.state === 'completed' ||
    conversation?.task?.state === 'closed_unmerged' ||
    conversation?.task?.state === 'not_accepted';
  const sending = conversation?.id != null && sendingFor === conversation.id;
  const disabled = mode !== 'work' || !conversation || conversationLoading || terminal;
  const pendingDraft =
    draftRef.current?.pending && draftRef.current.text === text.trim()
      ? draftRef.current.pending
      : null;

  useEffect(() => {
    const conversationId = conversation?.id;
    const repositoryId = repository?.id;
    setError(null);
    setNotice(null);
    if (!conversationId || !repositoryId) {
      draftRef.current = null;
      setText('');
      return;
    }
    const stored = loadDraft(ownerId, repositoryId, conversationId);
    draftRef.current = stored;
    setText(stored?.text ?? '');
    const migrationNotice = consumeDraftNotice(ownerId, repositoryId, conversationId);
    if (migrationNotice) {
      setNotice(migrationNotice);
    } else if (stored?.pending) {
      setNotice(
        stored.pending.ambiguous
          ? '上次发送结果未确认。保留原文重试会复用同一标识核对结果，不会重复写入。'
          : '上次发送失败，草稿与幂等标识已保留；重试会复用同一标识。',
      );
    }
  }, [conversation?.id, repository?.id, ownerId]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [text]);

  const placeholder =
    mode === 'chat'
      ? 'Chat 尚未接入，输入区当前不可发送'
      : !repository
        ? '先在左侧选择一个仓库'
        : !conversation
          ? '选择或新建任务后可以发送消息'
          : '输入任务或回复，Enter 发送，Shift+Enter 换行';

  const hint =
    mode === 'chat'
      ? 'Chat 接口在后续阶段接入'
      : terminal
        ? '任务已结束；请新建关联任务或显式恢复已停止的任务'
        : conversation?.task?.state === 'stopped'
          ? '任务已停止：新消息会先保存，继续后按顺序投递'
          : conversation?.task?.state === 'waiting_input'
            ? '等待回复：发送内容会作为任务答复'
            : conversation
              ? '消息按投递证据更新，不提前显示已读取'
              : '消息输入区未启用';

  function updateText(next: string) {
    setText(next);
    setStorageWarning(null);
    const conversationId = conversationIdRef.current;
    const repositoryId = repositoryIdRef.current;
    if (!conversationId || !repositoryId) {
      return;
    }
    if (next.trim().length === 0) {
      removeDraft(ownerId, repositoryId, conversationId);
      draftRef.current = null;
      return;
    }
    const base = draftRef.current;
    if (base && base.text === next) {
      return;
    }
    const draft: Draft = {
      version: (base?.version ?? 0) + 1,
      text: next,
      updatedAt: new Date().toISOString(),
      // Keep the idempotency id only while the text is unchanged; a different
      // text is a different message and must not share it.
      pending: base?.pending && base.pending.text === next ? base.pending : null,
    };
    draftRef.current = draft;
    if (!saveDraft(ownerId, repositoryId, conversationId, draft)) {
      setStorageWarning('浏览器无法保存本地草稿；当前输入仍保留在本页面，发送不受影响。');
    }
  }

  function clearDraft() {
    const conversationId = conversationIdRef.current;
    const repositoryId = repositoryIdRef.current;
    if (conversationId && repositoryId) {
      removeDraft(ownerId, repositoryId, conversationId);
    }
    draftRef.current = null;
    setText('');
    setError(null);
    setNotice(null);
  }

  async function submit() {
    const trimmed = text.trim();
    const conversationId = conversationIdRef.current;
    const repositoryId = repositoryIdRef.current;
    if (!trimmed || !conversationId || !repositoryId || sending || disabled) {
      return;
    }

    const prepared = draftForSend(ownerId, repositoryId, conversationId, trimmed);
    const pending = prepared.pending;
    const clientMessageId = pending?.clientMessageId ?? crypto.randomUUID();
    const draft: Draft = {
      ...prepared,
      pending: {
        clientMessageId,
        text: trimmed,
        version: prepared.version,
        at: new Date().toISOString(),
      },
    };
    draftRef.current = draft;
    if (!saveDraft(ownerId, repositoryId, conversationId, draft)) {
      setStorageWarning('浏览器无法保存本地草稿；当前输入仍保留在本页面，发送不受影响。');
    }

    setSendingFor(conversationId);
    setError(null);
    setNotice(null);
    try {
      const result = await onSend(conversationId, trimmed, clientMessageId);
      // Reconcile only the exact draft version this request submitted. An edit
      // made while it was in flight keeps the newer text.
      const current = loadDraft(ownerId, repositoryId, conversationId);
      const sentVersionMatches =
        !current || (current.version === draft.version && current.text === draft.text);
      const targetConversationId = result.message.conversationId;
      if (targetConversationId !== conversationId) {
        // The API merged this Web conversation into an imported GitHub one.
        // The source is now a hidden alias, so a newer draft must move to the
        // target; an existing target draft is joined, never overwritten.
        if (sentVersionMatches) {
          removeDraft(ownerId, repositoryId, conversationId);
        } else {
          const migrated = migrateDraftToConversation(
            ownerId,
            repositoryId,
            conversationId,
            targetConversationId,
          );
          if (migrated && current && current.text.trim().length > 0) {
            const migrationText =
              '消息已合并到关联会话；原会话草稿已迁移到这里，未发送内容没有丢失。';
            markDraftNotice(ownerId, repositoryId, targetConversationId, migrationText);
            if (conversationIdRef.current === targetConversationId) {
              // Navigation already landed on the target before this response;
              // apply the migrated draft now instead of waiting for a switch.
              consumeDraftNotice(ownerId, repositoryId, targetConversationId);
              draftRef.current = migrated;
              setText(migrated.text);
              setNotice(migrationText);
            }
          }
        }
        if (conversationIdRef.current === conversationId) {
          // The merge navigation is about to replace this conversation.
          draftRef.current = null;
          setText('');
        }
      } else if (sentVersionMatches) {
        removeDraft(ownerId, repositoryId, conversationId);
        if (conversationIdRef.current === conversationId) {
          draftRef.current = null;
          setText('');
        }
      } else {
        const kept: Draft = {
          ...current,
          pending:
            current.pending && current.pending.clientMessageId !== clientMessageId
              ? current.pending
              : null,
        };
        saveDraft(ownerId, repositoryId, conversationId, kept);
        if (conversationIdRef.current === conversationId) {
          draftRef.current = kept;
        }
      }
      if (conversationIdRef.current === conversationId && targetConversationId === conversationId) {
        setNotice(result.duplicate ? '这条消息此前已提交，已按原标识核对并刷新会话。' : null);
      }
    } catch (caught) {
      const ambiguous = !(caught instanceof ApiClientError);
      const current = loadDraft(ownerId, repositoryId, conversationId);
      if (current) {
        const kept: Draft = {
          ...current,
          pending: current.pending
            ? { ...current.pending, ambiguous }
            : {
                clientMessageId,
                text: trimmed,
                version: draft.version,
                at: new Date().toISOString(),
                ambiguous,
              },
        };
        saveDraft(ownerId, repositoryId, conversationId, kept);
        if (conversationIdRef.current === conversationId) {
          draftRef.current = kept;
        }
      }
      if (conversationIdRef.current === conversationId) {
        setError(
          ambiguous
            ? `${describeApiError(caught)} 网络结果不明确：可直接重试，重试会复用同一标识核对结果，不会重复写入或执行。`
            : `${describeApiError(caught)} 草稿与幂等标识已保留，可直接重试。`,
        );
      }
    } finally {
      setSendingFor(null);
    }
  }

  return (
    <div className={styles.composerWrap}>
      <div className={styles.composer}>
        <textarea
          ref={textareaRef}
          className={styles.composerInput}
          placeholder={placeholder}
          rows={1}
          value={text}
          disabled={disabled}
          aria-label={disabled ? '消息输入区（当前不可发送）' : '消息输入区'}
          onChange={(event) => updateText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {error ? (
          <p className={styles.composerStatus} data-kind="error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className={styles.composerStatus} data-kind="notice">
            {notice}
          </p>
        ) : null}
        {pendingDraft ? (
          <p className={styles.composerStatus} data-kind="pending">
            发送结果待确认：按原标识重试不会重复写入。
          </p>
        ) : null}
        {storageWarning ? (
          <p className={styles.composerStatus} data-kind="notice">
            {storageWarning}
          </p>
        ) : null}
        <div className={styles.composerFooter}>
          <span className={styles.composerHint}>
            <Icon name="session" size={13} /> {hint}
          </span>
          <div className={styles.composerActions}>
            {text.trim().length > 0 && !sending ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={clearDraft}
                title="清除当前会话的本地草稿"
              >
                清除草稿
              </button>
            ) : null}
            <button
              type="button"
              className={styles.sendButton}
              disabled={disabled || sending || text.trim().length === 0}
              onClick={() => void submit()}
              title={disabled ? placeholder : '发送消息'}
            >
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
