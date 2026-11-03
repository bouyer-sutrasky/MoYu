import type { RepositorySummary } from '@moyu/contracts';

import { Icon, type IconName } from '../components/Icon';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';

interface ConversationPaneProps {
  mode: Mode;
  repository: RepositorySummary | null;
  onOpenDetails: () => void;
}

const STATUS_LABELS: Record<RepositorySummary['status'], string> = {
  provisioning: '实例待准备',
  active: '实例在线',
  sleeping: '实例休眠',
  error: '实例异常',
};

const CAPABILITIES: Array<{ icon: IconName; title: string; body: string; phase: string }> = [
  {
    icon: 'chat',
    title: '会话消息',
    body: '发送、回复与执行中补充消息。',
    phase: 'M3',
  },
  {
    icon: 'task',
    title: '任务执行',
    body: '任务接单、运行状态与人工暂停。',
    phase: 'M3/M4',
  },
  {
    icon: 'branch',
    title: '交付审阅',
    body: 'Diff、检查结果与 PR 链接。',
    phase: 'M6',
  },
];

export function ConversationPane({ mode, repository, onOpenDetails }: ConversationPaneProps) {
  if (mode === 'chat') {
    return (
      <div className={styles.conversation}>
        <div className={styles.hero}>
          <span className={styles.heroIcon}>
            <Icon name="chat" size={26} />
          </span>
          <p className={styles.heroEyebrow}>Chat 模式</p>
          <h1 className={styles.heroTitle}>Chat 尚未接入</h1>
          <p className={styles.heroLead}>
            M2
            只提供模式入口与布局。聊天消息接口、机器人身份与回复路由会在后续阶段接入；当前不会发送或保存任何内容。
          </p>
          <span className={styles.phasePill}>预留接口 · 当前不可用</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.conversation}>
      <div className={styles.hero}>
        <span className={styles.heroIcon}>
          <Icon name={repository ? 'work' : 'cloud'} size={26} />
        </span>
        <p className={styles.heroEyebrow}>
          {repository
            ? `${repository.fullName} · ${STATUS_LABELS[repository.status]}`
            : 'Work 模式'}
        </p>
        <h1 className={styles.heroTitle}>{repository ? '新任务会话' : '先选择一个仓库'}</h1>
        <p className={styles.heroLead}>
          {repository
            ? 'M2 已交付登录、会话与凭据管理和页面外壳。会话消息、任务执行与交付审阅在后续阶段接入，当前不会创建任务或调用执行器。'
            : '仓库列表来自服务端真实数据；添加仓库与实例准备在 M3/M4 接入。现在可以检查外壳布局、主题和登录状态。'}
        </p>
        <div className={styles.heroActions}>
          <button
            type="button"
            className={styles.disabledPrimary}
            disabled
            title="M3 接入消息闭环后可用"
          >
            <Icon name="plus" />
            新建 Work 任务
            <span className={styles.phaseTag}>M3</span>
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onOpenDetails}>
            <Icon name="panel" />
            查看右侧详情
          </button>
        </div>
        <p className={styles.heroNote}>
          尚未实现的 Work 操作均保持禁用并标注阶段，按钮不会伪造成功。
        </p>
      </div>

      <div className={styles.capabilityGrid}>
        {CAPABILITIES.map((capability) => (
          <section key={capability.title} className={styles.capabilityCard}>
            <span className={styles.capabilityIcon}>
              <Icon name={capability.icon} />
            </span>
            <div>
              <h2>{capability.title}</h2>
              <p>{capability.body}</p>
            </div>
            <span className={styles.phaseTag}>{capability.phase}</span>
          </section>
        ))}
      </div>

      <div className={styles.shellStatus}>
        <div>
          <strong>M2 已接通</strong>
          <span>Passkey 首次绑定 / 登录 / 刷新保持 / 撤销会话</span>
        </div>
        <div>
          <strong>当前阶段</strong>
          <span>页面外壳、主题与受保护资源</span>
        </div>
      </div>
    </div>
  );
}
