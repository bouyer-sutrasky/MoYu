import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SupervisorConfig } from '../src/config';
import { removeRepositoryPaths, repositoryRemovalPaths, safeRemovalTarget } from '../src/removal';

const repositoryId = '00000000-0000-4000-8000-000000000001';

describe('repository removal paths', () => {
  let root: string;
  let config: SupervisorConfig;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'moyu-removal-'));
    const dshHome = join(root, 'dsh');
    config = {
      dshHome,
      worktreeRoot: join(root, 'worktrees'),
      credentialsDir: join(root, 'credentials'),
      instanceEnvDir: join(root, 'instances'),
      logDir: join(root, 'logs'),
      pinned: new Map(),
    } as unknown as SupervisorConfig;
    for (const path of [
      join(dshHome, 'profiles', 'p1'),
      join(dshHome, 'homes', 'p1'),
      join(dshHome, 'state', 'p1'),
      join(root, 'homes', 'p1'),
      join(config.worktreeRoot, 'p1', '.repository.git'),
      join(config.credentialsDir),
      join(config.instanceEnvDir),
      join(config.logDir),
    ]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    writeFileSync(join(config.credentialsDir, `${repositoryId}.json`), '{}', { mode: 0o600 });
    writeFileSync(join(config.instanceEnvDir, `${repositoryId}.env`), '', { mode: 0o600 });
    writeFileSync(join(config.logDir, 'p1.log'), '', { mode: 0o600 });
    writeFileSync(join(config.worktreeRoot, 'p1', 'task.txt'), 'x');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('derives only the configured repository resources', () => {
    const paths = repositoryRemovalPaths(config, repositoryId, 'p1', join(root, 'homes', 'p1'));
    const values = paths.map((item) => item.path);
    expect(values).toContain(join(config.dshHome, 'profiles', 'p1'));
    expect(values).toContain(join(config.dshHome, 'homes', 'p1'));
    expect(values).toContain(join(config.dshHome, 'state', 'p1'));
    expect(values).toContain(join(config.worktreeRoot, 'p1'));
    expect(values).toContain(join(config.credentialsDir, `${repositoryId}.json`));
    expect(values).toContain(join(config.instanceEnvDir, `${repositoryId}.env`));
    expect(values).toContain(join(config.logDir, 'p1.log'));
    for (const item of paths) {
      expect(safeRemovalTarget(item.root, item.path)).toBe(true);
    }
  });

  it('deletes the prepared tree and files but never a configured root', () => {
    const paths = repositoryRemovalPaths(config, repositoryId, 'p1', join(root, 'homes', 'p1'));
    const result = removeRepositoryPaths(paths);
    expect(result.errors).toEqual([]);
    expect(existsSync(join(config.worktreeRoot, 'p1'))).toBe(false);
    expect(existsSync(join(config.dshHome, 'profiles', 'p1'))).toBe(false);
    expect(existsSync(join(config.credentialsDir, `${repositoryId}.json`))).toBe(false);
    expect(existsSync(config.worktreeRoot)).toBe(true);
    expect(existsSync(config.dshHome)).toBe(true);
    // A second pass is idempotent.
    expect(removeRepositoryPaths(paths)).toEqual({ removed: [], errors: [] });
  });

  it('refuses an invalid profile and an outside-root removal', () => {
    expect(() => repositoryRemovalPaths(config, repositoryId, '../escape')).toThrow(
      /invalid profile/,
    );
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    const result = removeRepositoryPaths([{ path: outside, root: config.worktreeRoot }]);
    expect(result.removed).toEqual([]);
    expect(result.errors[0]?.error).toContain('outside the configured root');
    expect(existsSync(outside)).toBe(true);
  });
});
