import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { SupervisorConfig } from './config';

export interface RemovalPath {
  path: string;
  /** The configured root this path must stay inside. */
  root: string;
}

export interface RemovalResult {
  removed: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Resolves the nearest existing ancestor and appends the non-existing tail. This
 * catches an intermediate symlink that leaves the configured root: a lexical
 * `resolve()` alone would accept `root/link/secret` even when `link` points
 * outside. The target itself may be a symlink; removing that link is safe
 * because `rmSync` does not follow it.
 */
function realTargetThroughParents(path: string): string {
  const target = resolve(path);
  let existing = dirname(target);
  const tail = [basename(target)];
  while (!lexists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...tail);
  } catch {
    return target;
  }
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function insideReal(root: string, candidate: string): boolean {
  const real = realRoot(root);
  const target = realTargetThroughParents(candidate);
  const rel = relative(real, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function entry(root: string, ...parts: string[]): RemovalPath {
  return { path: join(root, ...parts), root };
}

/**
 * The local resources owned by one repository instance. Paths are derived from
 * the supervisor's own configuration and the stored profile, never from a
 * request. Pinned runtime homes are included only when configured for this
 * repository, and every path must stay inside one of the allowed roots.
 */
export function repositoryRemovalPaths(
  config: SupervisorConfig,
  repositoryId: string,
  profile: string,
  pinnedRuntimeHome?: string | null,
): RemovalPath[] {
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error(`Refusing to remove resources for an invalid profile: ${profile}`);
  }
  if (!/^[0-9a-f-]{36}$/i.test(repositoryId)) {
    throw new Error(`Refusing to remove resources for an invalid repository id: ${repositoryId}`);
  }
  const dshHome = resolve(config.dshHome);
  const homesRoot = join(dirname(dshHome), 'homes');
  const worktreeRoot = resolve(config.worktreeRoot);
  const candidates: RemovalPath[] = [
    entry(dshHome, 'profiles', profile),
    entry(dshHome, 'homes', profile),
    entry(dshHome, 'state', profile),
    entry(dshHome, 'state', `${profile}.lock`),
    entry(homesRoot, profile),
    entry(worktreeRoot, profile),
    entry(config.credentialsDir, `${repositoryId}.json`),
    entry(config.instanceEnvDir, `${repositoryId}.env`),
    entry(config.logDir, `${profile}.log`),
  ];
  if (pinnedRuntimeHome && isAbsolute(pinnedRuntimeHome)) {
    candidates.push({ path: resolve(pinnedRuntimeHome), root: homesRoot });
  }
  const seen = new Set<string>();
  return candidates.filter((item) => {
    const target = resolve(item.path);
    if (seen.has(target)) return false;
    seen.add(target);
    // Never delete a configured root itself, and never leave the allowed tree
    // through `..` or a symlinked parent.
    return target !== resolve(item.root) && insideReal(item.root, target);
  });
}

/** Deletes every existing path; a missing path is already clean, not an error. */
export function removeRepositoryPaths(entries: readonly RemovalPath[]): RemovalResult {
  const removed: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const item of entries) {
    const target = resolve(item.path);
    if (!insideReal(item.root, target)) {
      errors.push({ path: target, error: 'refused: outside the configured root' });
      continue;
    }
    if (!lexists(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      errors.push({
        path: target,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    }
  }
  return { removed, errors };
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True for an absolute path that is not a filesystem or configured root. */
export function safeRemovalTarget(root: string, candidate: string): boolean {
  return resolve(candidate) !== resolve(root) && insideReal(root, candidate);
}
