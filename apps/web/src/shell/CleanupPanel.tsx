import { useCallback, useEffect, useState } from 'react';

import type { CleanupItem, CleanupRun } from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { formatBytes, formatUpdatedAt } from '../lib/format';
import { Icon } from '../components/Icon';
import styles from './CleanupPanel.module.css';

interface CleanupPanelProps {
  onSessionLost: () => void;
}

const RUN_STATUS_LABELS: Record<CleanupRun['status'], string> = {
  preview: '预览',
  running: '执行中',
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
};

function itemStateLabel(item: CleanupItem): string {
  switch (item.state) {
    case 'planned':
      return '将删除';
    case 'removed':
      return '已删除';
    case 'already_cleaned':
      return '已无目录';
    case 'failed':
      return '删除失败';
    default:
      return '跳过';
  }
}

export function CleanupPanel({ onSessionLost }: CleanupPanelProps) {
  const [runs, setRuns] = useState<CleanupRun[]>([]);
  const [runsStatus, setRunsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [preview, setPreview] = useState<CleanupRun | null>(null);
  const [busy, setBusy] = useState<'preview' | 'execute' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleError = useCallback(
    (caught: unknown) => {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setError(describeApiError(caught));
    },
    [onSessionLost],
  );

  const loadRuns = useCallback(async () => {
    try {
      const result = await api.cleanupRuns();
      setRuns(result.runs);
      setRunsStatus('ready');
    } catch (caught) {
      setRunsStatus('error');
      handleError(caught);
    }
  }, [handleError]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  async function runPreview() {
    setBusy('preview');
    setError(null);
    setNotice(null);
    setConfirming(false);
    try {
      const result = await api.cleanupPreview();
      setPreview(result.run);
      setNotice(
        result.run.summary.eligible > 0
          ? `预览完成：${result.run.summary.eligible} 个目录符合条件，共 ${formatBytes(result.run.summary.totalBytes) ?? '0 B'}。`
          : '预览完成：当前没有符合 7 天清理条件的目录。',
      );
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function executePreview() {
    if (!preview) return;
    setBusy('execute');
    setError(null);
    try {
      const result = await api.cleanupExecute(preview.id);
      setPreview(result.run);
      setConfirming(false);
      setNotice(
        result.duplicate
          ? '该预览已执行过，展示的是原执行结果。'
          : `清理结束：删除 ${result.run.summary.removed} 个，已无目录 ${result.run.summary.alreadyCleaned} 个，失败 ${result.run.summary.failed} 个。`,
      );
      await loadRuns();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  }

  const eligible = preview?.items.filter((item) => item.eligible) ?? [];
  const skipped = preview?.items.filter((item) => !item.eligible) ?? [];

  return (
    <section className={styles.section} aria-labelledby="cleanup-heading">
      <div className={styles.sectionHeading}>
        <h3 id="cleanup-heading">清理</h3>
        <p>
          仅清理「已合并且无未保存修改」的 worktree，默认保留 7 天。先干跑预览路径、原因与大小，
          再显式确认；未合并、有未提交/未推送改动、被进程占用或超出工作区的目录一律跳过。
        </p>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => void runPreview()}
          disabled={busy !== null}
        >
          <Icon name="search" size={15} />
          {busy === 'preview' ? '正在检查…' : '干跑预览可清理目录'}
        </button>
        <span className={styles.hint}>
          预览有效期 15 分钟；执行前会再次核对合并状态与真实工作目录。
        </span>
      </div>

      {preview ? (
        <div className={styles.preview} aria-live="polite">
          <div className={styles.previewHeader}>
            <strong>
              预览：{preview.summary.eligible} 个可删除 / {preview.summary.candidates} 个候选
            </strong>
            <span>
              共 {formatBytes(preview.summary.totalBytes) ?? '0 B'} · 跳过 {preview.summary.skipped}{' '}
              个 · 保留 {preview.retentionDays} 天
            </span>
          </div>

          {preview.items.length === 0 ? (
            <p className={styles.muted}>没有满足保留期且已完成的任务。</p>
          ) : (
            <ul className={styles.items}>
              {[...eligible, ...skipped].map((item) => (
                <li
                  key={item.id}
                  className={item.eligible ? styles.itemEligible : styles.item}
                  data-eligible={item.eligible ? 'true' : 'false'}
                >
                  <div className={styles.itemTop}>
                    <span className={styles.itemState} data-state={item.state}>
                      {itemStateLabel(item)}
                    </span>
                    <strong>{item.directory ?? item.ticketId}</strong>
                    <span className={styles.itemSize}>
                      {formatBytes(item.sizeBytes) ?? '大小未知'}
                    </span>
                  </div>
                  <p className={styles.itemReason}>{item.reason}</p>
                  <span className={styles.itemMeta}>
                    {item.repositoryName}
                    {item.profile ? ` · profile ${item.profile}` : ''}
                    {item.modifiedAt ? ` · 最近修改 ${formatUpdatedAt(item.modifiedAt)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {eligible.length > 0 && preview.mode === 'preview' && preview.status === 'preview' ? (
            confirming ? (
              <div className={styles.confirmBox} role="alert">
                <strong>确认删除下列 {eligible.length} 个目录？</strong>
                <p>删除后本地 worktree 不可恢复；会话、报告、PR 与远端分支都会保留。</p>
                <div className={styles.confirmActions}>
                  <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => void executePreview()}
                    disabled={busy !== null}
                  >
                    {busy === 'execute' ? '正在删除…' : `确认清理 ${eligible.length} 个目录`}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => setConfirming(false)}
                    disabled={busy !== null}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => setConfirming(true)}
                disabled={busy !== null}
              >
                <Icon name="trash" size={15} />
                删除预览中的 {eligible.length} 个目录…
              </button>
            )
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      <div className={styles.history}>
        <h4>最近清理记录</h4>
        {runsStatus === 'loading' ? (
          <p className={styles.muted}>正在读取清理记录…</p>
        ) : runsStatus === 'error' ? (
          <button type="button" className={styles.textButton} onClick={() => void loadRuns()}>
            重试
          </button>
        ) : runs.length === 0 ? (
          <p className={styles.muted}>还没有清理记录。</p>
        ) : (
          <ul className={styles.runs}>
            {runs.slice(0, 5).map((run) => (
              <li key={run.id} className={styles.run}>
                <span className={styles.runStatus} data-status={run.status}>
                  {run.mode === 'preview' ? '预览' : '执行'} · {RUN_STATUS_LABELS[run.status]}
                </span>
                <span className={styles.runText}>
                  候选 {run.summary.candidates} · 可删 {run.summary.eligible} · 删除{' '}
                  {run.summary.removed} · 失败 {run.summary.failed} ·{' '}
                  {formatBytes(run.summary.bytesFreed) ?? '0 B'} 释放
                </span>
                <span className={styles.runTime}>{formatUpdatedAt(run.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
