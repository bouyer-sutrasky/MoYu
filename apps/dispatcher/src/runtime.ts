import type pg from 'pg';

import {
  RuntimeBridgeClient,
  RuntimeBridgeError,
  decodeModelId,
  encodeModelId,
  resolveRepositoryCredentials,
} from '@moyu/runtime-client';

import type { DispatcherConfig } from './config';

export interface RepositoryBinding {
  id: string;
  fullName: string;
  defaultBranch: string;
  bridgeUrl: string | null;
  bridgeCredentialRef: string | null;
}

interface RepositoryRow {
  id: string;
  full_name: string;
  default_branch: string;
  bridge_url: string | null;
  bridge_credential_ref: string | null;
  instance_state: string | null;
}

function toBinding(row: RepositoryRow): RepositoryBinding {
  return {
    id: row.id,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    bridgeUrl: row.bridge_url,
    bridgeCredentialRef: row.bridge_credential_ref,
  };
}

/**
 * Repositories whose runtime is online. The supervisor projection is
 * authoritative; a legacy single-repository deployment with no instance row
 * still binds through BRIDGE_REPOSITORY.
 */
export async function listActiveRepositories(
  pool: pg.Pool,
  config: DispatcherConfig,
): Promise<RepositoryBinding[]> {
  const result = await pool.query<RepositoryRow>(
    `select r.id, r.full_name, r.default_branch, r.bridge_url, r.bridge_credential_ref,
            i.state as instance_state
       from repositories r
       left join repository_instances i on i.repository_id = r.id
      where r.bridge_url is not null
        and (i.state = 'online'
             or (i.repository_id is null and r.full_name = $1 and r.status = 'active'))
      order by r.full_name`,
    [config.bridgeRepository ?? ''],
  );
  return result.rows.map(toBinding);
}

/** Resolves one repository binding by id or by the configured full name. */
export async function resolveRepository(
  pool: pg.Pool,
  config: DispatcherConfig,
): Promise<RepositoryBinding | null> {
  const repositories = await listActiveRepositories(pool, config);
  if (config.bridgeRepository) {
    return repositories.find((row) => row.fullName === config.bridgeRepository) ?? null;
  }
  return repositories[0] ?? null;
}

/** Resolves credentials per repository; a global token cannot serve another repository. */
export function bridgeToken(config: DispatcherConfig, repository: RepositoryBinding): string {
  return resolveRepositoryCredentials(repository, {
    ...(config.runtimeCredentialsDir ? { credentialsDir: config.runtimeCredentialsDir } : {}),
    ...(config.bridgeRepository ? { legacyRepository: config.bridgeRepository } : {}),
    legacyBridgeUrl: config.bridgeUrl ?? null,
    legacyBridgeToken: config.bridgeToken ?? null,
  }).bridgeToken;
}

export function bridgeClient(
  config: DispatcherConfig,
  repository: RepositoryBinding,
): RuntimeBridgeClient {
  const credentials = resolveRepositoryCredentials(repository, {
    ...(config.runtimeCredentialsDir ? { credentialsDir: config.runtimeCredentialsDir } : {}),
    ...(config.bridgeRepository ? { legacyRepository: config.bridgeRepository } : {}),
    legacyBridgeUrl: config.bridgeUrl ?? null,
    legacyBridgeToken: config.bridgeToken ?? null,
  });
  return new RuntimeBridgeClient({
    baseUrl: credentials.bridgeUrl,
    token: credentials.bridgeToken,
    timeoutMs: 30_000,
  });
}

export function isRetryableBridgeError(error: unknown): boolean {
  return error instanceof RuntimeBridgeError ? error.retryable : true;
}

export function bridgeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

export { RuntimeBridgeError, decodeModelId, encodeModelId };
