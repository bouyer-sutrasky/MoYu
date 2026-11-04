import type { ApiConfig } from '../config';
import type { Repository } from '@moyu/db';
import {
  RuntimeBridgeClient,
  resolveRepositoryCredentials,
  verifyRepositoryCallbackToken,
} from '@moyu/runtime-client';

/**
 * Resolves one repository's Bridge credentials. The database stores only a
 * reference (`file:<name>` or an environment name); a global URL/token is a
 * legacy fallback for the single BRIDGE_REPOSITORY row and never applies to a
 * repository added through M5.
 */
export function resolveBridgeCredentials(
  config: ApiConfig,
  repository: Repository,
): { bridgeUrl: string; bridgeToken: string } {
  return resolveRepositoryCredentials(repository, {
    ...(config.runtimeCredentialsDir ? { credentialsDir: config.runtimeCredentialsDir } : {}),
    ...(config.bridgeRepository ? { legacyRepository: config.bridgeRepository } : {}),
    legacyBridgeUrl: config.bridgeUrl ?? null,
    legacyBridgeToken: config.bridgeToken ?? null,
  });
}

export function resolveBridgeToken(config: ApiConfig, repository: Repository): string {
  return resolveBridgeCredentials(config, repository).bridgeToken;
}

export function createBridgeClient(config: ApiConfig, repository: Repository): RuntimeBridgeClient {
  const credentials = resolveBridgeCredentials(config, repository);
  return new RuntimeBridgeClient({
    baseUrl: credentials.bridgeUrl,
    token: credentials.bridgeToken,
    timeoutMs: config.bridgeTimeoutMs,
  });
}

/** Verifies the callback token against the repository that owns the conversation. */
export function verifyCallbackToken(
  config: ApiConfig,
  repository: Repository,
  supplied: string,
): boolean {
  return verifyRepositoryCallbackToken(supplied, repository, {
    ...(config.runtimeCredentialsDir ? { credentialsDir: config.runtimeCredentialsDir } : {}),
    ...(config.bridgeRepository ? { legacyRepository: config.bridgeRepository } : {}),
    legacyCallbackToken: config.bridgeCallbackToken ?? null,
  });
}
