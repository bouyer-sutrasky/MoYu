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
            M2 没有任务与事件写入。M3 起活动会来自持久事件流；网页打开时才会展示通知，不包含 Web
            Push。
          </p>
          <span className={styles.phase}>事件与通知 · M3/M6</span>
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
