/**
 * Mounts the vendored Superagent settings groups inside MoYu.
 *
 * The components, the draft/save state machine, the conflict handling and the
 * configuration history are the upstream ones. What this file adds is MoYu's
 * context: a repository scope, the locale function, an internal route state for
 * the group navigation, and an instance-level Deployment form adapter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ConfigForm,
  DeploymentMutationResult,
  DeploymentSnapshot,
  SettingsGroup,
} from './contract';
import { SettingsPage } from './client/settings';
import { usePageForm } from './client/deployment';
import { PanelProvider, usePanelData } from './client/provider';
import type { Route } from './client/route';
import { t } from './i18n';

/** The Deployment group's snapshot/subscribe/mutate, backed by the instance adapter. */
class DeploymentForm implements ConfigForm<Record<string, unknown>> {
  private snapshot: DeploymentSnapshot<Record<string, unknown>> | undefined;
  private readonly listeners = new Set<() => void>();
  private readAbort: AbortController | undefined;

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
    this.readAbort?.abort();
    const controller = new AbortController();
    this.readAbort = controller;
    const previous = this.snapshot;
    try {
      const response = await fetch(
        `/api/v1/repositories/${encodeURIComponent(this.repositoryId)}/superagent/deployment`,
        { headers: { accept: 'application/json' }, signal: controller.signal },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: unknown } | string;
        };
        const error =
          typeof body.error === 'string'
            ? body.error
            : typeof body.error?.message === 'string'
              ? body.error.message
              : `Deployment read failed (HTTP ${response.status})`;
        this.snapshot = previous
          ? { ...previous, status: 'unavailable', writable: false, error }
          : {
              status: 'unavailable',
              writable: false,
              mode: 'config',
              revision: -1,
              value: {},
              error,
            };
        this.emit();
        return;
      }
      const body = (await response.json()) as {
        data?: DeploymentSnapshot<Record<string, unknown>>;
      };
      if (body.data) {
        this.snapshot = { ...body.data, savedPendingReadback: false };
        this.emit();
      }
    } catch (failure) {
      if (controller.signal.aborted) return;
      const error = failure instanceof Error ? failure.message : String(failure);
      this.snapshot = previous
        ? { ...previous, status: 'unavailable', writable: false, error }
        : {
            status: 'unavailable',
            writable: false,
            mode: 'config',
            revision: -1,
            value: {},
            error,
          };
      this.emit();
    }
  }

  async mutate(
    ops: Array<Record<string, unknown>>,
    revision: number,
  ): Promise<DeploymentMutationResult> {
    const expectedInstanceId = this.snapshot?.instanceId;
    if (!expectedInstanceId) {
      return {
        saved: false,
        revision,
        restarting: false,
        error: 'The Deployment snapshot is not bound to an instance; reload before saving',
      };
    }
    let response: Response;
    try {
      response = await fetch(
        `/api/v1/repositories/${encodeURIComponent(this.repositoryId)}/superagent/deployment`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ops, revision, expectedInstanceId }),
        },
      );
    } catch (failure) {
      return {
        saved: false,
        revision,
        restarting: false,
        error: failure instanceof Error ? failure.message : String(failure),
      };
    }
    const body = (await response.json().catch(() => ({}))) as {
      data?: {
        saved?: boolean;
        revision?: number;
        restarting?: boolean;
        restartRequired?: boolean;
        restartRefused?: string | null;
      };
      error?: { message?: unknown; revision?: number } | string;
      revision?: number;
    };
    if (!response.ok) {
      const error =
        typeof body.error === 'string'
          ? body.error
          : typeof body.error?.message === 'string'
            ? body.error.message
            : `Deployment save failed (HTTP ${response.status})`;
      return {
        saved: false,
        revision: typeof body.revision === 'number' ? body.revision : revision,
        restarting: false,
        error,
      };
    }
    const data = body.data ?? {};
    const result: DeploymentMutationResult = {
      saved: data.saved === true,
      revision: typeof data.revision === 'number' ? data.revision : revision,
      restarting: data.restarting === true,
      restartRequired: data.restartRequired === true,
      restartRefused: data.restartRefused ?? null,
      readbackPending: true,
    };
    if (this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        revision: result.revision,
        savedPendingReadback: true,
        error: undefined,
      };
      this.emit();
    }
    // The save is already committed. A failed readback must not turn it into a
    // false "save failed" and tempt the browser to send the PUT again.
    void this.reload();
    return result;
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
  // useSyncExternalStore is what makes reload()/mutate() actually reach the
  // Deployment page; a plain getter would keep rendering the first snapshot.
  const pageForm = usePageForm(deploymentForm);
  useEffect(() => {
    if (group === 'deployment') void (deploymentForm as DeploymentForm).reload();
  }, [group, deploymentForm]);

  if (!state) return <p className="dt-hint">正在读取运行时状态…</p>;
  return (
    <SettingsPage
      group={group}
      query={{}}
      state={state}
      deploymentForm={group === 'deployment' ? pageForm : undefined}
    />
  );
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
      <PanelProvider
        key={repositoryId}
        repositoryId={repositoryId}
        t={t}
        interval={5000}
        navigate={navigate}
      >
        {/* The provider key remounts the poll/draft state; the caller also captures
            repositoryId, so an in-flight request for A can never write into B. */}
        <SettingsBody group={group} deploymentForm={deploymentForm} />
      </PanelProvider>
    </div>
  );
}
