import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveRepositoryCredentials,
  sha256Hex,
  verifyRepositoryCallbackToken,
} from '../src/credentials';

const directories: string[] = [];

function credentialDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'moyu-credentials-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const baseRow = {
  id: 'repo-a',
  fullName: 'acme/a',
  bridgeUrl: 'http://127.0.0.1:3401',
  bridgeCredentialRef: 'file:repo-a.json',
  bridgeCallbackTokenHash: sha256Hex('callback-token-a-0123456789'),
};

describe('repository credentials', () => {
  it('reads a 0600 file credential and keeps the repository endpoint', () => {
    const directory = credentialDir();
    writeFileSync(
      join(directory, 'repo-a.json'),
      JSON.stringify({
        bridgeUrl: baseRow.bridgeUrl,
        bridgeToken: 'bridge-token-a-0123456789',
        callbackToken: 'callback-token-a-0123456789',
      }),
      { mode: 0o600 },
    );
    expect(resolveRepositoryCredentials(baseRow, { credentialsDir: directory })).toEqual({
      bridgeUrl: baseRow.bridgeUrl,
      bridgeToken: 'bridge-token-a-0123456789',
    });
  });

  it('refuses a credential file readable by group or others', () => {
    const directory = credentialDir();
    const path = join(directory, 'repo-a.json');
    writeFileSync(path, JSON.stringify({ bridgeToken: 'bridge-token-a-0123456789' }));
    chmodSync(path, 0o644);
    expect(() => resolveRepositoryCredentials(baseRow, { credentialsDir: directory })).toThrow(
      /group\/world/,
    );
  });

  it('does not apply the global token to a different repository', () => {
    const row = { ...baseRow, bridgeCredentialRef: null };
    expect(() =>
      resolveRepositoryCredentials(row, {
        legacyRepository: 'acme/b',
        legacyBridgeUrl: 'http://127.0.0.1:3403',
        legacyBridgeToken: 'legacy-token-0123456789',
      }),
    ).toThrow(/No Bridge token/);
  });

  it('allows the global fallback only for the configured legacy repository', () => {
    const row = { ...baseRow, bridgeCredentialRef: null };
    expect(
      resolveRepositoryCredentials(row, {
        legacyRepository: row.fullName,
        legacyBridgeToken: 'legacy-token-0123456789',
      }),
    ).toEqual({ bridgeUrl: baseRow.bridgeUrl, bridgeToken: 'legacy-token-0123456789' });
  });

  it('verifies a callback token only for the repository that owns its hash', () => {
    expect(verifyRepositoryCallbackToken('callback-token-a-0123456789', baseRow)).toBe(true);
    expect(verifyRepositoryCallbackToken('callback-token-b-0123456789', baseRow)).toBe(false);
    expect(verifyRepositoryCallbackToken('', baseRow)).toBe(false);
  });
});
