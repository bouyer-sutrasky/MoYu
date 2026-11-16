/**
 * MoYu transport for the vendored Superagent settings client.
 *
 * Upstream called the DSH panel origin (`/orchestrator/api/...`) because the panel
 * ran inside the runtime. In MoYu the browser owns a repository, so every call is
 * scoped to it and relayed by the API to that repository's own runtime:
 * `/api/v1/repositories/<id>/superagent/...`.
 *
 * The repository id is captured by `caller()` when the panel is created. There is
 * deliberately no module-level mutable scope: a late response must keep the URL it
 * started with, and switching repositories must not redirect an old poll to the new
 * instance.
 */

/** Endpoint names the API serves; everything else is refused before a request. */
const PATHS: Record<string, string> = {
  'policy/history': 'policy-history',
};

export function panelUrl(repositoryId: string, path: string): string {
  if (!repositoryId) {
    throw new Error('No repository is selected for Superagent settings');
  }
  const clean = path.split('?')[0] ?? path;
  const mapped = PATHS[clean] ?? clean;
  const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  return `/api/v1/repositories/${encodeURIComponent(repositoryId)}/superagent/${mapped}${query}`;
}
