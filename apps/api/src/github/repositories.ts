import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { GithubRepositorySummary } from '@moyu/contracts';

import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';

const execFileAsync = promisify(execFile);

interface GithubApiRepository {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  permissions?: { admin?: boolean; push?: boolean; maintain?: boolean };
}

function ghErrorCode(error: unknown): number | null {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr !== 'string') return null;
  if (/\b404\b|Not Found/i.test(stderr)) return 404;
  if (/\b403\b|Forbidden|Resource not accessible/i.test(stderr)) return 403;
  if (/\b401\b|Bad credentials/i.test(stderr)) return 401;
  return null;
}

async function ghJson<T>(config: ApiConfig, args: string[], timeoutMs = 15_000): Promise<T> {
  try {
    const { stdout } = await execFileAsync(config.githubCli, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        // Never let a caller-provided token redefine the dedicated account.
        GH_TOKEN: undefined,
      },
    });
    return JSON.parse(stdout) as T;
  } catch (error) {
    const code = ghErrorCode(error);
    if (code === 404) {
      throw ApiProblem.forbidden(
        'The dedicated GitHub account cannot access this repository or it does not exist',
      );
    }
    if (code === 401) {
      throw ApiProblem.unavailable('The dedicated GitHub account is not authenticated');
    }
    if (code === 403) {
      throw ApiProblem.forbidden(
        'The dedicated GitHub account does not have the required repository permission',
      );
    }
    throw ApiProblem.unavailable(
      'GitHub is temporarily unavailable; the repository was not changed',
    );
  }
}

function toSummary(repository: GithubApiRepository): GithubRepositorySummary {
  return {
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    private: repository.private,
    permissions: {
      push: repository.permissions?.push === true || repository.permissions?.admin === true,
      admin: repository.permissions?.admin === true,
    },
  };
}

/**
 * Lists repositories the dedicated account can actually see. The account's own
 * GitHub permission is the authoritative filter; the platform never invents a
 * repository or accepts one the account cannot read.
 */
export async function listGithubRepositories(
  config: ApiConfig,
  options: { q?: string; limit: number },
): Promise<{ repositories: GithubRepositorySummary[]; hasMore: boolean }> {
  const repositories = await ghJson<GithubApiRepository[]>(config, [
    'api',
    '--paginate',
    '--slurp',
    'user/repos?per_page=100&affiliation=owner,collaborator,organization_member',
  ]);
  const flattened = Array.isArray(repositories)
    ? repositories.flatMap((entry) =>
        Array.isArray(entry) ? (entry as unknown as GithubApiRepository[]) : [entry],
      )
    : [];
  const query = options.q?.trim().toLowerCase();
  const filtered = flattened
    .filter((repository) => repository.full_name)
    .filter((repository) => !query || repository.full_name.toLowerCase().includes(query))
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
  return {
    repositories: filtered.slice(0, options.limit).map(toSummary),
    hasMore: filtered.length > options.limit,
  };
}

/** Reads one repository and proves the dedicated account can push to it. */
export async function requireWritableGithubRepository(
  config: ApiConfig,
  fullName: string,
): Promise<GithubRepositorySummary & { githubRepositoryId: number }> {
  const repository = await ghJson<GithubApiRepository>(config, ['api', `repos/${fullName}`]);
  if (repository.full_name.toLowerCase() !== fullName.toLowerCase()) {
    throw ApiProblem.forbidden('GitHub returned a different repository than requested');
  }
  const summary = toSummary(repository);
  if (!summary.permissions.push) {
    throw ApiProblem.forbidden(
      'The dedicated GitHub account needs write (push) permission on this repository',
    );
  }
  return { ...summary, githubRepositoryId: repository.id };
}
