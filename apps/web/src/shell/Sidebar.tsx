import clsx from 'clsx';

import type { RepositorySummary } from '@moyu/contracts';

import { Icon } from '../components/Icon';
import type { ThemeMode } from '../theme/ThemeProvider';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';

interface SidebarProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  repositories: RepositorySummary[];
  repositoriesStatus: 'loading' | 'ready' | 'error';
  repositoriesError: string | null;
  selectedRepositoryId: string | null;
  onSelectRepository: (id: string) => void;
  onReloadRepositories: () => void;
  onOpenActivity: () => void;
  onOpenSettings: () => void;
  ownerName: string;
  themeMode: ThemeMode;
  onCycleTheme: () => void;
  mobileOpen: boolean;
  onClose: () => void;
  onLogout: () => void;
}

export function Sidebar({
  mode,
  onModeChange,
  repositories,
  repositoriesStatus,
  repositoriesError,
  selectedRepositoryId,
  onSelectRepository,
  onReloadRepositories,
  onOpenActivity,
  onOpenSettings,
  ownerName,
  themeMode,
  onCycleTheme,
  mobileOpen,
  onClose,
  onLogout,
}: SidebarProps) {
  return (
    <aside
      className={clsx(styles.sidebar, mobileOpen && styles.sidebarOpen)}
      aria-label="工作台导航"
    >
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          Mo
        </span>
        <div className={styles.brandText}>
          <strong>MoYu</strong>
          <span>个人智能体工作台</span>
        </div>
        <button
          type="button"
          className={styles.mobileClose}
          aria-label="关闭导航"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>

      <div className={styles.modeSwitch} role="tablist" aria-label="模式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'work'}
          className={clsx(styles.modeButton, mode === 'work' && styles.modeButtonActive)}
          onClick={() => onModeChange('work')}
        >
          <Icon name="work" />
          Work
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'chat'}
          className={clsx(styles.modeButton, mode === 'chat' && styles.modeButtonActive)}
          onClick={() => onModeChange('chat')}
        >
          <Icon name="chat" />
          Chat
        </button>
      </div>

      <section className={styles.sidebarSection} aria-labelledby="repository-heading">
        <div className={styles.sectionHeading}>
          <h2 id="repository-heading">仓库</h2>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onReloadRepositories}
            aria-label="刷新仓库列表"
            title="刷新仓库列表"
          >
            <Icon name="branch" size={15} />
          </button>
        </div>

        {repositoriesStatus === 'loading' ? (
          <p className={styles.sectionHint}>正在读取仓库…</p>
        ) : repositoriesStatus === 'error' ? (
          <div className={styles.sectionError}>
            <p>{repositoriesError ?? '仓库列表不可用'}</p>
            <button type="button" className={styles.textButton} onClick={onReloadRepositories}>
              重试
            </button>
          </div>
        ) : repositories.length === 0 ? (
          <div className={styles.emptyCard}>
            <Icon name="cloud" />
            <p>尚未添加仓库</p>
            <span>仓库添加与实例准备在 M3/M4 接入。</span>
          </div>
        ) : (
          <label className={styles.repositorySelect}>
            <span className="visually-hidden">选择仓库</span>
            <select
              value={selectedRepositoryId ?? ''}
              onChange={(event) => onSelectRepository(event.target.value)}
            >
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.fullName}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={15} />
          </label>
        )}

        <button type="button" className={styles.disabledAction} disabled title="M3/M4 接入">
          <Icon name="plus" size={15} />
          添加仓库
          <span className={styles.phaseTag}>M3/M4</span>
        </button>
      </section>

      <section className={styles.sidebarSection} aria-labelledby="history-heading">
        <div className={styles.sectionHeading}>
          <h2 id="history-heading">任务历史</h2>
          <span className={styles.count}>0</span>
        </div>
        <div className={styles.emptyList}>
          <Icon name="task" />
          <p>还没有任务会话</p>
          <span>M3 接入消息闭环后，任务会按仓库汇总在这里。</span>
        </div>
      </section>

      <nav className={styles.sidebarNav} aria-label="工作台入口">
        <button type="button" className={styles.navButton} onClick={onOpenActivity}>
          <Icon name="bell" />
          活动中心
          <span className={styles.navMeta}>M6</span>
        </button>
        <button type="button" className={styles.navButton} onClick={onOpenSettings}>
          <Icon name="settings" />
          设置
        </button>
      </nav>

      <footer className={styles.sidebarFooter}>
        <div className={styles.ownerRow}>
          <span className={styles.avatar} aria-hidden="true">
            {ownerName.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{ownerName}</strong>
            <span>单所有者</span>
          </div>
        </div>
        <div className={styles.footerActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onCycleTheme}
            title={`主题：${themeMode}`}
            aria-label={`切换主题，当前 ${themeMode}`}
          >
            <Icon
              name={themeMode === 'dark' ? 'moon' : themeMode === 'light' ? 'sun' : 'monitor'}
            />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onLogout}
            title="退出登录"
            aria-label="退出登录"
          >
            <Icon name="logout" />
          </button>
        </div>
      </footer>
    </aside>
  );
}
