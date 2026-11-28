import type { RepositorySummary } from '@moyu/contracts';

import { ResponsiveSelect } from '../components/ResponsiveSelect';
import { SuperagentSettings } from '../superagent/SuperagentSettings';
import type { SettingsGroup } from '../superagent/contract';
import type { WorkspaceSettingsRoute } from './workspaceRoute';
import styles from './WorkspaceShell.module.css';

export function SuperagentPage({
  repositories,
  repositoryId,
  route,
  loading,
  error,
  onReload,
  onRepositoryChange,
  onNavigate,
  onAdd,
  onSessionLost,
}: {
  repositories: RepositorySummary[];
  repositoryId: string | null;
  route: WorkspaceSettingsRoute;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onRepositoryChange: (id: string) => void;
  onNavigate: (query: { group: SettingsGroup; source?: string; version?: string }) => void;
  onAdd: () => void;
  onSessionLost: () => void;
}) {
  return (
    <div className={styles.superagentPage}>
      <header className={styles.pageHeader}>
        <h1>SuperAgent</h1>
        {repositoryId ? (
          <ResponsiveSelect
            id="superagent-repository"
            label="目标仓库"
            className={styles.superagentRepository}
            value={repositoryId}
            options={repositories.map(({ id, fullName }) => ({ value: id, label: fullName }))}
            onChange={onRepositoryChange}
          />
        ) : null}
      </header>
      {error ? (
        <div className={styles.sectionError} role="alert">
          <p>{error}</p>
          <button type="button" className={styles.textButton} onClick={onReload}>
            重试
          </button>
        </div>
      ) : null}
      {repositoryId ? (
        <SuperagentSettings
          repositoryId={repositoryId}
          group={route.group ?? 'source'}
          source={route.source}
          version={route.version}
          onNavigate={onNavigate}
          onSessionLost={onSessionLost}
        />
      ) : loading ? (
        <p role="status">正在读取仓库…</p>
      ) : (
        <button type="button" className={styles.secondaryButton} onClick={onAdd}>
          添加仓库
        </button>
      )}
    </div>
  );
}
