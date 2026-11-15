/**
 * MoYu transport for the vendored Superagent settings client.
 *
 * Upstream called the DSH panel origin (`/orchestrator/api/...`) because the panel
 * ran inside the runtime. In MoYu the browser owns a repository, so every call is
 * scoped to it and relayed by the API to that repository's own runtime:
 * `/api/v1/repositories/<id>/superagent/...`.
 *
 * The scope is module state rather than a prop because the vendored `caller()`
 * builds its own fetch; `setSuperagentScope` is called whenever the selected
 * repository changes, and a late response for a previous repository is dropped by
 * the caller comparing the scope it started with.
 */
let scope: string | null = null;

export function setSuperagentScope(repositoryId: string | null): void {
  scope = repositoryId;
}

export function superagentScope(): string | null {
  return scope;
}

/** Endpoint names the API serves; everything else is refused before a request. */
const PATHS: Record<string, string> = {
  'policy/history': 'policy-history',
};

export function panelUrl(path: string): string {
  if (!scope) {
    throw new Error('No repository is selected for Superagent settings');
  }
  const clean = path.split('?')[0] ?? path;
  const mapped = PATHS[clean] ?? clean;
  const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  return `/api/v1/repositories/${encodeURIComponent(scope)}/superagent/${mapped}${query}`;
}
