/**
 * Platform-managed fields in an instance's own settings blocks.
 *
 * The runtime's panel accepts a whole block with a revision. The owner may edit
 * models, timeouts, blocked commands, rules and listener switches, but the
 * repository binding, the GitHub CLI, execution capacity/directory/prepare and
 * the required policy identities are platform invariants. Startup re-asserts
 * them; the write boundary must reject an attempt to change them so the owner
 * gets a 422 with a field path instead of a silent repair on the next wake.
 */

export interface ManagedProfileInvariants {
  repository: string;
  ownerId: string;
  githubAllowedUsers: string[];
  githubCli: string;
  worktreeDir: string;
  prepare: string;
}

export interface ManagedFieldIssue {
  path: string;
  message: string;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const id = record(item).id;
        return typeof id === 'string' ? [id] : [];
      })
    : [];
}

function missingIds(value: unknown, required: string[]): string[] {
  const present = new Set(ids(value));
  return required.filter((id) => !present.has(id));
}

function issue(path: string, message: string): ManagedFieldIssue {
  return { path, message };
}

export function managedSettingsIssues(
  block: string,
  value: unknown,
  invariants: ManagedProfileInvariants,
): ManagedFieldIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [issue('value', 'Settings value must be an object')];
  }
  const current = record(value);
  const issues: ManagedFieldIssue[] = [];

  if (block === 'source:workspace') {
    const config = record(current.config);
    if (current.enabled !== true) {
      issues.push(
        issue('enabled', 'The workspace Source is the platform Web entry and cannot be disabled'),
      );
    }
    if (!same(config.repository, invariants.repository)) {
      issues.push(
        issue(
          'config.repository',
          `The workspace repository is managed as ${invariants.repository}`,
        ),
      );
    }
  }

  if (block === 'source:github') {
    const config = record(current.config);
    if (!same(config.repository, invariants.repository)) {
      issues.push(
        issue('config.repository', `The GitHub repository is managed as ${invariants.repository}`),
      );
    }
    if (!same(config.cli, invariants.githubCli)) {
      issues.push(issue('config.cli', `The GitHub CLI is managed as ${invariants.githubCli}`));
    }
  }

  if (block === 'executor') {
    if (current.maxWorkers !== 1) {
      issues.push(issue('maxWorkers', 'The per-repository execution capacity is managed as 1'));
    }
    if (!same(current.directory, invariants.worktreeDir)) {
      issues.push(
        issue('directory', `The execution directory is managed as ${invariants.worktreeDir}`),
      );
    }
    if (!same(current.prepare, invariants.prepare)) {
      issues.push(issue('prepare', 'The prepare command is managed by the platform'));
    }
  }

  if (block === 'policy') {
    const sources = record(current.sources);
    const workspace = record(sources.workspace);
    const github = record(sources.github);
    const missingWorkspace = missingIds(workspace.allowed, [invariants.ownerId]);
    if (missingWorkspace.length > 0) {
      issues.push(
        issue(
          'sources.workspace.allowed',
          'The owner identity is required in the workspace policy allow-list',
        ),
      );
    }
    const missingGithub = missingIds(github.allowed, invariants.githubAllowedUsers);
    if (missingGithub.length > 0) {
      issues.push(
        issue(
          'sources.github.allowed',
          `Required GitHub identities are missing: ${missingGithub.join(', ')}`,
        ),
      );
    }
  }

  return issues;
}
