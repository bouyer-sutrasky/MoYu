import { Icon, type IconName } from '../components/Icon';
import { Modal } from '../components/Modal';
import styles from './ActivityDialog.module.css';

interface ActivityDialogProps {
  onClose: () => void;
}

const FILTERS: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'chat', title: '需要回复', body: '执行器提问与等待输入。' },
  { icon: 'branch', title: '待审阅', body: 'PR 交付等待所有者审阅。' },
  { icon: 'task', title: '已完成', body: '任务与检查全部完成。' },
  { icon: 'cloud', title: '失败 / 受阻', body: '执行失败或需要人工处理。' },
];

export function ActivityDialog({ onClose }: ActivityDialogProps) {
  return (
    <Modal
      title="活动中心"
      description="跨仓库汇总未读、运行中与等待回复的任务。"
      onClose={onClose}
    >
      <div className={styles.content}>
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <Icon name="bell" size={22} />
          </span>
          <strong>当前没有活动记录</strong>
          <p>
            活动中心与通知在 M6 接入。M3
            已提供持久事件流，但未读汇总、系统通知与活动定位仍待接入；本页不展示占位数据。
          </p>
          <span className={styles.phase}>活动与通知 · M6</span>
        </div>

        <ul className={styles.filters}>
          {FILTERS.map((filter) => (
            <li key={filter.title}>
              <span className={styles.filterIcon}>
                <Icon name={filter.icon} size={16} />
              </span>
              <div>
                <strong>{filter.title}</strong>
                <span>{filter.body}</span>
              </div>
              <span className={styles.phaseTag}>待接入</span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
