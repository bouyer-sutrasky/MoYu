import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SupervisorConfig } from '../src/config';
import type { SupervisorStore } from '../src/store';
import { __test, createCleanupService } from '../src/cleanup';

const directories: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  directories.push(directory);
  return directory;
}

function git(directory: string, args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

/** A real worktree whose branch and commit are pushed to a local bare remote. */
function pushedRepository(root: string, ticketId: string): string {
  const directory = join(root, 'probe1', `task-${ticketId.slice(0, 12)}`);
  const remote = temporary('moyu-cleanup-remote');
  mkdirSync(directory, { recursive: true });
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.email', 'cleanup@example.invalid']);
  git(directory, ['config', 'user.name', 'Cleanup Test']);
  writeFileSync(join(directory, 'keep.txt'), 'one\ntwo\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-q', '-m', 'initial commit']);
  git(directory, ['remote', 'add', 'origin', remote]);
  git(directory, ['push', '-q', '-u', 'origin', 'main']);
  return directory;
}

function service(root: string, profile = 'probe1') {
  const store = {
    getInstance: async () => ({ profile }),
  } as unknown as SupervisorStore;
  return createCleanupService({
    config: { worktreeRoot: root } as unknown as SupervisorConfig,
    store,
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe('supervisor worktree cleanup', () => {
  it('accepts a merged task worktree with no local changes and reports its size', async () => {
    const root = temporary('moyu-worktrees');
    const ticketId = 'abcdef1234567890abcdef1234567890';
    const directory = pushedRepository(root, ticketId);
    const inspection = await service(root).inspect('repo-1', ticketId);
    expect(inspection.state).toBe('available');
    expect(inspection.directory).toBe(directory);
    expect(inspection.dirty).toBe(false);
    expect(inspection.unpushed).toBe(false);
    expect(inspection.eligible).toBe(true);
    expect(inspection.sizeBytes).toBeGreaterThan(0);
    expect(inspection.reasons).toEqual(['已合并且无未保存修改']);
  });

  it('skips a worktree with uncommitted or untracked files and keeps it', async () => {
    const root = temporary('moyu-worktrees');
    const ticketId = '1111111111111111';
    const directory = pushedRepository(root, ticketId);
    writeFileSync(join(directory, 'dirty.txt'), 'uncommitted\n');
    const inspect = await service(root).inspect('repo-1', ticketId);
    expect(inspect.dirty).toBe(true);
    expect(inspect.eligible).toBe(false);
    expect(inspect.reasons.join(' ')).toContain('未提交');

    await expect(service(root).remove('repo-1', ticketId)).rejects.toThrow(/未提交/);
    expect(existsSync(directory)).toBe(true);
  });

  it('skips a worktree with an unpushed commit', async () => {
    const root = temporary('moyu-worktrees');
    const ticketId = '2222222222222222';
    const directory = pushedRepository(root, ticketId);
    writeFileSync(join(directory, 'later.txt'), 'local commit\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-q', '-m', 'local only']);
    const inspection = await service(root).inspect('repo-1', ticketId);
    expect(inspection.unpushed).toBe(true);
    expect(inspection.eligible).toBe(false);
    expect(inspection.reasons.join(' ')).toContain('未推送');
  });

  it('removes a clean worktree atomically and is idempotent on a second call', async () => {
    const root = temporary('moyu-worktrees');
    const ticketId = '3333333333333333';
    pushedRepository(root, ticketId);
    const removal = await service(root).remove('repo-1', ticketId);
    expect(removal.state).toBe('removed');
    expect(removal.bytesFreed).toBeGreaterThan(0);
    await expect(service(root).inspect('repo-1', ticketId)).resolves.toMatchObject({
      state: 'cleaned',
    });
    await expect(service(root).remove('repo-1', ticketId)).resolves.toMatchObject({
      state: 'already_cleaned',
    });
  });

  it('refuses a directory whose real path escapes the worktree root', async () => {
    const root = temporary('moyu-worktrees');
    const outside = temporary('moyu-outside');
    const ticketId = '4444444444444444';
    mkdirSync(join(outside, '.git'), { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'do not delete\n');
    mkdirSync(join(root, 'probe1'), { recursive: true });
    symlinkSync(outside, join(root, 'probe1', `task-${ticketId.slice(0, 12)}`));
    const inspection = await service(root).inspect('repo-1', ticketId);
    expect(inspection.state).toBe('unavailable');
    expect(inspection.eligible).toBe(false);
    await expect(service(root).remove('repo-1', ticketId)).rejects.toThrow(/边界/);
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
  });

  it('skips a worktree with a process whose cwd is inside it', async () => {
    const root = temporary('moyu-worktrees');
    const ticketId = '5555555555555555';
    const directory = pushedRepository(root, ticketId);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      cwd: directory,
      stdio: 'ignore',
    });
    children.push(child);
    let inspection = await service(root).inspect('repo-1', ticketId);
    for (let attempt = 0; attempt < 20 && !inspection.occupied; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await service(root).inspect('repo-1', ticketId);
    }
    expect(inspection.occupied).toBe(true);
    expect(inspection.eligible).toBe(false);
    expect(inspection.reasons.join(' ')).toContain('占用');
    await expect(service(root).remove('repo-1', ticketId)).rejects.toThrow(/占用/);
  });

  it('purges only quarantine entries for the requested profile', async () => {
    const root = temporary('moyu-worktrees');
    const trash = join(root, '.cleanup-trash');
    mkdirSync(join(trash, 'probe1-old'), { recursive: true });
    mkdirSync(join(trash, 'other-old'), { recursive: true });
    writeFileSync(join(trash, 'probe1-old', 'x.txt'), 'x');
    writeFileSync(join(trash, 'other-old', 'x.txt'), 'x');
    const result = await service(root).emptyTrash('repo-1');
    expect(result.removed).toBe(1);
    expect(existsSync(join(trash, 'other-old'))).toBe(true);
  });

  it('does not follow symlinks when measuring a directory', () => {
    const root = temporary('moyu-measure');
    const outside = temporary('moyu-measure-outside');
    writeFileSync(join(outside, 'large.bin'), Buffer.alloc(1024));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'a.txt'), 'abc');
    symlinkSync(join(outside, 'large.bin'), join(root, 'link.bin'));
    const size = __test.walkSize(root);
    expect(size.fileCount).toBe(2);
    expect(size.sizeBytes).toBeLessThan(10_000);
  });
});
