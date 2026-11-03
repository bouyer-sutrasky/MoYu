import type { RepositorySummary } from '@moyu/contracts';

import { Icon, type IconName } from '../components/Icon';
import styles from './WorkspaceShell.module.css';

interface DetailsPanelProps {
  open: boolean;
  repository: RepositorySummary | null;
  onClose: () => void;
}

const SECTIONS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'branch',
    title: '变更',
    body: '任务开始后展示分支、提交与 diff。',
  },
  {
    icon: 'task',
    title: '检查',
    body: 'lint、类型检查、单元测试与集成测试结果。',
  },
  {
    icon: 'cloud',
    title: '交付',
    body: 'PR 链接、审阅状态与附件。',
  },
];

export function DetailsPanel({ open, repository, onClose }: DetailsPanelProps) {
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
        {SECTIONS.map((section) => (
          <section key={section.title} className={styles.detailSection}>
            <div className={styles.detailSectionHeading}>
              <span>
                <Icon name={section.icon} size={15} />
                {section.title}
              </span>
              <span className={styles.phaseTag}>M3/M6</span>
            </div>
            <p>{section.body}</p>
            <div className={styles.detailEmpty}>当前阶段没有数据</div>
          </section>
        ))}

        <div className={styles.detailsNote}>
          <Icon name="panel" size={15} />
          <p>
            右侧详情默认收起，用于展示变更、检查与交付。M2 只验证布局与折叠行为，不包含任务数据。
          </p>
        </div>
      </div>
    </aside>
  );
}
