import { useState } from 'react';

import { REPOSITORY_HISTORY_RETENTION_DAYS, type RepositorySummary } from '@moyu/contracts';

import { Modal } from '../components/Modal';
import { api, ApiClientError } from '../lib/api';
import { describeApiError } from '../lib/errors';
import styles from './RepositoryManagementDialog.module.css';

export function RepositoryRemoval({
  repository,
  onReload,
  onSessionLost,
}: {
  repository: RepositorySummary;
  onReload: () => Promise<void>;
  onSessionLost: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const removing = repository.deletion?.state === 'deleting';
  const failed = repository.deletion?.state === 'failed';

  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.removeRepository(repository.id);
      setConfirming(false);
      setNotice(
        result.repository.deletion.state === 'removed'
          ? '已从 MoYu 移除仓库。'
          : '移除请求已提交，正在清理本地实例与仓库副本。',
      );
      await onReload();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) onSessionLost();
      else setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.content}>
      {removing ? (
        <p className={styles.notice} role="status">
          正在从 MoYu 移除仓库…
        </p>
      ) : null}
      {failed ? (
        <p className={styles.error} role="alert">
          {repository.deletion?.detail ?? '移除失败，可重试。'}
        </p>
      ) : null}
      {notice && !removing && !failed ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className={styles.secondary}
          disabled={removing || busy}
          onClick={() => setConfirming(true)}
        >
          {failed ? '重试移除' : '从 MoYu 移除'}
        </button>
      </div>
      {confirming ? (
        <Modal
          title="移除仓库"
          onClose={() => {
            if (!busy) setConfirming(false);
          }}
        >
          <div className={styles.confirm}>
            <h3>从 MoYu 移除 {repository.fullName}？</h3>
            <p>
              将停止该仓库的 Superagent 实例，并删除 MoYu 内的本地 Git 副本、实例
              profile/state、运行目录、凭据与环境文件。
            </p>
            <p>
              GitHub 原仓库、分支、PR 和远端数据不会被修改。历史任务与会话在 MoYu 数据库中保留{' '}
              {REPOSITORY_HISTORY_RETENTION_DAYS} 天：期间不在工作台显示，重新接入同一仓库可恢复；
              超过 {REPOSITORY_HISTORY_RETENTION_DAYS}{' '}
              天后自动清理，届时不可恢复。旧链接会提示仓库已移除。
            </p>
            {repository.deletion?.state === 'failed' && repository.deletion.detail ? (
              <p className={styles.error}>上次移除失败：{repository.deletion.detail}</p>
            ) : null}
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  setConfirming(false);
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
                onClick={() => void submit()}
                disabled={busy || repository.deletion?.state === 'deleting'}
              >
                {busy || repository.deletion?.state === 'deleting'
                  ? '正在移除…'
                  : repository.deletion?.state === 'failed'
                    ? '重试移除'
                    : '确认移除'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
