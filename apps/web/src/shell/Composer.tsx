import type { RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';

interface ComposerProps {
  mode: Mode;
  repository: RepositorySummary | null;
}

export function Composer({ mode, repository }: ComposerProps) {
  const placeholder =
    mode === 'chat'
      ? 'Chat 尚未接入，输入区当前不可发送'
      : repository
        ? 'M3 接入消息接口后可在这里输入任务或回复'
        : '选择仓库后开始任务；当前阶段输入区不可发送';

  return (
    <div className={styles.composerWrap}>
      <div className={styles.composer}>
        <textarea
          className={styles.composerInput}
          placeholder={placeholder}
          rows={1}
          disabled
          aria-label="消息输入区（当前不可发送）"
        />
        <div className={styles.composerFooter}>
          <span>
            <Icon name="key" size={13} /> 输入区已布局 · 消息接口 M3
          </span>
          <button
            type="button"
            className={styles.sendButton}
            disabled
            title="M3 接入消息接口后可用"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
