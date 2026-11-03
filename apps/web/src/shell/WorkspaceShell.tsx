import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';

import type { AuthMeData, AuthStateData, RepositorySummary } from '@moyu/contracts';

import { api, ApiClientError } from '../lib/api';
import { describeAuthError } from '../lib/errors';
import { Icon } from '../components/Icon';
import { useTheme } from '../theme/ThemeProvider';
import { ActivityDialog } from './ActivityDialog';
import { Composer } from './Composer';
import { ConversationPane } from './ConversationPane';
import { DetailsPanel } from './DetailsPanel';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar } from './Sidebar';
import styles from './WorkspaceShell.module.css';

type Mode = 'work' | 'chat';

interface WorkspaceShellProps {
  me: AuthMeData;
  authState: AuthStateData;
  onSessionLost: () => void;
  onRefreshMe: () => Promise<void>;
  onLoggedOut: () => void;
}

export function WorkspaceShell({
  me,
  authState,
  onSessionLost,
  onRefreshMe,
  onLoggedOut,
}: WorkspaceShellProps) {
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const [mode, setMode] = useState<Mode>('work');
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [repositoriesStatus, setRepositoriesStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const loadRepositories = useCallback(async () => {
    setRepositoriesStatus('loading');
    setRepositoriesError(null);
    try {
      const result = await api.repositories();
      setRepositories(result.repositories);
      setRepositoriesStatus('ready');
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) {
        onSessionLost();
        return;
      }
      setRepositoriesStatus('error');
      setRepositoriesError(describeAuthError(caught));
    }
  }, [onSessionLost]);

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  useEffect(() => {
    if (repositories.length === 0) {
      setSelectedRepositoryId(null);
      return;
    }
    if (
      !selectedRepositoryId ||
      !repositories.some((repository) => repository.id === selectedRepositoryId)
    ) {
      setSelectedRepositoryId(repositories[0]?.id ?? null);
    }
  }, [repositories, selectedRepositoryId]);

  const selectedRepository = useMemo(
    () => repositories.find((repository) => repository.id === selectedRepositoryId) ?? null,
    [repositories, selectedRepositoryId],
  );

  async function logout() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    try {
      await api.logout();
    } catch (caught) {
      if (!(caught instanceof ApiClientError && caught.status === 401)) {
        setRepositoriesError(describeAuthError(caught));
      }
    } finally {
      setLoggingOut(false);
      onLoggedOut();
    }
  }

  function cycleTheme() {
    setThemeMode(themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system');
  }

  function closeDrawers() {
    setSidebarOpen(false);
    setDetailsOpen(false);
  }

  return (
    <div className={styles.app}>
      <a className={styles.skipLink} href="#main-content">
        跳到主内容
      </a>

      <div className={clsx(styles.shell, detailsOpen && styles.shellWithDetails)}>
        <Sidebar
          mode={mode}
          onModeChange={(next) => {
            setMode(next);
            setSidebarOpen(false);
          }}
          repositories={repositories}
          repositoriesStatus={repositoriesStatus}
          repositoriesError={repositoriesError}
          selectedRepositoryId={selectedRepositoryId}
          onSelectRepository={setSelectedRepositoryId}
          onReloadRepositories={() => void loadRepositories()}
          onOpenActivity={() => {
            setActivityOpen(true);
            setSidebarOpen(false);
          }}
          onOpenSettings={() => {
            setSettingsOpen(true);
            setSidebarOpen(false);
          }}
          ownerName={me.owner.displayName}
          themeMode={themeMode}
          onCycleTheme={cycleTheme}
          mobileOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onLogout={() => void logout()}
        />

        <div
          className={clsx(
            styles.mobileScrim,
            (sidebarOpen || detailsOpen) && styles.mobileScrimVisible,
          )}
          onClick={closeDrawers}
          role="presentation"
        />

        <div className={styles.center}>
          <header className={styles.topbar}>
            <div className={styles.topbarLeft}>
              <button
                type="button"
                className={styles.mobileMenu}
                onClick={() => setSidebarOpen(true)}
                aria-label="打开导航"
              >
                <Icon name="menu" />
              </button>
              <nav className={styles.breadcrumb} aria-label="当前位置">
                <span>MoYu</span>
                <span className={styles.breadcrumbSeparator}>/</span>
                <span>{mode === 'work' ? 'Work' : 'Chat'}</span>
                {selectedRepository ? (
                  <>
                    <span className={styles.breadcrumbSeparator}>/</span>
                    <strong>{selectedRepository.fullName}</strong>
                  </>
                ) : null}
              </nav>
            </div>

            <div className={styles.topbarRight}>
              <span className={styles.sessionPill} title="会话长期保持，可随时撤销">
                <span className={styles.sessionDot} aria-hidden="true" />
                已登录
              </span>
              <button
                type="button"
                className={styles.topbarButton}
                onClick={() => setActivityOpen(true)}
                aria-label="打开活动中心"
                title="活动中心"
              >
                <Icon name="bell" />
                <span className={styles.topbarBadge}>0</span>
              </button>
              <button
                type="button"
                className={clsx(styles.topbarButton, detailsOpen && styles.topbarButtonActive)}
                onClick={() => setDetailsOpen((current) => !current)}
                aria-label={detailsOpen ? '收起右侧详情' : '展开右侧详情'}
                aria-expanded={detailsOpen}
                title={detailsOpen ? '收起详情' : '展开详情'}
              >
                <Icon name="panel" />
              </button>
            </div>
          </header>

          <main id="main-content" className={styles.main} tabIndex={-1}>
            <ConversationPane
              mode={mode}
              repository={selectedRepository}
              onOpenDetails={() => setDetailsOpen(true)}
            />
          </main>

          <Composer mode={mode} repository={selectedRepository} />
        </div>

        <DetailsPanel
          open={detailsOpen}
          repository={selectedRepository}
          onClose={() => setDetailsOpen(false)}
        />
      </div>

      {settingsOpen ? (
        <SettingsDialog
          me={me}
          authState={authState}
          onClose={() => setSettingsOpen(false)}
          onRefreshMe={onRefreshMe}
          onLoggedOut={onLoggedOut}
          onSessionLost={onSessionLost}
        />
      ) : null}

      {activityOpen ? <ActivityDialog onClose={() => setActivityOpen(false)} /> : null}
    </div>
  );
}
