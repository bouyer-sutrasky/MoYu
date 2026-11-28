import type { SettingsGroup } from '../superagent/contract';

/**
 * Addressable workbench state. The repository and conversation live in the
 * query string so a refresh or a browser Back restores the exact place the
 * owner was looking at, and a link can point at one conversation. The settings
 * page keeps its own repository independent from the workbench repository:
 * opening beta settings from alpha must not switch the task list to beta.
 *
 * Parsing never trusts a value. Only ids shaped like UUIDs and the known
 * section/group names survive; every other value is dropped and the caller
 * resolves the remaining target against the owner's actual repositories
 * before it falls back to the first repository.
 */
export const WORKSPACE_SETTINGS_SECTIONS = [
  'appearance',
  'activity',
  'history',
  'account',
  'notifications',
  'cleanup',
  'superagent',
  'passkeys',
  'sessions',
  'security',
] as const;

export type WorkspaceSettingsSection = (typeof WORKSPACE_SETTINGS_SECTIONS)[number];

export const SUPERAGENT_GROUPS = [
  'source',
  'eval',
  'execution',
  'prompts',
  'deployment',
] as const satisfies readonly SettingsGroup[];

export interface WorkspaceSettingsRoute {
  section: WorkspaceSettingsSection;
  /** Repository whose Superagent instance the settings show; not the workbench repository. */
  repositoryId: string | null;
  group: SettingsGroup | null;
  source?: string;
  version?: string;
}

export interface WorkspaceRoute {
  repositoryId: string | null;
  conversationId: string | null;
  settings: WorkspaceSettingsRoute | null;
  repositories?: { repositoryId: string | null } | undefined;
}

const EMPTY_ROUTE: WorkspaceRoute = { repositoryId: null, conversationId: null, settings: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queryValue(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value && value.length <= 200 ? value : null;
}

function uuidValue(params: URLSearchParams, name: string): string | null {
  const value = queryValue(params, name);
  return value && UUID.test(value) ? value : null;
}

function isSettingsSection(value: string | null): value is WorkspaceSettingsSection {
  return value !== null && (WORKSPACE_SETTINGS_SECTIONS as readonly string[]).includes(value);
}

function isSettingsGroup(value: string | null): value is SettingsGroup {
  return value !== null && (SUPERAGENT_GROUPS as readonly string[]).includes(value);
}

/** Reads addressable state from a location search string (`?a=b` or `a=b`). */
export function parseWorkspaceRoute(search: string): WorkspaceRoute {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const repositoryId = uuidValue(params, 'repo');
  const conversationId = uuidValue(params, 'conversation');
  const settingsName = queryValue(params, 'settings');

  if (params.get('view') === 'repositories') {
    return {
      ...EMPTY_ROUTE,
      repositoryId,
      conversationId,
      repositories: { repositoryId: uuidValue(params, 'manageRepo') },
    };
  }
  if (!isSettingsSection(settingsName)) {
    return { ...EMPTY_ROUTE, repositoryId, conversationId };
  }
  const groupName = queryValue(params, 'group');
  const source = settingsName === 'superagent' ? queryValue(params, 'source') : null;
  const version = settingsName === 'superagent' ? queryValue(params, 'version') : null;
  return {
    repositoryId,
    conversationId,
    settings: {
      section: settingsName,
      repositoryId: uuidValue(params, 'settingsRepo'),
      group: isSettingsGroup(groupName) ? groupName : null,
      ...(source ? { source } : {}),
      ...(version ? { version } : {}),
    },
  };
}

/** Serializes the route in a stable order; an empty result means the bare path. */
export function workspaceRouteSearch(route: WorkspaceRoute): string {
  const params = new URLSearchParams();
  if (route.repositoryId) params.set('repo', route.repositoryId);
  if (route.conversationId) params.set('conversation', route.conversationId);
  if (route.repositories) {
    params.set('view', 'repositories');
    if (route.repositories.repositoryId) params.set('manageRepo', route.repositories.repositoryId);
  } else if (route.settings) {
    params.set('settings', route.settings.section);
    if (route.settings.repositoryId) params.set('settingsRepo', route.settings.repositoryId);
    if (route.settings.group) params.set('group', route.settings.group);
    if (route.settings.section === 'superagent') {
      if (route.settings.source) params.set('source', route.settings.source);
      if (route.settings.version) params.set('version', route.settings.version);
    }
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}

/** Builds the addressable location for a route below the current path. */
export function workspaceRouteUrl(pathname: string, route: WorkspaceRoute, hash = ''): string {
  return `${pathname}${workspaceRouteSearch(route)}${hash}`;
}

export function sameWorkspaceRoute(left: WorkspaceRoute, right: WorkspaceRoute): boolean {
  return workspaceRouteSearch(left) === workspaceRouteSearch(right);
}

/**
 * A restore target is canonicalized away only when the platform confirmed it
 * is missing or forbidden. A network failure, a timeout or a 5xx says nothing
 * about the target: the address must stay so a refresh or retry can reach it
 * after recovery.
 */
export function isPermanentTargetFailure(status: number | null): boolean {
  return status === 403 || status === 404;
}
