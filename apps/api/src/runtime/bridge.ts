import type { ApiConfig } from '../config';
import type { Repository } from '@moyu/db';
import { RuntimeBridgeClient } from '@moyu/runtime-client';

/**
 * Resolves the machine token for a repository binding. The database stores a
 * reference name, never the secret; the value comes from the process
 * environment so it cannot leak through an API response.
 */
export function resolveBridgeToken(config: ApiConfig, repository: Repository): string {
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

export function createBridgeClient(config: ApiConfig, repository: Repository): RuntimeBridgeClient {
  const baseUrl = repository.bridgeUrl ?? config.bridgeUrl;
  if (!baseUrl) {
    throw new Error(`Repository ${repository.fullName} has no Bridge endpoint`);
  }
  return new RuntimeBridgeClient({
    baseUrl,
    token: resolveBridgeToken(config, repository),
    timeoutMs: config.bridgeTimeoutMs,
  });
}
