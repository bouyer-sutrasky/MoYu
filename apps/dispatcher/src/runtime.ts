import type pg from 'pg';

import {
  RuntimeBridgeClient,
  RuntimeBridgeError,
  decodeModelId,
  encodeModelId,
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
}

/** Resolves the configured repository row (by full name when configured, else the first bound one). */
export async function resolveRepository(
  pool: pg.Pool,
  config: DispatcherConfig,
): Promise<RepositoryBinding | null> {
  const result = config.bridgeRepository
    ? await pool.query<RepositoryRow>(
        `select id, full_name, default_branch, bridge_url, bridge_credential_ref
           from repositories where full_name = $1 limit 1`,
        [config.bridgeRepository],
      )
    : await pool.query<RepositoryRow>(
        `select id, full_name, default_branch, bridge_url, bridge_credential_ref
           from repositories where bridge_url is not null and status = 'active'
           order by updated_at desc limit 1`,
      );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    bridgeUrl: row.bridge_url,
    bridgeCredentialRef: row.bridge_credential_ref,
  };
}

/** Resolves the machine token by environment reference; never reads it from the database. */
export function bridgeToken(config: DispatcherConfig, repository: RepositoryBinding): string {
  const reference = repository.bridgeCredentialRef ?? config.bridgeCredentialRef;
  if (reference) {
    const value = process.env[reference];
    if (value && value.length >= 16) {
      return value;
    }
  }
  if (config.bridgeToken) {
    return config.bridgeToken;
  }
  throw new Error(`No Bridge token is available for repository ${repository.fullName}`);
}

export function bridgeClient(
  config: DispatcherConfig,
  repository: RepositoryBinding,
): RuntimeBridgeClient {
  const baseUrl = config.bridgeUrl ?? repository.bridgeUrl;
  if (!baseUrl) {
    throw new Error(`Repository ${repository.fullName} has no Bridge endpoint`);
  }
  return new RuntimeBridgeClient({
    baseUrl,
    token: bridgeToken(config, repository),
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
