import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectChanges, locateTicketWorktree, runChecks, type ReviewService } from '../src/review';
import { createReviewService } from '../src/review';

const directories: string[] = [];

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  directories.push(directory);
  return directory;
}

function git(directory: string, args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

/** A real git repository with one commit, a staged-free working tree. */
function repository(): string {
  const directory = temporary('moyu-review');
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.email', 'review@example.invalid']);
  git(directory, ['config', 'user.name', 'Review Test']);
  writeFileSync(join(directory, 'keep.txt'), 'one\ntwo\n');
  writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\n');
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'nested', 'old.txt'), 'old\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-q', '-m', 'initial commit']);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe('supervisor review worktree resolution', () => {
  it('finds the single directory whose name ends with the ticket id prefix', () => {
    const root = temporary('moyu-worktrees');
    const profile = 'probe1';
    const ticketId = 'abcdef1234567890abcdef1234567890';
    const ticketDirectory = join(root, profile, `mp-fix-${ticketId.slice(0, 12)}`);
    mkdirSync(join(ticketDirectory, '.git'), { recursive: true });

    const found = locateTicketWorktree({ worktreeRoot: root, profile, ticketId });
    expect(found.state).toBe('available');
    expect(found.directory).toBe(ticketDirectory);

    const other = locateTicketWorktree({
      worktreeRoot: root,
      profile,
      ticketId: 'ffffffffffffffff',
    });
    expect(other.state).toBe('cleaned');
    expect(other.directory).toBeNull();
    expect(other.reason).toContain('已不存在');
  });

  it('reports a missing instance profile as unavailable, never as an empty diff', () => {
    const root = temporary('moyu-worktrees');
    const result = locateTicketWorktree({ worktreeRoot: root, profile: null, ticketId: 'abc' });
    expect(result.state).toBe('unavailable');
    expect(result.reason).toContain('实例');
  });

  it('refuses to guess when two directories match the same ticket id', () => {
    const root = temporary('moyu-worktrees');
    const profile = 'probe1';
    const ticketId = '0123456789abcdef';
    for (const name of [`one-${ticketId.slice(0, 12)}`, `two-${ticketId.slice(0, 12)}`]) {
      mkdirSync(join(root, profile, name, '.git'), { recursive: true });
    }
    const result = locateTicketWorktree({ worktreeRoot: root, profile, ticketId });
    expect(result.state).toBe('unavailable');
    expect(result.directory).toBeNull();
  });
});

describe('supervisor worktree diff', () => {
  it('reads a real git diff, including untracked, modified, deleted and renamed files', async () => {
    const directory = repository();
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(directory, 'keep.txt'), 'one\n');
    writeFileSync(join(directory, 'added.txt'), 'brand new\n');
    writeFileSync(join(directory, 'untracked.txt'), 'not staged yet\n');
    rmSync(join(directory, 'nested', 'old.txt'));
    writeFileSync(join(directory, 'nested', 'new.txt'), 'old\n');
    git(directory, ['add', 'nested/old.txt', 'nested/new.txt']);

    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });
    expect(changes.state).toBe('available');
    expect(changes.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(changes.commitSubject).toBe('initial commit');

    const byPath = new Map(changes.files.map((file) => [file.path, file]));
    expect(byPath.get('changed.txt')?.status).toBe('modified');
    expect(byPath.get('changed.txt')?.additions).toBe(1);
    expect(byPath.get('keep.txt')?.deletions).toBe(1);
    expect(byPath.get('untracked.txt')?.status).toBe('untracked');
    expect(byPath.get('untracked.txt')?.patch).toContain('+not staged yet');
    // numstat has no entry for an untracked file; the panel still reports the
    // real added line count taken from the patch.
    expect(byPath.get('untracked.txt')?.additions).toBe(1);

    // The panel content is exactly what git prints for the same file.
    const raw = git(directory, ['diff', 'HEAD', '--', 'changed.txt']);
    expect(byPath.get('changed.txt')?.patch).toBe(raw);
    expect(raw).toContain('+gamma');
  });

  it('reports no files for a clean worktree instead of inventing changes', async () => {
    const directory = repository();
    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });
    expect(changes.state).toBe('available');
    expect(changes.files).toEqual([]);
    expect(changes.additions).toBe(0);
    expect(changes.deletions).toBe(0);
  });

  it('marks a non-repository directory as unavailable with the git error', async () => {
    const directory = temporary('moyu-not-a-repo');
    const changes = await collectChanges({ directory, maxBytes: 4096, maxFiles: 10 });
    expect(changes.state).toBe('unavailable');
    expect(changes.reason).toContain('HEAD');
  });
});

/**
 * The task worktree is untrusted input. Its `.git` config and `.gitattributes`
 * belong to the task's own repository, so neither may be able to run a program
 * inside the supervisor, which holds the platform's instance state.
 */
