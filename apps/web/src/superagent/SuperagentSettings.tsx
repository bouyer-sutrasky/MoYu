/**
 * Mounts the vendored Superagent settings groups inside MoYu.
 *
 * The components, the draft/save state machine, the conflict handling and the
 * configuration history are the upstream ones. What this file adds is MoYu's
 * context: a repository scope, the locale function, an internal route state for
 * the group navigation, and an instance-level Deployment form adapter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ConfigForm, DeploymentSnapshot, SettingsGroup } from './contract';
import { SettingsPage } from './client/settings';
import { PanelProvider, usePanelData } from './client/provider';
import type { Route } from './client/route';
import { t } from './i18n';
import { setSuperagentScope } from './transport';

/** The Deployment group's snapshot/subscribe/mutate, backed by the instance adapter. */
class DeploymentForm implements ConfigForm<Record<string, unknown>> {
  private snapshot: DeploymentSnapshot<Record<string, unknown>> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly repositoryId: string) {}

  getSnapshot(): DeploymentSnapshot<Record<string, unknown>> | undefined {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  async reload(): Promise<void> {
    try {
      const response = await fetch(
        `/api/v1/repositories/${encodeURIComponent(this.repositoryId)}/superagent/deployment`,
        { headers: { accept: 'application/json' } },
      );
      if (!response.ok) {
        this.snapshot = undefined;
        this.emit();
        return;
      }
      const body = (await response.json()) as {
        data?: DeploymentSnapshot<Record<string, unknown>>;
      };
      this.snapshot = body.data;
    } catch {
      this.snapshot = undefined;
    }
    this.emit();
  }

  async mutate(ops: Array<Record<string, unknown>>, revision: number): Promise<boolean> {
    const response = await fetch(
      `/api/v1/repositories/${encodeURIComponent(this.repositoryId)}/superagent/deployment`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, revision }),
      },
    );
    if (!response.ok) return false;
    await this.reload();
    return true;
  }
}

function SettingsBody({
  group,
  deploymentForm,
}: {
  group: SettingsGroup;
  deploymentForm: ConfigForm<Record<string, unknown>>;
}) {
  const { state } = usePanelData();
  useEffect(() => {
    if (group === 'deployment') void (deploymentForm as DeploymentForm).reload();
  }, [group, deploymentForm]);

  if (!state) return <p className="dt-hint">正在读取运行时状态…</p>;
  const pageForm =
    group === 'deployment'
      ? {
          get state() {
            return deploymentForm.getSnapshot();
          },
          mutate: (ops: Array<Record<string, unknown>>, revision: number) =>
            deploymentForm.mutate(ops, revision),
        }
      : undefined;
  return <SettingsPage group={group} query={{}} state={state} deploymentForm={pageForm} />;
}

export function SuperagentSettings({
  repositoryId,
  repositoryName,
}: {
  repositoryId: string | null;
  repositoryName: string | null;
}) {
  const [group, setGroup] = useState<SettingsGroup>('source');

  useEffect(() => {
    // The scope is set before the first panel poll starts, so a late response for
    // the previous repository cannot land in the new one's tree.
    setSuperagentScope(repositoryId);
    setGroup('source');
  }, [repositoryId]);

  const navigate = useCallback((route: Route) => {
    if (route.page === 'settings') setGroup(route.query.group);
  }, []);

  const deploymentForm = useMemo(() => new DeploymentForm(repositoryId ?? ''), [repositoryId]);

  if (!repositoryId) {
    return <p className="dt-hint">先在左侧选择一个仓库，再配置它的 Superagent。</p>;
  }
  return (
    <div className="dt-scope">
      <p className="dt-hint">
        正在配置 <strong>{repositoryName ?? repositoryId}</strong> 的独立实例；A 与 B
        的配置互不影响。
      </p>
      <PanelProvider t={t} interval={5000} navigate={navigate}>
        {/* key: switching repository remounts the tree so no draft or late response leaks across. */}
        <SettingsBody key={repositoryId} group={group} deploymentForm={deploymentForm} />
      </PanelProvider>
    </div>
  );
}
