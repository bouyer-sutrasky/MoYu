import type { ConversationSummary, RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import { formatModel, formatPrLabel, shortCommit, taskStateLabel } from '../lib/format';
import styles from './WorkspaceShell.module.css';

interface DetailsPanelProps {
  open: boolean;
  repository: RepositorySummary | null;
  conversation: ConversationSummary | null;
  onClose: () => void;
}

const PLACEHOLDER_SECTIONS: Array<{ icon: 'branch' | 'task'; title: string; body: string }> = [
  {
    icon: 'branch',
    title: '变更',
    body: 'diff、文件变更与提交记录在 M6 接入，当前不展示推断结果。',
  },
  {
    icon: 'task',
    title: '检查',
    body: 'lint、类型检查、单元测试与集成测试结果在 M6 接入。',
  },
];

export function DetailsPanel({ open, repository, conversation, onClose }: DetailsPanelProps) {
  const task = conversation?.task ?? null;
  const baseBranch = task?.baseBranch ?? conversation?.baseBranch ?? null;
  const baseCommit = task?.baseCommit ?? conversation?.baseCommit ?? null;
  const question = task?.question ?? null;

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
            <span className={styles.phaseTag}>M4</span>
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
            <div className={styles.detailRow}>
              <dt>PR 链接</dt>
              <dd>
                {task?.prUrl ? (
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

        {PLACEHOLDER_SECTIONS.map((section) => (
          <section key={section.title} className={styles.detailSection}>
            <div className={styles.detailSectionHeading}>
              <span>
                <Icon name={section.icon} size={15} />
                {section.title}
              </span>
              <span className={styles.phaseTag}>M6</span>
            </div>
            <p>{section.body}</p>
            <div className={styles.detailDisabled}>尚未接入 · M6 提供</div>
          </section>
        ))}

        <div className={styles.detailsNote}>
          <Icon name="panel" size={15} />
          <p>
            右侧详情默认收起。M4 展示真实任务字段、讨论/执行状态、停止证据、PR
            链接与待回复问题；diff 与检查结果在 M6 接入，不会用占位数据冒充成功。
          </p>
        </div>
      </div>
    </aside>
  );
}
