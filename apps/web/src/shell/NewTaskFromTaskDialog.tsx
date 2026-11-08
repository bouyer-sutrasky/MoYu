import { useEffect, useRef, useState } from 'react';

import type {
  ConversationSummary,
  NewTaskFromTaskPreviewData,
  RepositorySummary,
} from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeApiError } from '../lib/errors';
import styles from './WorkspaceShell.module.css';

interface NewTaskFromTaskDialogProps {
  taskId: string;
  repositories: RepositorySummary[];
  onCancel: () => void;
  onCreated: (conversation: ConversationSummary) => void;
  onSessionLost: () => void;
}

type PreviewStatus = 'loading' | 'ready' | 'error';

/**
 * Creates a fresh task from a finished one. The source facts are shown and
 * stored explicitly, but the new task gets its own conversation and task: the
 * old worktree, session and PR are never reused or reopened. The owner must
 * confirm the target repository and start point before the POST is sent.
 */
export function NewTaskFromTaskDialog({
  taskId,
  repositories,
  onCancel,
  onCreated,
  onSessionLost,
}: NewTaskFromTaskDialogProps) {
  const [status, setStatus] = useState<PreviewStatus>('loading');
  const [preview, setPreview] = useState<NewTaskFromTaskPreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetRepositoryId, setTargetRepositoryId] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [baseCommit, setBaseCommit] = useState('');
  const [busy, setBusy] = useState(false);
  // One id per opened dialog: a double click reuses it and the server keeps one task.
  const clientRequestId = useRef(
    typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}`,
  );

  useEffect(() => {
    let cancelled = false;
    api
      .newTaskFromTaskPreview(taskId)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        setTargetRepositoryId(data.suggestedTarget.repositoryId);
        setBaseBranch(data.suggestedTarget.baseBranch);
        setBaseCommit(data.suggestedTarget.baseCommit ?? '');
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiClientError && cause.status === 401) {
          onSessionLost();
          return;
        }
        setError(describeApiError(cause));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, onSessionLost]);

  const chooseRepository = (repositoryId: string) => {
    setTargetRepositoryId(repositoryId);
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) return;
    // A different repository cannot inherit the source commit; its own default branch is the start point.
    setBaseBranch(repository.defaultBranch);
    setBaseCommit(
      repositoryId === preview?.suggestedTarget.repositoryId
        ? (preview.suggestedTarget.baseCommit ?? '')
        : '',
    );
  };

  const create = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createTaskFromTask(taskId, {
        repositoryId: targetRepositoryId,
        baseBranch,
        baseCommit: baseCommit.trim() ? baseCommit.trim() : null,
        clientRequestId: clientRequestId.current,
        confirmed: true,
      });
      onCreated(result.conversation);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status === 401) {
        onSessionLost();
        return;
      }
      setError(describeApiError(cause));
      setBusy(false);
    }
  };

  const inheritance = preview?.inheritance;
  return (
    <div className={styles.dialogBackdrop} role="presentation">
      <section
        className={styles.dialogPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-from-task-title"
        data-testid="new-task-from-task-dialog"
      >
        <header className={styles.dialogHeader}>
          <h2 id="new-task-from-task-title">基于此任务新建</h2>
          <button type="button" className={styles.dialogClose} onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </header>
        {status === 'loading' ? <p>正在读取原任务…</p> : null}
        {status === 'error' ? <p className={styles.formError}>{error}</p> : null}
        {inheritance ? (
          <div className={styles.newTaskSource} data-testid="new-task-source">
            <p>
              新任务会关联原任务 <code>{inheritance.fromTaskId}</code>
              ，但拥有独立的会话、任务与执行身份。
            </p>
            <ul className={styles.newTaskFacts}>
              <li>
                原 PR：
                {inheritance.pullRequest ? (
                  <a href={inheritance.pullRequest.url} target="_blank" rel="noopener noreferrer">
                    {inheritance.pullRequest.url}
                  </a>
                ) : (
                  '无'
                )}
              </li>
              <li>交付摘要：{inheritance.deliverySummary ?? '无'}</li>
              <li>
                原起点：{inheritance.baseBranch}@{inheritance.baseCommit ?? '最新'}
              </li>
            </ul>
            <p className={styles.newTaskWarning}>{inheritance.worktreeNote}</p>
            <p className={styles.newTaskWarning}>{inheritance.recoveryNote}</p>
            <p className={styles.newTaskBadges}>
              <span>不会重开原 PR</span>
              <span>不是原现场恢复</span>
              <span>独立执行身份</span>
            </p>
          </div>
        ) : null}
        {status === 'ready' ? (
          <form
            className={styles.newTaskForm}
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label>
              目标仓库（创建前确认）
              <select
                value={targetRepositoryId}
                onChange={(event) => chooseRepository(event.target.value)}
                data-testid="new-task-repository"
              >
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              起点分支
              <input
                value={baseBranch}
                onChange={(event) => setBaseBranch(event.target.value)}
                required
                data-testid="new-task-branch"
              />
            </label>
            <label>
              起点 commit（可留空表示该分支最新）
              <input
                value={baseCommit}
                onChange={(event) => setBaseCommit(event.target.value)}
                placeholder="例如 1001c254"
                data-testid="new-task-commit"
              />
            </label>
            {error ? <p className={styles.formError}>{error}</p> : null}
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondaryButton} onClick={onCancel}>
                取消
              </button>
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={busy || !targetRepositoryId || !baseBranch.trim()}
                data-testid="new-task-confirm"
              >
                {busy ? '创建中…' : '确认创建'}
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
