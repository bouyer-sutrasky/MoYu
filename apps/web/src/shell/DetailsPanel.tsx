import type {
  ConversationSummary,
  RepositorySummary,
  ReviewCheckRun,
  ReviewFile,
  TaskReview,
} from '@moyu/contracts';

import { Icon } from '../components/Icon';
import { formatModel, formatPrLabel, shortCommit, taskStateLabel } from '../lib/format';
import styles from './WorkspaceShell.module.css';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface DetailsPanelProps {
  open: boolean;
  repository: RepositorySummary | null;
  conversation: ConversationSummary | null;
  review: TaskReview | null;
  reviewStatus: LoadStatus;
  reviewError: string | null;
  reviewBusy: 'changes' | 'checks' | null;
  onRefreshChanges: () => void;
  onRunChecks: () => void;
  onClose: () => void;
}

const STATUS_LABELS: Record<ReviewFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  untracked: '未跟踪',
  type_changed: '类型变化',
  unknown: '变更',
};

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function shortTimestamp(value: string): string {
  return new Date(value).toLocaleTimeString();
}

function PullRequestState({ review }: { review: TaskReview }) {
  const pullRequest = review.pullRequest;
  if (!pullRequest) {
    return <span className={styles.detailMuted}>运行时尚未上报 PR</span>;
  }
  const labels: Record<string, string> = {
    open: '进行中',
    closed: '已关闭 · 未合并',
    merged: '已合并',
    unknown: '状态未知',
  };
  return (
    <span>
      <a
        className={styles.detailLink}
        href={pullRequest.url || undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        {formatPrLabel(pullRequest.number)}
      </a>
      <span className={styles.reviewStateTag} data-state={pullRequest.state}>
        {labels[pullRequest.state] ?? pullRequest.state}
      </span>
      {pullRequest.unavailableReason ? (
        <span className={styles.detailMuted}> {pullRequest.unavailableReason}</span>
      ) : null}
    </span>
  );
}

function ChangesSection({
  review,
  status,
  busy,
  error,
  onRefresh,
}: {
  review: TaskReview | null;
  status: LoadStatus;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const changes = review?.changes;
  const files = changes?.files ?? [];
  return (
    <section className={styles.detailSection} aria-labelledby="changes-heading">
      <div className={styles.detailSectionHeading}>
        <span id="changes-heading">
          <Icon name="branch" size={15} />
          变更
        </span>
        <button
          type="button"
          className={styles.textButton}
          onClick={onRefresh}
          disabled={busy || status === 'loading'}
          title="重新读取当前任务 worktree 的真实 git diff"
        >
          {busy ? '读取中…' : '刷新变更'}
        </button>
      </div>
      {error ? (
        <p className={styles.reviewProblem} role="alert">
          {error}
        </p>
      ) : null}
      {!review ? (
        <p className={styles.detailMuted}>
          {status === 'loading' ? '正在读取任务执行目录…' : '尚未采集变更。'}
        </p>
      ) : changes?.state === 'cleaned' ? (
        <div className={styles.reviewNotice} data-state="cleaned">
          <strong>工作目录已清理</strong>
          <p>{changes.reason ?? '任务的工作目录已不存在。'}</p>
        </div>
      ) : changes?.state !== 'available' ? (
        <div className={styles.reviewNotice} data-state="unavailable">
          <p>{changes?.reason ?? '尚未采集变更。'}</p>
        </div>
      ) : (
        <>
          <div className={styles.reviewSummary}>
            <span>
              {files.length === 0 ? '无改动' : `${files.length} 个文件`}
              {changes.filesOmitted > 0 ? `（另有 ${changes.filesOmitted} 个未展示）` : ''}
            </span>
            <span className={styles.reviewCounts}>
              <span data-kind="add">+{changes.additions}</span>
              <span data-kind="del">-{changes.deletions}</span>
            </span>
          </div>
          <p className={styles.reviewMeta}>
            {changes.branch ?? '未知分支'} · 采集于 {formatTimestamp(changes.collectedAt)}
          </p>
          {files.length > 0 ? (
            <ul className={styles.reviewFileList}>
              {files.map((file) => (
                <li key={`${file.path}-${file.status}`}>
                  <details className={styles.reviewFile}>
                    <summary>
                      <span className={styles.reviewFileStatus} data-status={file.status}>
                        {STATUS_LABELS[file.status]}
                      </span>
                      <span className={styles.reviewFilePath}>{file.path}</span>
                      <span className={styles.reviewCounts}>
                        <span data-kind="add">+{file.additions}</span>
                        <span data-kind="del">-{file.deletions}</span>
                      </span>
                    </summary>
                    {file.binary ? (
                      <p className={styles.detailMuted}>二进制文件，无文本 diff。</p>
                    ) : file.patch ? (
                      <pre className={styles.reviewPatch}>{file.patch}</pre>
                    ) : (
                      <p className={styles.detailMuted}>该文件没有可展示的文本 diff。</p>
                    )}
                    {file.patchTruncated ? (
                      <p className={styles.detailMuted}>diff 过长，已截断显示。</p>
                    ) : null}
                  </details>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

function CheckRunItem({ run }: { run: ReviewCheckRun }) {
  return (
    <li className={styles.reviewCheck}>
      <details>
        <summary>
          <span className={styles.reviewCheckState} data-passed={run.passed}>
            {run.passed ? '通过' : run.timedOut ? '超时' : '失败'}
          </span>
          <code className={styles.reviewCommand}>{run.command}</code>
          <span className={styles.reviewCounts}>
            <span>exit {run.exitCode ?? 'unknown'}</span>
            <span>{Math.round(run.durationMs / 1000)}s</span>
          </span>
        </summary>
        <p className={styles.reviewMeta}>
          {shortTimestamp(run.startedAt)} → {shortTimestamp(run.finishedAt)} · {run.summary}
        </p>
        <pre className={styles.reviewPatch}>{run.output || '（无输出）'}</pre>
        {run.outputTruncated ? (
          <p className={styles.detailMuted}>输出过长，只保留末尾部分。</p>
        ) : null}
      </details>
    </li>
  );
}

function ChecksSection({
  review,
  status,
  busy,
  error,
  onRun,
}: {
  review: TaskReview | null;
  status: LoadStatus;
  busy: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const checks = review?.checks;
  return (
    <section className={styles.detailSection} aria-labelledby="checks-heading">
      <div className={styles.detailSectionHeading}>
        <span id="checks-heading">
          <Icon name="task" size={15} />
          检查
        </span>
        <button
          type="button"
          className={styles.textButton}
          onClick={onRun}
          disabled={busy || status === 'loading'}
          title="在任务执行目录中运行项目配置的检查命令"
        >
          {busy ? '运行中…' : '运行检查'}
        </button>
      </div>
      {error ? (
        <p className={styles.reviewProblem} role="alert">
          {error}
        </p>
      ) : null}
      {!review ? (
        <p className={styles.detailMuted}>
          {status === 'loading' ? '正在读取检查结果…' : '尚未运行检查。'}
        </p>
      ) : checks?.state === 'not_run' ? (
        <p className={styles.detailMuted}>
          还没有检查结果。点击“运行检查”会在任务执行目录中真实运行 lint、类型检查与测试。
        </p>
      ) : checks?.state === 'unavailable' ? (
        <div className={styles.reviewNotice} data-state="unavailable">
          <p>{checks.reason ?? '检查结果不可用。'}</p>
        </div>
      ) : (
        <>
          <p className={styles.reviewMeta}>采集于 {formatTimestamp(checks?.collectedAt ?? null)}</p>
          <ul className={styles.reviewCheckList}>
            {(checks?.runs ?? []).map((run) => (
              <CheckRunItem key={run.id} run={run} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function DetailsPanel({
  open,
  repository,
  conversation,
  review,
  reviewStatus,
  reviewError,
  reviewBusy,
  onRefreshChanges,
  onRunChecks,
  onClose,
}: DetailsPanelProps) {
  const task = conversation?.task ?? null;
  const baseBranch = task?.baseBranch ?? conversation?.baseBranch ?? null;
  const baseCommit = task?.baseCommit ?? conversation?.baseCommit ?? null;
  const question = task?.question ?? null;
  const changes = review?.changes ?? null;

  return (
    <aside
      className={open ? styles.detailsOpen : styles.details}
      aria-label="会话详情"
      aria-hidden={!open}
    >
      <header className={styles.detailsHeader}>
        <div>
          <h2>详情</h2>
          <p>{repository ? repository.fullName : '尚未选择仓库'}</p>
        </div>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="收起详情">
          <Icon name="x" />
        </button>
      </header>

      <div className={styles.detailsBody}>
        <section className={styles.detailSection} aria-labelledby="task-fields-heading">
          <div className={styles.detailSectionHeading}>
            <span id="task-fields-heading">
              <Icon name="task" size={15} />
              任务
            </span>
            <span className={styles.phaseTag}>可用</span>
          </div>
          <dl className={styles.detailList}>
            <div className={styles.detailRow}>
              <dt>状态</dt>
              <dd>{taskStateLabel(task?.state)}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt>仓库</dt>
              <dd>{repository?.fullName ?? '尚未选择仓库'}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt>分支</dt>
              <dd>{baseBranch ?? '—'}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt>起点 commit</dt>
              <dd>
                {baseCommit ? (
                  <span className={styles.detailCommit}>{shortCommit(baseCommit)}</span>
                ) : (
                  <span className={styles.detailMuted}>首次投递时记录</span>
                )}
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt>模型</dt>
              <dd>{conversation ? formatModel(task?.model ?? conversation.model) : '—'}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt>来源</dt>
              <dd>
                {conversation?.source === 'github'
                  ? `GitHub 汇入 · ${conversation.externalKey ?? '未知编号'}`
                  : '网页新建'}
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt>执行方式</dt>
              <dd>
                {task?.executionMode === 'discuss' ? '先讨论（只读）' : task ? '直接执行' : '—'}
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt>计划版本</dt>
              <dd>{task?.planRevision ? `v${task.planRevision}` : '尚未确认执行方案'}</dd>
            </div>
            <div className={styles.detailRow}>
              <dt>最近命令</dt>
              <dd>
                {task?.lastOperation
                  ? `${task.lastOperation.kind} · ${task.lastOperation.state}`
                  : '—'}
              </dd>
            </div>
            <div className={styles.detailRow}>
              <dt>停止时间</dt>
              <dd>
                {task?.stoppedAt
                  ? new Date(task.stoppedAt).toLocaleString()
                  : task?.stopRequestedAt
                    ? '停止请求处理中'
                    : '—'}
              </dd>
            </div>
            <div className={`${styles.detailRow} ${styles.detailRowStack}`}>
              <dt>停止证据</dt>
              <dd>
                {task && Object.keys(task.stopEvidence).length > 0 ? (
                  <p className={styles.detailQuestion}>
                    {typeof task.stopEvidence.agentStatus === 'string'
                      ? `worker ${task.stopEvidence.agentStatus}`
                      : '已记录运行时停止证据'}
                    {typeof task.stopEvidence.harnessPid === 'number'
                      ? ` · PID ${task.stopEvidence.harnessPid}`
                      : ''}
                    {Array.isArray(task.stopEvidence.jobsAfter)
                      ? ` · 剩余后台作业 ${task.stopEvidence.jobsAfter.length}`
                      : ''}
                  </p>
                ) : (
                  <span className={styles.detailMuted}>
                    只有运行时证明执行与后台作业已结束才显示已停止
                  </span>
                )}
              </dd>
            </div>
            <div className={`${styles.detailRow} ${styles.detailRowStack}`}>
              <dt>提交</dt>
              <dd>
                {changes?.commit ? (
                  <>
                    <code className={styles.detailCommitFull}>{changes.commit}</code>
                    <span className={styles.detailMuted}>{changes.commitSubject ?? ''}</span>
                  </>
                ) : (
                  <span className={styles.detailMuted}>
                    {review?.changes.reason ?? '尚未读取到任务提交'}
                  </span>
                )}
              </dd>
            </div>
            <div className={`${styles.detailRow} ${styles.detailRowStack}`}>
              <dt>PR 状态</dt>
              <dd>
                {review ? (
                  <PullRequestState review={review} />
                ) : task?.prUrl ? (
                  <a
                    className={styles.detailLink}
                    href={task.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {formatPrLabel(task.prNumber)}
                  </a>
                ) : (
                  <span className={styles.detailMuted}>尚未创建 PR</span>
                )}
              </dd>
            </div>
            <div className={`${styles.detailRow} ${styles.detailRowStack}`}>
              <dt>问题</dt>
              <dd>
                {question ? (
                  <p className={styles.detailQuestion}>{question}</p>
                ) : (
                  <span className={styles.detailMuted}>当前没有待回复问题</span>
                )}
              </dd>
            </div>
          </dl>
        </section>

        <ChangesSection
          review={review}
          status={reviewStatus}
          busy={reviewBusy === 'changes'}
          error={reviewBusy === 'changes' ? null : reviewError}
          onRefresh={onRefreshChanges}
        />

        <ChecksSection
          review={review}
          status={reviewStatus}
          busy={reviewBusy === 'checks'}
          error={reviewBusy === 'checks' ? null : reviewError}
          onRun={onRunChecks}
        />

        <div className={styles.detailsNote}>
          <Icon name="panel" size={15} />
          <p>
            右侧详情默认收起。变更来自任务 worktree 的真实 <code>git diff</code>
            ，检查来自在任务执行目录中真实运行的命令；取不到数据时显示原因，不用占位内容冒充。
          </p>
        </div>
      </div>
    </aside>
  );
}
