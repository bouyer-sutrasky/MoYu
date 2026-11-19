import { useCallback, useEffect, useState } from 'react';

import { REPOSITORY_HISTORY_RETENTION_DAYS, type RepositorySummary } from '@moyu/contracts';

import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { repositoryPreparationLabel, repositoryRuntimeLabel } from '../lib/format';
import styles from './RepositoryManagementDialog.module.css';

interface RepositoryManagementDialogProps {
  repositories: RepositorySummary[];
  onClose: () => void;
  onReload: () => Promise<void>;
  onRemoved: (repositoryId: string) => void;
}

function deletionLabel(repository: RepositorySummary): string | null {
  switch (repository.deletion?.state) {
    case 'deleting':
      return '正在从 MoYu 移除';
    case 'failed':
      return '移除失败，可重试';
    default:
      return null;
  }
}

/**
 * Lists the repositories the owner has added and removes one from MoYu. The
 * confirmation is explicit about local cleanup and what is retained; the
 * GitHub repository, branches and PRs are never touched.
 */
export function RepositoryManagementDialog({
  repositories,
  onClose,
  onReload,
  onRemoved,
}: RepositoryManagementDialogProps) {
  const [confirming, setConfirming] = useState<RepositorySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const removing = repositories.some((repository) => repository.deletion?.state === 'deleting');

  // A removal is asynchronous in the supervisor. Poll only while one is in
  // progress so progress/failure comes from the server, not from a guessed
  // timer.
  useEffect(() => {
    if (!removing) return;
    const timer = window.setInterval(() => void onReload(), 2000);
    return () => window.clearInterval(timer);
  }, [removing, onReload]);

  const submit = useCallback(
    async (repository: RepositorySummary) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await api.removeRepository(repository.id);
        await onReload();
        if (result.repository.deletion.state === 'removed') {
          setNotice(`已从 MoYu 移除 ${repository.fullName}。GitHub 原仓库未做任何修改。`);
          onRemoved(repository.id);
          setConfirming(null);
        } else {
          setConfirming(result.repository);
          setNotice('移除请求已提交，正在清理本地实例与仓库副本。');
        }
      } catch (caught) {
        setError(describeApiError(caught));
        await onReload().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [onReload, onRemoved],
  );

  return (
    <Modal
      title="管理仓库"
      description="查看已接入仓库的准备与在线状态；移除只影响 MoYu 内的本地资源。"
      onClose={onClose}
      wide
    >
      {confirming ? (
        <div className={styles.confirm}>
          <h3>从 MoYu 移除 {confirming.fullName}？</h3>
          <p>
            将停止该仓库的 Superagent 实例，并删除 MoYu 内的本地 Git 副本、实例
            profile/state、运行目录、凭据与环境文件。
          </p>
          <p>
            GitHub 原仓库、分支、PR 和远端数据不会被修改。历史任务与会话在 MoYu 数据库中只读保留{' '}
            {REPOSITORY_HISTORY_RETENTION_DAYS} 天，期间不在工作台显示；
            重新接入同一仓库可恢复历史。旧链接会提示仓库已移除。
          </p>
          {confirming.deletion?.state === 'failed' && confirming.deletion.detail ? (
            <p className={styles.error}>上次移除失败：{confirming.deletion.detail}</p>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {notice ? <p className={styles.notice}>{notice}</p> : null}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setConfirming(null);
                setError(null);
                setNotice(null);
              }}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.danger}
              onClick={() => void submit(confirming)}
              disabled={busy || confirming.deletion?.state === 'deleting'}
            >
              {busy || confirming.deletion?.state === 'deleting'
                ? '正在移除…'
                : confirming.deletion?.state === 'failed'
                  ? '重试移除'
                  : '确认移除'}
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.content}>
          {repositories.length === 0 ? (
            <p className={styles.empty}>还没有接入的仓库。</p>
          ) : (
            <ul className={styles.list}>
              {repositories.map((repository) => {
                const deletion = deletionLabel(repository);
                return (
                  <li
                    key={repository.id}
                    className={styles.row}
                    data-state={repository.deletion?.state}
                  >
                    <div className={styles.identity}>
                      <strong>{repository.fullName}</strong>
                      <span>
                        {deletion ?? repositoryRuntimeLabel(repository.runtime)} ·{' '}
                        {repository.runtime
                          ? (repositoryPreparationLabel(repository.runtime.preparation) ??
                            '仓库副本状态未知')
                          : '仓库副本状态未知'}
                      </span>
                      {repository.deletion?.state === 'failed' && repository.deletion.detail ? (
                        <span className={styles.error}>{repository.deletion.detail}</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => {
                        setConfirming(repository);
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      {repository.deletion?.state === 'failed' ? '重试移除' : '从 MoYu 移除'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {removing ? <p className={styles.notice}>移除进行中；结论会服务端回读。</p> : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {notice ? <p className={styles.notice}>{notice}</p> : null}
        </div>
      )}
    </Modal>
  );
}
