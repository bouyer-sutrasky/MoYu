import clsx from 'clsx';
import type { RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import {
  formatElapsed,
  formatUpdatedAt,
  repositoryActivationLabel,
  repositoryPreparationLabel,
  repositoryRuntimeLabel,
  runtimeResourceLabel,
  waitingForLabel,
} from '../lib/format';
import { RepositoryRemoval } from './RepositoryManagementDialog';
import { RepositoryCheckCommands } from './RepositorySettingsDialog';
import styles from './WorkspaceShell.module.css';

export type RepositoryAction = 'wake' | 'sleep' | 'retry' | 'retry_stop' | 'prepare';

export function RepositoriesPage({
  repositories,
  repository,
  workRepositoryId,
  loading,
  error,
  runtimeError,
  repositoryActionBusy,
  repositoryActionError,
  onSelect,
  onUseInWork,
  onBack,
  onAdd,
  onReload,
  onRepositoryAction,
  onSaved,
  onSessionLost,
}: {
  repositories: RepositorySummary[];
  repository: RepositorySummary | null;
  workRepositoryId: string | null;
  loading: boolean;
  error: string | null;
  runtimeError: string | null;
  repositoryActionBusy: boolean;
  repositoryActionError: string | null;
  onSelect: (id: string) => void;
  onUseInWork: (id: string) => void;
  onBack: () => void;
  onAdd: () => void;
  onReload: () => Promise<void>;
  onRepositoryAction: (action: RepositoryAction) => void;
  onSaved: (repository: RepositorySummary) => void;
  onSessionLost: () => void;
}) {
  const runtime = repository?.runtime;
  const waiting = waitingForLabel(runtime?.waitingFor);
  const resource = runtimeResourceLabel(runtime?.resource);

  return (
    <>
      <header className={styles.pageHeader}>
        <h1>仓库</h1>
        <button type="button" className={styles.secondaryButton} onClick={onAdd}>
          <Icon name="plus" size={16} />
          添加仓库
        </button>
      </header>
      <nav className={styles.pageTabs} aria-label="已接入仓库">
        {repositories.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === repository?.id ? 'page' : undefined}
            onClick={() => onSelect(item.id)}
          >
            {item.fullName}
          </button>
        ))}
      </nav>
      {error ? (
        <div className={styles.sectionError} role="alert">
          <p>{error}</p>
          <button type="button" className={styles.textButton} onClick={() => void onReload()}>
            重试
          </button>
        </div>
      ) : null}
      {repository ? (
        <div key={repository.id} className={styles.repositoryPageBody}>
          <div className={styles.pageHeader}>
            <div>
              <h2>{repository.fullName}</h2>
              <p className={styles.pageMetadata}>默认分支 {repository.defaultBranch}</p>
            </div>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={repository.deletion.state === 'deleting'}
              onClick={() =>
                repository.id === workRepositoryId ? onBack() : onUseInWork(repository.id)
              }
            >
              {repository.id === workRepositoryId ? '返回 Work' : '在 Work 中使用'}
            </button>
          </div>
          {runtimeError ? (
            <p className={styles.runtimeError} role="alert">
              {runtimeError}
            </p>
          ) : null}
          {runtime ? (
            <div className={styles.repositoryRuntime} aria-live="polite">
              <div className={styles.runtimeTitle}>
                <span
                  className={clsx(styles.runtimeDot, styles[`runtime-${runtime.state}`])}
                  aria-hidden="true"
                />
                <strong>{repositoryRuntimeLabel(runtime)}</strong>
                <span className={styles.runtimeListener}>
                  {runtime.listener === 'active'
                    ? 'GitHub 监听中'
                    : runtime.listener === 'paused'
                      ? 'GitHub 监听暂停'
                      : '监听状态未知'}
                </span>
              </div>
              {(() => {
                const activation = runtime.activation;
                const label = repositoryActivationLabel(activation);
                if (!label) return null;
                const elapsed = formatElapsed(activation.elapsedMs);
                const retryAction = activation.retryAction;
                return (
                  <div className={styles.preparation} data-state={activation.phase}>
                    <div className={styles.preparationLine}>
                      <span>{label}</span>
                      {elapsed ? <span>已用时 {elapsed}</span> : null}
                      {retryAction && !repositoryActionBusy ? (
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => onRepositoryAction(retryAction)}
                        >
                          {retryAction === 'prepare'
                            ? '重试准备'
                            : retryAction === 'wake'
                              ? '唤醒'
                              : '重试启动'}
                        </button>
                      ) : null}
                    </div>
                    {activation.detail ? (
                      <span className={styles.preparationDetail} title={activation.detail}>
                        {activation.detail}
                      </span>
                    ) : null}
                  </div>
                );
              })()}
              {(() => {
                const preparation = runtime.preparation;
                const label = repositoryPreparationLabel(preparation);
                if (!label) return null;
                return (
                  <div className={styles.preparation} data-state={preparation.state}>
                    <div className={styles.preparationLine}>
                      <span>{label}</span>
                      {preparation.state === 'failed' && preparation.detail ? (
                        <span className={styles.preparationDetail} title={preparation.detail}>
                          {preparation.detail}
                        </span>
                      ) : null}
                    </div>
                    {preparation.state === 'preparing' && preparation.progress !== null ? (
                      <div
                        className={styles.preparationBar}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={preparation.progress}
                      >
                        <span style={{ width: `${preparation.progress}%` }} />
                      </div>
                    ) : null}
                  </div>
                );
              })()}
              <p className={styles.runtimeReason}>{runtime.reason}</p>
              <div className={styles.runtimeMeta}>
                <span>
                  执行名额：
                  {runtime.executionSlot === 'busy'
                    ? '使用中'
                    : runtime.executionSlot === 'free'
                      ? '空闲'
                      : '未知'}
                </span>
                {waiting ? <span>{waiting}</span> : null}
                {resource ? <span>{resource}</span> : null}
                {runtime.lease ? <span>执行代次 {runtime.lease.fencingToken}</span> : null}
                <span>
                  检查命令：
                  {repository.checkCommands
                    ? `自定义 ${repository.checkCommands.length} 条`
                    : '全局默认'}
                </span>
                {runtime.lastProgressAt ? (
                  <span>最后进展 {formatUpdatedAt(runtime.lastProgressAt)}</span>
                ) : (
                  <span>暂无有效进展</span>
                )}
              </div>
              <div className={styles.runtimeActions}>
                {runtime.actions.map((action) => (
                  <button
                    key={action.action}
                    type="button"
                    className={styles.textButton}
                    disabled={!action.enabled || repositoryActionBusy}
                    title={action.unavailableReason ?? action.label}
                    onClick={() => onRepositoryAction(action.action)}
                  >
                    {repositoryActionBusy ? '处理中…' : action.label}
                  </button>
                ))}
              </div>
              {repositoryActionError ? (
                <p className={styles.runtimeError} role="alert">
                  {repositoryActionError}
                </p>
              ) : null}
            </div>
          ) : null}
          <RepositoryCheckCommands
            repository={repository}
            onSaved={onSaved}
            onSessionLost={onSessionLost}
          />
          <RepositoryRemoval
            repository={repository}
            onReload={onReload}
            onSessionLost={onSessionLost}
          />
        </div>
      ) : (
        <p className={styles.sectionHint}>{loading ? '正在读取仓库…' : '尚未添加仓库。'}</p>
      )}
    </>
  );
}
