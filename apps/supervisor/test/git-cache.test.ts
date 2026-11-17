import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SupervisorConfig } from '../src/config';
import {
  explainGitFailure,
  GIT_CACHE_DIRECTORY,
  parseGitProgress,
  RepositoryGitCache,
} from '../src/git-cache';
import { buildInstancePrepareCommand } from '../src/manager';
import type { InstanceRow, RepositoryRow, SupervisorStore } from '../src/store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, argv: string[]): string =>
  execFileSync('git', argv, { cwd, encoding: 'utf8' }).trim();

/** A local bare repository with one commit; no network or GitHub credentials are used. */
function originRepository(
  root: string,
  name = 'origin',
): { origin: string; work: string; commit: string } {
  const origin = join(root, `${name}.git`);
  const work = join(root, `${name}-seed`);
  git(root, ['init', '--bare', '--initial-branch=main', origin]);
  git(root, ['init', '--initial-branch=main', work]);
  git(work, ['config', 'user.name', 'MoYu Test']);
  git(work, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(work, 'README.md'), 'first\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'first']);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['push', '-q', 'origin', 'main']);
  return { origin, work, commit: git(work, ['rev-parse', 'HEAD']) };
}

function instanceRow(repositoryId: string): InstanceRow {
  return {
    repositoryId,
    fullName: 'acme/widgets',
    defaultBranch: 'main',
    state: 'sleeping',
    desiredState: 'sleeping',
    reasonCode: 'never_started',
    reasonDetail: null,
    waitingFor: null,
    queuePriority: 100,
    wakeRequestedAt: null,
    lastActivityAt: null,
    lastProgressAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    lastHealthAt: null,
    pid: null,
    port: null,
    bridgePort: null,
    profile: 'p1',
    ownership: {},
    attemptCount: 0,
    errorCode: null,
    errorDetail: null,
    memoryCurrentBytes: null,
    memoryPeakBytes: null,
    memoryLimitBytes: null,
    memoryEvents: {},
    resourceState: 'unknown',
    resourceDetail: null,
    resourceCheckedAt: null,
    gitState: 'none',
    gitPhase: null,
    gitProgress: null,
    gitDetail: null,
    gitStartedAt: null,
    gitFinishedAt: null,
    gitAttempts: 0,
    gitHead: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function harness(remote: string, options: { timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'moyu-git-cache-'));
  roots.push(root);
  const worktreeRoot = join(root, 'worktrees');
  mkdirSync(join(worktreeRoot, 'p1'), { recursive: true });
  const repositoryId = '11111111-1111-4111-8111-111111111111';
  const row = instanceRow(repositoryId);
  const repository: RepositoryRow = {
    id: repositoryId,
    ownerId: '22222222-2222-4222-8222-222222222222',
    fullName: 'acme/widgets',
    defaultBranch: 'main',
    bridgeUrl: null,
    bridgeCredentialRef: null,
    checkCommands: null,
    status: 'provisioning',
  };
  const updates: Partial<InstanceRow>[] = [];
  const store = {
    getRepository: async () => ({ ...repository }),
    getInstance: async () => row,
    listInstances: async () => [row],
    updateInstance: async (_id: string, fields: Partial<InstanceRow>) => {
      Object.assign(row, fields);
      updates.push(fields);
    },
  } as unknown as SupervisorStore;
  const config = {
    worktreeRoot,
    repoPrepareTimeoutMs: options.timeoutMs ?? 30_000,
    pinned: new Map(),
    reviewCheckSetpriv: '/usr/bin/setpriv',
  } as unknown as SupervisorConfig;
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const cacheFor = (url: string) =>
    new RepositoryGitCache(config, store, logger as never, {
      remoteUrl: () => url,
      env: { GIT_ALLOW_PROTOCOL: 'file:ext' },
    });
  return {
    root,
    worktreeRoot,
    repositoryId,
    row,
    updates,
    store,
    config,
    logger,
    cacheFor,
    cache: cacheFor(remote),
  };
}

async function waitForRow(
  row: InstanceRow,
  state: InstanceRow['gitState'],
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (row.gitState !== state) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${state}; last=${row.gitState} ${row.gitDetail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('repository Git copy preparation', () => {
  it('clones a bare mirror once and reports the real ready commit', async () => {
    const h = harness('');
    const { origin, commit } = originRepository(h.root);
    const cache = h.cacheFor(origin);
    const started = await cache.begin(h.repositoryId);
    expect(started.gitState).toBe('preparing');
    await waitForRow(h.row, 'ready');
    expect(h.row.gitHead).toBe(commit);
    expect(h.row.gitProgress).toBe(100);
    const directory = join(h.worktreeRoot, 'p1', GIT_CACHE_DIRECTORY);
    expect(git(directory, ['rev-parse', '--is-bare-repository'])).toBe('true');
    expect(git(directory, ['config', '--get', 'remote.origin.url'])).toBe(origin);
    expect(git(directory, ['rev-parse', 'refs/heads/main'])).toBe(commit);
    expect(h.updates.some((update) => update.gitPhase === 'verifying')).toBe(true);
  });

  it('joins an in-flight preparation instead of starting a second clone', async () => {
    const h = harness('');
    const { origin } = originRepository(h.root);
    const cache = h.cacheFor(origin);
    const first = await cache.begin(h.repositoryId);
    const second = await cache.begin(h.repositoryId);
    expect(first.gitState).toBe('preparing');
    expect(second.gitState).toBe('preparing');
    await waitForRow(h.row, 'ready');
    expect(h.row.gitAttempts).toBe(1);
  });

  it('updates a ready copy with new branch commits instead of cloning again', async () => {
    const h = harness('');
    const { origin, commit, work } = originRepository(h.root);
    const cache = h.cacheFor(origin);
    await cache.begin(h.repositoryId);
    await waitForRow(h.row, 'ready');
    expect(h.row.gitHead).toBe(commit);
    writeFileSync(join(work, 'next.txt'), 'next\n');
    git(work, ['add', '.']);
    git(work, ['commit', '-m', 'next']);
    git(work, ['push', '-q', 'origin', 'main']);
    const next = git(work, ['rev-parse', 'HEAD']);
    await cache.begin(h.repositoryId);
    await waitForRow(h.row, 'ready');
    expect(h.row.gitHead).toBe(next);
    expect(h.row.gitAttempts).toBe(2);
    const directory = join(h.worktreeRoot, 'p1', GIT_CACHE_DIRECTORY);
    expect(git(directory, ['rev-parse', 'refs/heads/main'])).toBe(next);
  });

  it('times out a slow preparation, cleans the partial copy and stays retryable', async () => {
    const h = harness('', { timeoutMs: 200 });
    const hang = join(h.root, 'hang-transport');
    writeFileSync(hang, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const cache = h.cacheFor(`ext::${hang}`);
    await cache.begin(h.repositoryId);
    await waitForRow(h.row, 'failed', 10_000);
    expect(h.row.gitDetail).toContain('超时');
    expect(h.row.gitState).toBe('failed');
    const profile = join(h.worktreeRoot, 'p1');
    expect(readdirSync(profile).filter((name) => name.startsWith(GIT_CACHE_DIRECTORY))).toEqual([]);
  });

  it('records a failed preparation without leaving a usable or partial copy', async () => {
    const h = harness(join(tmpdir(), 'moyu-no-such-remote.git'));
    await h.cache.begin(h.repositoryId);
    await waitForRow(h.row, 'failed');
    expect(h.row.gitDetail).toContain('仓库副本准备失败');
    const profile = join(h.worktreeRoot, 'p1');
    expect(readdirSync(profile).filter((name) => name.startsWith(GIT_CACHE_DIRECTORY))).toEqual([]);
  });

  it('retries at repository level after a failure and becomes ready', async () => {
    const h = harness(join(tmpdir(), 'moyu-no-such-remote.git'));
    await h.cache.begin(h.repositoryId);
    await waitForRow(h.row, 'failed');
    const { origin } = originRepository(h.root);
    const retry = h.cacheFor(origin);
    await retry.begin(h.repositoryId);
    await waitForRow(h.row, 'ready');
    expect(h.row.gitAttempts).toBe(2);
    expect(h.row.gitState).toBe('ready');
  });

  it('turns a preparation interrupted by a supervisor restart into a retryable failure', async () => {
    const h = harness('');
    const partial = join(h.worktreeRoot, 'p1', `${GIT_CACHE_DIRECTORY}.partial-1`);
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'half'), 'x');
    h.row.gitState = 'preparing';
    h.row.gitPhase = 'receiving';
    await h.cacheFor('').recover();
    expect(h.row.gitState).toBe('failed');
    expect(h.row.gitDetail).toContain('重启');
    expect(() => statSync(partial)).toThrow();
  });
});

describe('Git progress and failure explanation', () => {
  it('maps Git progress lines to phases and keeps an absent percentage absent', () => {
    const start = { phase: 'connecting' as const, percent: null, detail: null };
    expect(parseGitProgress('Receiving objects:  43% (430/1000), 1.2 MiB', start)).toMatchObject({
      phase: 'receiving',
      percent: 43,
    });
    expect(parseGitProgress('Resolving deltas:  71% (71/100)', start)).toMatchObject({
      phase: 'resolving',
      percent: 71,
    });
    expect(parseGitProgress('Receiving objects: 100% (1000/1000), done.', start)).toMatchObject({
      phase: 'finalizing',
      percent: 100,
    });
    expect(parseGitProgress('remote: Total 1000', start)).toMatchObject({
      phase: 'finalizing',
      percent: null,
    });
  });

  it('explains a timeout, an auth failure and a missing repository in Chinese', () => {
    expect(explainGitFailure({ phase: 'receiving', timedOut: true, stderr: '' })).toContain('超时');
    expect(
      explainGitFailure({
        phase: 'connecting',
        timedOut: false,
        stderr: 'Permission denied (publickey).',
      }),
    ).toContain('SSH 凭据');
    expect(
      explainGitFailure({
        phase: 'connecting',
        timedOut: false,
        stderr: 'Repository not found',
      }),
    ).toContain('仓库地址不存在');
  });
});

describe('the task prepare command built from the repository copy', () => {
  function command(cacheDir: string, remote: string): string {
    return buildInstancePrepareCommand({
      fullName: 'acme/widgets',
      githubAccount: 'Bouyer12',
      githubCommitEmail: '202233540+Bouyer12@users.noreply.github.com',
      cacheDir,
      remoteUrl: remote,
    });
  }

  it('checks out the frozen commit from the copy without contacting the remote', () => {
    const root = mkdtempSync(join(tmpdir(), 'moyu-prepare-command-'));
    roots.push(root);
    const { origin, commit } = originRepository(root);
    const cache = join(root, 'cache.git');
    execFileSync('git', ['clone', '--mirror', origin, cache]);
    const destination = join(root, 'task');
    execFileSync('sh', ['-c', command(cache, origin)], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_SUPERAGENT_DIR: destination,
        DSH_SUPERAGENT_NAME: 'fix-t1',
        DSH_SUPERAGENT_WORKSPACE_BASE_COMMIT: commit,
        DSH_SUPERAGENT_WORKSPACE_BASE_BRANCH: 'main',
        // Any remote access would fail: the proof is that none is needed.
        GIT_SSH_COMMAND: 'false',
      },
    });
    expect(git(destination, ['rev-parse', 'HEAD'])).toBe(commit);
    expect(git(destination, ['config', '--get', 'remote.origin.url'])).toBe(origin);
    expect(git(destination, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('agent/fix-t1');
    expect(git(destination, ['config', '--get', 'user.name'])).toBe('Bouyer12');
    expect(git(destination, ['config', '--get', 'user.email'])).toBe(
      '202233540+Bouyer12@users.noreply.github.com',
    );
    expect(readdirSync(root).some((name) => name.includes('.preparing-'))).toBe(false);
  });

  it('fetches only the missing frozen commit when the copy is older than the branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'moyu-prepare-fetch-'));
    roots.push(root);
    const { origin, commit, work } = originRepository(root);
    const cache = join(root, 'cache.git');
    execFileSync('git', ['clone', '--mirror', origin, cache]);
    writeFileSync(join(work, 'next.txt'), 'next\n');
    git(work, ['add', '.']);
    git(work, ['commit', '-m', 'next']);
    git(work, ['push', '-q', 'origin', 'main']);
    const next = git(work, ['rev-parse', 'HEAD']);
    const destination = join(root, 'task');
    execFileSync('sh', ['-c', command(cache, origin)], {
      cwd: root,
      env: {
        ...process.env,
        DSH_SUPERAGENT_DIR: destination,
        DSH_SUPERAGENT_NAME: 'fix-t2',
        DSH_SUPERAGENT_WORKSPACE_BASE_COMMIT: next,
        DSH_SUPERAGENT_WORKSPACE_BASE_BRANCH: 'main',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'utf8',
    });
    expect(git(destination, ['rev-parse', 'HEAD'])).toBe(next);
    expect(git(destination, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('agent/fix-t2');
    expect(commit).not.toBe(next);
  });

  it('refuses to run when the repository copy is not ready and leaves no task directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'moyu-prepare-missing-'));
    roots.push(root);
    const destination = join(root, 'task');
    const result = spawnSync(
      'sh',
      ['-c', command(join(root, 'missing.git'), 'file:///nonexistent')],
      {
        cwd: root,
        env: {
          ...process.env,
          DSH_SUPERAGENT_DIR: destination,
          DSH_SUPERAGENT_NAME: 'fix-t3',
          DSH_SUPERAGENT_WORKSPACE_BASE_COMMIT: '0'.repeat(40),
          DSH_SUPERAGENT_WORKSPACE_BASE_BRANCH: 'main',
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('Git 副本尚未准备好');
    expect(() => statSync(destination)).toThrow();
    expect(readdirSync(root).some((name) => name.includes('.preparing-'))).toBe(false);
  });
});
