import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A repository row's non-secret credential reference. The platform never stores
 * a raw Bridge token: it stores `file:<name>` (a 0600 JSON file owned by the
 * supervisor) or an environment variable name.
 */
export interface RepositoryCredentialRow {
  id: string;
  fullName: string;
  bridgeUrl: string | null;
  bridgeCredentialRef: string | null;
  bridgeCallbackTokenHash?: string | null;
}

export interface RepositoryCredentialOptions {
  /** Directory that owns supervisor-written instance credentials; 0700. */
  credentialsDir?: string;
  env?: Record<string, string | undefined>;
  /** Legacy single-repository deployment fields; only valid for this full name. */
  legacyRepository?: string;
  legacyBridgeUrl?: string | null;
  legacyBridgeToken?: string | null;
  legacyCallbackToken?: string | null;
}

export interface ResolvedRepositoryCredentials {
  bridgeUrl: string;
  bridgeToken: string;
}

interface CredentialFile {
  bridgeUrl?: string;
  bridgeToken?: string;
  callbackToken?: string;
}

function readCredentialFile(dir: string, name: string): CredentialFile {
  // The database stores only a single path component, never an arbitrary path.
  if (!/^[A-Za-z0-9_.-]+\.json$/.test(name)) {
    throw new Error(`Invalid repository credential file name: ${name}`);
  }
  const path = join(dir, name);
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Repository credential file must not be group/world accessible: ${path}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Repository credential file is malformed: ${path}`);
  }
  return parsed as CredentialFile;
}

function envToken(options: RepositoryCredentialOptions, reference: string): string | undefined {
  const env = options.env ?? process.env;
  const name = reference.startsWith('env:') ? reference.slice(4) : reference;
  const value = env[name];
  return value && value.length >= 16 ? value : undefined;
}

/**
 * Resolves the Bridge endpoint and token for one repository.
 *
 * A global BRIDGE_URL/BRIDGE_TOKEN is accepted only for the one legacy
 * `BRIDGE_REPOSITORY` row. Any other repository must carry its own endpoint and
 * credential reference, so repository A can never be dispatched to B's runtime
 * or presented with B's machine token.
 */
export function resolveRepositoryCredentials(
  row: RepositoryCredentialRow,
  options: RepositoryCredentialOptions = {},
): ResolvedRepositoryCredentials {
  const legacyMatches = !!options.legacyRepository && options.legacyRepository === row.fullName;
  const bridgeUrl = row.bridgeUrl ?? (legacyMatches ? options.legacyBridgeUrl : null) ?? '';
  if (!bridgeUrl) {
    throw new Error(`Repository ${row.fullName} has no Bridge endpoint`);
  }

  if (row.bridgeCredentialRef) {
    const reference = row.bridgeCredentialRef;
    if (reference.startsWith('file:')) {
      if (!options.credentialsDir) {
        throw new Error(
          `Repository ${row.fullName} uses a file credential but no directory is configured`,
        );
      }
      const file = readCredentialFile(options.credentialsDir, reference.slice('file:'.length));
      if (file.bridgeToken && file.bridgeToken.length >= 16) {
        return { bridgeUrl: file.bridgeUrl ?? bridgeUrl, bridgeToken: file.bridgeToken };
      }
      throw new Error(`Repository ${row.fullName} credential file has no Bridge token`);
    }
    const token = envToken(options, reference);
    if (token) {
      return { bridgeUrl, bridgeToken: token };
    }
    throw new Error(`Repository ${row.fullName} credential reference is not set: ${reference}`);
  }

  if (legacyMatches && options.legacyBridgeToken && options.legacyBridgeToken.length >= 16) {
    return { bridgeUrl, bridgeToken: options.legacyBridgeToken };
  }
  throw new Error(`No Bridge token is available for repository ${row.fullName}`);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Verifies a Bridge callback token for the repository that owns the target
 * conversation. A token minted for repository A cannot post into B.
 */
export function verifyRepositoryCallbackToken(
  supplied: string,
  row: RepositoryCredentialRow,
  options: RepositoryCredentialOptions = {},
): boolean {
  if (!supplied) {
    return false;
  }
  if (row.bridgeCallbackTokenHash) {
    const expected = Buffer.from(row.bridgeCallbackTokenHash, 'hex');
    const actual = Buffer.from(sha256Hex(supplied), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  // Legacy single-repository deployments used one global callback token.
  const legacyMatches = !!options.legacyRepository && options.legacyRepository === row.fullName;
  if (!legacyMatches || !options.legacyCallbackToken) {
    return false;
  }
  const expected = Buffer.from(sha256Hex(options.legacyCallbackToken), 'hex');
  const actual = Buffer.from(sha256Hex(supplied), 'hex');
  return timingSafeEqual(expected, actual);
}
