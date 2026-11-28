/** Settings tab shell routing between stage settings (Sources, Eval, Execution), Prompts, and Deployment. */
import type { StateView } from './api.ts';
import { DeploymentPage, type DeploymentForm } from './deployment.tsx';
import { EvalSettings } from './eval.tsx';
import { ExecutionSettings } from './execution.tsx';
import { PromptsPage } from './prompts.tsx';
import { usePanel } from './provider.tsx';
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts';
import { SettingsProvider } from './settings-kit.tsx';
import { SourceSettings } from './source.tsx';

export function SettingsPage({
  group,
  query,
  state,
  error,
  onRetry,
  deploymentForm,
}: {
  group: SettingsGroup;
  query: { source?: string; version?: string };
  state: StateView | undefined;
  error: Error | undefined;
  onRetry: () => void;
  deploymentForm: DeploymentForm;
}) {
  const { t, navigate, repositoryId } = usePanel();
  const content = (() => {
    if (!state) {
      return error ? (
        <div role="alert">
          <p className="dt-error">{error.message}</p>
          <button type="button" className="dt-btn" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : (
        <p className="dt-hint" role="status">
          正在读取运行时状态…
        </p>
      );
    }
    switch (group) {
      case 'source':
        return (
          <SettingsProvider>
            <SourceSettings {...(query.source ? { focus: query.source } : {})} />
          </SettingsProvider>
        );
      case 'eval':
        return (
          <SettingsProvider>
            <EvalSettings version={query.version} />
          </SettingsProvider>
        );
      case 'execution':
        return (
          <SettingsProvider>
            <ExecutionSettings />
          </SettingsProvider>
        );
      case 'prompts':
        return <PromptsPage />;
      case 'deployment': {
        const instanceId = state.moyuInstanceId;
        return (
          <DeploymentPage
            key={instanceId}
            setup={state.setup}
            form={deploymentForm}
            draftKey={
              instanceId
                ? `dsh-superagent/draft/${repositoryId}/${instanceId}/deployment`
                : undefined
            }
          />
        );
      }
    }
  })();
  return (
    <div className="dt-settings">
      <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
        {SETTINGS_GROUPS.map((value) => (
          <button
            key={value}
            type="button"
            className="dt-settings-link"
            aria-current={value === group ? 'page' : undefined}
            onClick={() => navigate(settingsRoute(value), true)}
          >
            {t(`settingsGroup.${value}`)}
          </button>
        ))}
      </nav>
      <div className="dt-settings-body">
        <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
        {content}
      </div>
    </div>
  );
}
