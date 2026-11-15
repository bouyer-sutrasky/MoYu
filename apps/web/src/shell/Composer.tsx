import { useEffect, useRef, useState } from 'react';

import {
  attachmentLimits,
  type ConversationSummary,
  type CreateMessageData,
  type RepositorySummary,
} from '@moyu/contracts';

import { Icon } from '../components/Icon';
import { api, ApiClientError } from '../lib/api';
import {
  consumeDraftNotice,
  draftForSend,
  loadDraft,
  markDraftNotice,
  migrateSentDraftToConversation,
  newLineageId,
  removeDraft,
  restoreDeferredDraft,
  restoreParkedDraft,
  restorePendingDraft,
  saveDraft,
  settleSuccessfulSend,
  type Draft,
} from '../lib/drafts';
import { describeApiError } from '../lib/errors';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';

/**
 * Attachment selections belong to one owner + repository + conversation, and a
 * bucket version invalidates responses that started against an older state. A
 * late upload from conversation A must never touch what B renders or sends.
 */
interface AttachmentBucket {
  files: File[];
  /** Attachment ids already uploaded for this bucket, reusable by a retry. */
  uploaded: { key: string; id: string }[];
  error: string | null;
  uploading: boolean;
}

const EMPTY_ATTACHMENTS: AttachmentBucket = {
  files: [],
  uploaded: [],
  error: null,
  uploading: false,
};

function attachmentScopeKey(ownerId: string, repositoryId: string, conversationId: string): string {
  return `${ownerId}\u0000${repositoryId}\u0000${conversationId}`;
}

function attachmentFileKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

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
    attachmentIds: string[],
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
  const [sendingConversations, setSendingConversations] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [attachmentBuckets, setAttachmentBuckets] = useState<Record<string, AttachmentBucket>>({});
  const attachmentVersionsRef = useRef<Map<string, number>>(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<Draft | null>(null);
  const conversationIdRef = useRef<string | null>(conversation?.id ?? null);
  const repositoryIdRef = useRef<string | null>(repository?.id ?? null);
  /** Distinct request identity per conversation: a late finally cannot unlock a newer send. */
  const activeSendsRef = useRef<Map<string, number>>(new Map());
  const sendSequenceRef = useRef(0);
  conversationIdRef.current = conversation?.id ?? null;
  repositoryIdRef.current = repository?.id ?? null;
  const attachmentScope =
    conversation && repository ? attachmentScopeKey(ownerId, repository.id, conversation.id) : null;
  const attachmentBucket = attachmentScope
    ? (attachmentBuckets[attachmentScope] ?? EMPTY_ATTACHMENTS)
    : EMPTY_ATTACHMENTS;
  const files = attachmentBucket.files;
  const uploading = attachmentBucket.uploading;
  const attachmentError = attachmentBucket.error;

  const terminal =
    conversation?.task?.state === 'completed' ||
    conversation?.task?.state === 'closed_unmerged' ||
    conversation?.task?.state === 'not_accepted';
  const sending = conversation?.id != null && sendingConversations.has(conversation.id);
  const disabled = mode !== 'work' || !conversation || conversationLoading || terminal;
  // Read the persisted draft during render: a parked-only draft has empty
  // text, so setting draftRef in an effect may not otherwise trigger a render.
  const draft =
    conversation && repository
      ? loadDraft(ownerId, repository.id, conversation.id)
      : draftRef.current;
  const pendingDraft = draft?.pending ?? null;
  const pendingTextMismatch = pendingDraft !== null && pendingDraft.text.trim() !== text.trim();
  const deferredText = draft?.deferredText ?? null;
  const parkedDrafts = draft?.parked ?? [];

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
    const pendingNotice = stored?.pending
      ? stored.pending.ambiguous
        ? '上次发送结果未确认。保留原文重试会复用同一标识核对结果，不会重复写入。'
        : '上次发送结果待确认。按原标识重试不会重复写入。'
      : null;
    const deferredNotice = stored?.deferredText
      ? stored.pending
        ? '合并来源的未发送内容已单独保留；确认上一条发送后可恢复。'
        : '合并来源的未发送内容已保留，可点“恢复合并草稿”恢复。'
      : null;
    setNotice(
      migrationNotice ?? ([pendingNotice, deferredNotice].filter(Boolean).join(' ') || null),
    );
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

  function attachmentVersion(scope: string): number {
    return attachmentVersionsRef.current.get(scope) ?? 0;
  }

  /** A user edit of this conversation's attachments: bumps the bucket version. */
  function changeAttachments(
    scope: string,
    change: (bucket: AttachmentBucket) => AttachmentBucket,
  ): void {
    attachmentVersionsRef.current.set(scope, attachmentVersion(scope) + 1);
    setAttachmentBuckets((current) => ({
      ...current,
      [scope]: change(current[scope] ?? EMPTY_ATTACHMENTS),
    }));
  }

  /** Applies a response only while the bucket still has the version it started with. */
  function settleAttachments(
    scope: string,
    version: number,
    change: (bucket: AttachmentBucket) => AttachmentBucket,
  ): void {
    if (attachmentVersion(scope) !== version) {
      return;
    }
    setAttachmentBuckets((current) => {
      if (attachmentVersion(scope) !== version) {
        return current;
      }
      return { ...current, [scope]: change(current[scope] ?? EMPTY_ATTACHMENTS) };
    });
  }

  /** Progress flags belong to the bucket, not to whatever conversation is open now. */
  function patchAttachments(scope: string, patch: Partial<AttachmentBucket>): void {
    setAttachmentBuckets((current) => ({
      ...current,
      [scope]: { ...(current[scope] ?? EMPTY_ATTACHMENTS), ...patch },
    }));
  }

  function addSending(conversationId: string, token: number): void {
    activeSendsRef.current.set(conversationId, token);
    setSendingConversations((current) => {
      const next = new Set(current);
      next.add(conversationId);
      return next;
    });
  }

  function settleSending(conversationId: string, token: number): void {
    if (activeSendsRef.current.get(conversationId) !== token) {
      return;
    }
    activeSendsRef.current.delete(conversationId);
    setSendingConversations((current) => {
      if (!current.has(conversationId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  }

  function updateText(next: string): void {
    setText(next);
    setStorageWarning(null);
    const conversationId = conversationIdRef.current;
    const repositoryId = repositoryIdRef.current;
    if (!conversationId || !repositoryId) {
      return;
    }
    if (next.trim().length === 0) {
      // Clearing drops the lineage. Retyping the same text later is a new
      // draft and an old response cannot settle against it.
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
      // Editing keeps the lineage; clearing (above) is what starts a new one.
      lineageId: base?.lineageId ?? newLineageId(),
      text: next,
      updatedAt: new Date().toISOString(),
      // Keep the send snapshot while the user edits: only its own response may
      // settle it, and a retry must still use its original key.
      pending: base?.pending ?? null,
      ...(base?.deferredText ? { deferredText: base.deferredText } : {}),
      ...(base?.parked ? { parked: base.parked } : {}),
    };
    draftRef.current = draft;
    if (!saveDraft(ownerId, repositoryId, conversationId, draft)) {
      setStorageWarning('浏览器无法保存本地草稿；当前输入仍保留在本页面，发送不受影响。');
    }
  }

  function clearDraft(): void {
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

  function restorePending(): void {
    const conversationId = conversationIdRef.current;
    const repositoryId = repositoryIdRef.current;
    if (!conversationId || !repositoryId) {
      return;
    }
    const restored = restorePendingDraft(ownerId, repositoryId, conversationId);
    if (!restored) {
      return;
    }
    draftRef.current = restored;
    setText(restored.text);
    setError(null);
    setNotice('已恢复待确认内容；再次发送会复用原标识核对结果。');
  }

  function restoreDeferred(): void {
    const conversationId = conversationIdRef.current;
    const repositoryId = repositoryIdRef.current;
    if (!conversationId || !repositoryId) {
      return;
    }
    const restored = restoreDeferredDraft(ownerId, repositoryId, conversationId);
    if (!restored) {
      return;
    }
    draftRef.current = restored;
    setText(restored.text);
    setError(null);
    setNotice('已恢复合并会话保留下来的未发送草稿。');
  }

  function restoreParked(parkedId: string): void {
    const conversationId = conversationIdRef.current;
    const repositoryId = repositoryIdRef.current;
    if (!conversationId || !repositoryId) {
      return;
    }
    if (draftRef.current?.pending) {
      setError('请先核对当前会话的待确认发送，再恢复合并来源的草稿。');
      return;
    }
    const restored = restoreParkedDraft(ownerId, repositoryId, conversationId, parkedId);
    if (!restored) {
      return;
    }
    draftRef.current = restored;
    setText(restored.text);
    setError(null);
    setNotice('已恢复合并来源的未确认发送；再次发送会复用其原标识核对结果。');
  }

  const ATTACHMENT_ACCEPT = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    '.txt',
    '.log',
    '.md',
    '.json',
    '.yml',
    '.yaml',
    '.csv',
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.cjs',
    '.css',
    '.html',
    '.sql',
    '.toml',
    '.ini',
    '.conf',
    '.sh',
    '.py',
    '.go',
    '.rs',
    '.java',
  ].join(',');

  function addFiles(selected: FileList | null): void {
    if (!selected || selected.length === 0) {
      return;
    }
    if (!attachmentScope) {
      return;
    }
    const next = [...attachmentBucket.files];
    const problems: string[] = [];
    for (const file of Array.from(selected)) {
      if (next.length >= attachmentLimits.maxFilesPerMessage) {
        problems.push(`最多 ${attachmentLimits.maxFilesPerMessage} 个附件`);
        break;
      }
      if (file.size > attachmentLimits.maxFileBytes) {
        problems.push(
          `${file.name} 超过 ${Math.floor(attachmentLimits.maxFileBytes / (1024 * 1024))} MiB`,
        );
        continue;
      }
      if (file.size === 0) {
        problems.push(`${file.name} 是空文件`);
        continue;
      }
      if (next.some((item) => item.name === file.name && item.size === file.size)) {
        continue;
      }
      next.push(file);
    }
    changeAttachments(attachmentScope, (bucket) => ({
      ...bucket,
      files: next,
      error: problems.length > 0 ? problems.join('；') : null,
    }));
    if (fileRef.current) {
      fileRef.current.value = '';
    }
  }

  function removeFile(index: number): void {
    if (!attachmentScope) {
      return;
    }
    changeAttachments(attachmentScope, (bucket) => {
      const removed = bucket.files[index];
      return {
        ...bucket,
        files: bucket.files.filter((_, position) => position !== index),
        uploaded: removed
          ? bucket.uploaded.filter((entry) => entry.key !== attachmentFileKey(removed))
          : bucket.uploaded,
        error: null,
      };
    });
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  async function submit(): Promise<void> {
    const trimmed = text.trim();
    const conversationId = conversationIdRef.current;
    const repositoryId = repositoryIdRef.current;
    const scope = attachmentScope;
    if (!trimmed || !conversationId || !repositoryId || !scope || disabled) {
      return;
    }
    if (attachmentBucket.uploading) {
      return;
    }
    // Per-conversation request identity, not a single global flag: a late
    // finally from conversation A must not unlock B or allow a second A send.
    if (activeSendsRef.current.has(conversationId)) {
      return;
    }
    const previous = loadDraft(ownerId, repositoryId, conversationId);
    if (previous?.pending && previous.pending.text !== trimmed) {
      setError('上一条发送结果待确认：请先恢复待确认内容并按原标识核对，避免重复写入。');
      return;
    }

    const prepared = draftForSend(ownerId, repositoryId, conversationId, trimmed);
    const clientMessageId = prepared.pending?.clientMessageId ?? crypto.randomUUID();
    const draft: Draft = {
      ...prepared,
      pending: prepared.pending ?? {
        clientMessageId,
        text: trimmed,
        version: prepared.version,
        lineageId: prepared.lineageId,
        at: new Date().toISOString(),
      },
    };
    draftRef.current = draft;
    if (!saveDraft(ownerId, repositoryId, conversationId, draft)) {
      setStorageWarning('浏览器无法保存本地草稿；当前输入仍保留在本页面，发送不受影响。');
    }

    // The files, the upload target and the message all come from the bucket of
    // the conversation that was open when send was pressed. A response that
    // arrives after a conversation switch can only settle that same bucket.
    const attachmentVersionAtSend = attachmentVersion(scope);
    const filesToSend = attachmentBucket.files;
    const uploadedAtSend = attachmentBucket.uploaded;
    const attachmentIds: string[] = [];
    if (filesToSend.length > 0) {
      patchAttachments(scope, { uploading: true, error: null });
      try {
        for (const file of filesToSend) {
          const key = attachmentFileKey(file);
          const existing = uploadedAtSend.find((entry) => entry.key === key);
          if (existing) {
            // A retry reuses the id already uploaded for this file.
            attachmentIds.push(existing.id);
            continue;
          }
          const uploaded = await api.uploadAttachment(conversationId, file);
          attachmentIds.push(uploaded.attachment.id);
          settleAttachments(scope, attachmentVersionAtSend, (bucket) =>
            bucket.uploaded.some((entry) => entry.key === key)
              ? bucket
              : {
                  ...bucket,
                  uploaded: [...bucket.uploaded, { key, id: uploaded.attachment.id }],
                },
          );
        }
      } catch (caught) {
        patchAttachments(scope, { uploading: false });
        settleAttachments(scope, attachmentVersionAtSend, (bucket) => ({
          ...bucket,
          error: `附件上传失败：${describeApiError(caught)}`,
        }));
        return;
      }
      patchAttachments(scope, { uploading: false });
    }

    const token = ++sendSequenceRef.current;
    addSending(conversationId, token);
    setError(null);
    setNotice(null);
    try {
      const result = await onSend(conversationId, trimmed, clientMessageId, attachmentIds);
      // The message was sent with exactly these files; remove them from their
      // own conversation bucket even when another conversation is open now.
      const sentKeys = new Set(filesToSend.map(attachmentFileKey));
      changeAttachments(scope, (bucket) => ({
        ...bucket,
        files: bucket.files.filter((file) => !filesToSend.includes(file)),
        uploaded: bucket.uploaded.filter((entry) => !sentKeys.has(entry.key)),
        error: null,
      }));
      const targetConversationId = result.message.conversationId;
      if (targetConversationId !== conversationId) {
        // The API merged this Web conversation into an imported GitHub one.
        // The source is now a hidden alias, so only unsent source content may
        // move to the target; the target's own pending send is never touched.
        const migration = migrateSentDraftToConversation(
          ownerId,
          repositoryId,
          conversationId,
          targetConversationId,
          {
            clientMessageId,
            text: draft.text.trim(),
            lineageId: draft.lineageId,
          },
        );
        if (migration.moved && migration.draft) {
          const migrationText = migration.deferred
            ? '消息已合并；目标会话有发送待确认，合并草稿已单独保留，确认后可恢复。'
            : '消息已合并到关联会话；原会话草稿已迁移到这里，未发送内容没有丢失。';
          markDraftNotice(ownerId, repositoryId, targetConversationId, migrationText);
          if (conversationIdRef.current === targetConversationId) {
            consumeDraftNotice(ownerId, repositoryId, targetConversationId);
            draftRef.current = migration.draft;
            setText(migration.draft.text);
            setNotice(migrationText);
          }
        }
        if (conversationIdRef.current === conversationId) {
          // The merge navigation is about to replace this conversation.
          draftRef.current = null;
          setText('');
        }
      } else {
        const settled = settleSuccessfulSend(
          ownerId,
          repositoryId,
          conversationId,
          clientMessageId,
        );
        if (conversationIdRef.current === conversationId) {
          draftRef.current = settled.draft;
          setText(settled.draft?.text ?? '');
          setNotice(
            settled.promoted
              ? '上一条已发送；合并保留的未发送草稿已恢复。'
              : result.duplicate
                ? '这条消息此前已提交，已按原标识核对并刷新会话。'
                : null,
          );
        }
      }
    } catch (caught) {
      const ambiguous = !(caught instanceof ApiClientError);
      const current = loadDraft(ownerId, repositoryId, conversationId);
      let kept = current;
      if (current && current.lineageId === draft.lineageId) {
        const pending =
          current.pending?.clientMessageId === clientMessageId
            ? { ...current.pending, ambiguous }
            : (current.pending ?? {
                clientMessageId,
                text: draft.text,
                version: draft.version,
                lineageId: draft.lineageId,
                at: new Date().toISOString(),
                ambiguous,
              });
        kept = { ...current, pending };
        saveDraft(ownerId, repositoryId, conversationId, kept);
        if (conversationIdRef.current === conversationId) {
          draftRef.current = kept;
        }
      }
      if (conversationIdRef.current === conversationId) {
        if (!kept) {
          // The user cleared the input while this request was in flight.
          setError('发送失败；输入已清除，没有恢复旧草稿。');
        } else if (kept.lineageId !== draft.lineageId) {
          setError('旧发送失败；当前会话已有新草稿，本次失败没有改动它。');
        } else {
          setError(
            ambiguous
              ? `${describeApiError(caught)} 网络结果不明确：可先恢复待确认内容，按原标识重试不会重复写入。`
              : `${describeApiError(caught)} 草稿与幂等标识已保留，可直接重试。`,
          );
        }
      }
    } finally {
      settleSending(conversationId, token);
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
        <div className={styles.composerAttachments}>
          <input
            ref={fileRef}
            className={styles.composerFileInput}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            onChange={(event) => addFiles(event.target.files)}
            aria-label="选择附件"
          />
          <button
            type="button"
            className={styles.textButton}
            onClick={() => fileRef.current?.click()}
            disabled={disabled || uploading || files.length >= attachmentLimits.maxFilesPerMessage}
            title="添加截图、日志或文本文件"
          >
            <Icon name="plus" size={13} /> 附件
          </button>
          {files.map((file, index) => (
            <span className={styles.attachmentChip} key={`${file.name}-${file.size}-${index}`}>
              {file.name}
              <span className={styles.attachmentSize}>{formatFileSize(file.size)}</span>
              <button
                type="button"
                className={styles.attachmentRemove}
                onClick={() => removeFile(index)}
                disabled={uploading}
                aria-label={`移除附件 ${file.name}`}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          {uploading ? (
            <span className={styles.attachmentSize}>正在上传…</span>
          ) : files.length > 0 ? (
            <span className={styles.attachmentSize}>发送时上传</span>
          ) : null}
        </div>
        {attachmentError ? (
          <p className={styles.composerStatus} data-kind="error" role="alert">
            {attachmentError}
          </p>
        ) : null}
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
            {pendingTextMismatch
              ? '上一条发送结果待确认；当前输入是新草稿，先恢复待确认内容按原标识核对。'
              : '发送结果待确认：按原标识重试不会重复写入。'}
          </p>
        ) : null}
        {deferredText ? (
          <p className={styles.composerStatus} data-kind="pending">
            {pendingDraft
              ? '合并来源的未发送内容已单独保留；上一条确认后可恢复。'
              : '合并来源的未发送内容已保留；可点“恢复合并草稿”。'}
          </p>
        ) : null}
        {parkedDrafts.map((parked) => (
          <p className={styles.composerStatus} data-kind="pending" key={parked.id}>
            合并来源还有未确认发送：{parked.text.slice(0, 40)}
            <button
              type="button"
              className={styles.textButton}
              onClick={() => restoreParked(parked.id)}
              disabled={Boolean(pendingDraft)}
              title={pendingDraft ? '先核对当前会话的待确认发送' : '恢复此草稿并按原标识核对'}
            >
              恢复此草稿
            </button>
          </p>
        ))}
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
            {pendingDraft && pendingTextMismatch ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={restorePending}
                title="把输入恢复为待确认发送的原文"
              >
                恢复待确认内容
              </button>
            ) : null}
            {deferredText && !pendingDraft ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={restoreDeferred}
                title="把合并会话保留下来的未发送草稿加入输入"
              >
                恢复合并草稿
              </button>
            ) : null}
            {text.trim().length > 0 || pendingDraft || deferredText || parkedDrafts.length > 0 ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={clearDraft}
                title="清除当前会话的本地草稿"
                disabled={sending}
              >
                清除草稿
              </button>
            ) : null}
            <button
              type="button"
              className={styles.sendButton}
              disabled={disabled || sending || text.trim().length === 0 || pendingTextMismatch}
              onClick={() => void submit()}
              title={
                pendingTextMismatch
                  ? '先恢复待确认内容并按原标识核对'
                  : disabled
                    ? placeholder
                    : '发送消息'
              }
            >
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
