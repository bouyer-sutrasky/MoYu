import { useEffect, useRef, useState } from 'react';

import type { ConversationSummary, CreateMessageData, RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import { describeApiError } from '../lib/errors';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';

interface ComposerProps {
  mode: Mode;
  repository: RepositorySummary | null;
  conversation: ConversationSummary | null;
  conversationLoading: boolean;
  onSend: (text: string, clientMessageId: string) => Promise<CreateMessageData>;
}

interface PendingMessage {
  conversationId: string;
  id: string;
  text: string;
}

export function Composer({
  mode,
  repository,
  conversation,
  conversationLoading,
  onSend,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingRef = useRef<PendingMessage | null>(null);

  const terminal =
    conversation?.task?.state === 'completed' ||
    conversation?.task?.state === 'closed_unmerged' ||
    conversation?.task?.state === 'not_accepted';
  const disabled = mode !== 'work' || !conversation || conversationLoading || terminal;

  useEffect(() => {
    pendingRef.current = null;
    setError(null);
    setNotice(null);
  }, [conversation?.id]);

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

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || !conversation || sending || disabled) {
      return;
    }

    let pending = pendingRef.current;
    if (!pending || pending.text !== trimmed || pending.conversationId !== conversation.id) {
      pending = {
        conversationId: conversation.id,
        id: crypto.randomUUID(),
        text: trimmed,
      };
      pendingRef.current = pending;
    }

    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await onSend(trimmed, pending.id);
      pendingRef.current = null;
      setText('');
      setNotice(result.duplicate ? '这条消息此前已提交，已刷新会话。' : null);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setSending(false);
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
          onChange={(event) => setText(event.target.value)}
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
        <div className={styles.composerFooter}>
          <span>
            <Icon name="session" size={13} /> {hint}
          </span>
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
  );
}