describe('supervisor diff helper isolation', () => {
  /** An executable that records every run by appending to `sentinel`. */
  function helper(scratch: string, name: string, sentinel: string): string {
    const path = join(scratch, name);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf 'ran' >> '${sentinel}'\ncat "$2" 2>/dev/null || true\nexit 0\n`,
      { mode: 0o755 },
    );
    return path;
  }

  it('never runs an external diff command named by the task repository attributes', async () => {
    const directory = repository();
    const scratch = temporary('moyu-diff-helper');
    const sentinel = join(scratch, 'helper-ran');
    const command = helper(scratch, 'attribute-diff.sh', sentinel);
    writeFileSync(join(directory, '.gitattributes'), 'changed.txt diff=m6a-helper\n');
    git(directory, ['config', 'diff.m6a-helper.command', command]);
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');

    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });

    expect(existsSync(sentinel)).toBe(false);
    const changed = changes.files.find((file) => file.path === 'changed.txt');
    expect(changed?.status).toBe('modified');
    expect(changed?.patch).toContain('+gamma');
  });

  it('never runs a textconv command named by the task repository attributes', async () => {
    const directory = repository();
    const scratch = temporary('moyu-diff-helper');
    const sentinel = join(scratch, 'helper-ran');
    const command = helper(scratch, 'textconv.sh', sentinel);
    writeFileSync(join(directory, '.gitattributes'), 'changed.txt diff=m6a-helper\n');
    git(directory, ['config', 'diff.m6a-helper.textconv', command]);
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');

    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });

    expect(existsSync(sentinel)).toBe(false);
    expect(changes.files.find((file) => file.path === 'changed.txt')?.patch).toContain('+gamma');
  });

  it('ignores diff helpers inherited through the supervisor environment', async () => {
    const directory = repository();
    const scratch = temporary('moyu-diff-helper');
    const sentinel = join(scratch, 'helper-ran');
    const command = helper(scratch, 'inherited-diff.sh', sentinel);
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');

    const saved = {
      GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GIT_EXTERNAL_DIFF = command;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'diff.external';
    process.env.GIT_CONFIG_VALUE_0 = command;
    try {
      const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });
      expect(existsSync(sentinel)).toBe(false);
      expect(changes.files.find((file) => file.path === 'changed.txt')?.patch).toContain('+gamma');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('never runs a repository-configured fsmonitor program while reading status', async () => {
    const directory = repository();
    const scratch = temporary('moyu-diff-helper');
    const sentinel = join(scratch, 'helper-ran');
    const command = helper(scratch, 'fsmonitor.sh', sentinel);
    git(directory, ['config', 'core.fsmonitor', command]);
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');

    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });

    expect(existsSync(sentinel)).toBe(false);
    expect(changes.files.find((file) => file.path === 'changed.txt')?.status).toBe('modified');
  });
});

describe('supervisor check runs', () => {
  it('keeps the real exit code, timestamps and output tail of each command', async () => {
    const directory = repository();
    const runs = await runChecks({
      directory,
      commands: [
        'node -e "console.log(\'first\'); process.exit(0)"',
        'node -e "console.error(\'broken type\'); process.exit(2)"',
      ],
      timeoutMs: 30_000,
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ exitCode: 0, passed: true, summary: '通过' });
    expect(runs[0]?.output).toContain('first');
    expect(runs[1]).toMatchObject({ exitCode: 2, passed: false });
    expect(runs[1]?.output).toContain('broken type');
    expect(Date.parse(runs[1]!.finishedAt)).toBeGreaterThanOrEqual(Date.parse(runs[1]!.startedAt));
  });

  it('terminates a hung command and records the timeout', async () => {
    const directory = repository();
    const runs = await runChecks({
      directory,
      commands: ['sleep 5'],
      timeoutMs: 300,
    });
    expect(runs[0]?.timedOut).toBe(true);
    expect(runs[0]?.passed).toBe(false);
    expect(runs[0]?.summary).toContain('超时');
  });
});

describe('review service', () => {
  it('returns a cleaned state when the ticket worktree is gone', async () => {
    const root = temporary('moyu-worktrees');
    const config = {
      worktreeRoot: root,
      reviewDiffMaxBytes: 4096,
      reviewMaxFiles: 10,
      reviewCheckCommands: ['true'],
      reviewCheckTimeoutMs: 5_000,
    };
    const service: ReviewService = createReviewService({
      config: config as never,
      store: { getInstance: async () => ({ profile: 'probe1' }) } as never,
      logger: { info: () => undefined },
    });
    const changes = await service.changes('repository', 'deadbeefdeadbeef');
    expect(changes.state).toBe('cleaned');
    expect(changes.files).toEqual([]);
    await expect(service.checks('repository', 'deadbeefdeadbeef')).rejects.toThrow();
  });
});
