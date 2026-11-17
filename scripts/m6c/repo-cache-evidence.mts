/**
 * M6-C A evidence: prepare a real GitHub repository copy with the supervisor's
 * repository cache, then build a task workspace from it with the generated
 * prepare command while every SSH attempt is forced to fail. The recorded facts
 * are the actual Git heads, origin, branch, timings and sizes.
 *
 *   pnpm exec tsx scripts/m6c/repo-cache-evidence.mts <fullName> <workdir>
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { SupervisorConfig } from '../../apps/supervisor/src/config.ts';
import {
  GIT_CACHE_DIRECTORY,
  RepositoryGitCache,
  githubCloneUrl,
} from '../../apps/supervisor/src/git-cache.ts';
import { buildInstancePrepareCommand } from '../../apps/supervisor/src/manager.ts';
import type { InstanceRow, RepositoryRow, SupervisorStore } from '../../apps/supervisor/src/store.ts';

const fullName = process.argv[2];
const root = process.argv[3];
if (!fullName || !root) throw new Error('usage: repo-cache-evidence.mts <owner/name> <workdir>');
rmSync(root, { recursive: true, force: true });
const worktreeRoot = join(root, 'worktrees');
mkdirSync(join(worktreeRoot, 'm6c-a'), { recursive: true });

const repositoryId = '11111111-1111-4111-8111-111111111111';
const repository: RepositoryRow = {
  id: repositoryId,
  ownerId: '22222222-2222-4222-8222-222222222222',
  fullName,
  defaultBranch: 'main',
  bridgeUrl: null,
  bridgeCredentialRef: null,
  checkCommands: null,
  status: 'provisioning',
};
const row: InstanceRow = {
  repositoryId, fullName, defaultBranch: 'main', state: 'sleeping', desiredState: 'sleeping',
  reasonCode: 'never_started', reasonDetail: null, waitingFor: null, queuePriority: 100,
  wakeRequestedAt: null, lastActivityAt: null, lastProgressAt: null, lastStartedAt: null,
  lastStoppedAt: null, lastHealthAt: null, pid: null, port: null, bridgePort: null,
  profile: 'm6c-a', ownership: {}, attemptCount: 0, errorCode: null, errorDetail: null,
  memoryCurrentBytes: null, memoryPeakBytes: null, memoryLimitBytes: null, memoryEvents: {},
  resourceState: 'unknown', resourceDetail: null, resourceCheckedAt: null, gitState: 'none',
  gitPhase: null, gitProgress: null, gitDetail: null, gitStartedAt: null, gitFinishedAt: null,
  gitAttempts: 0, gitHead: null, createdAt: new Date(), updatedAt: new Date(),
};
const progress: { at: string; state: string; phase: string | null; progress: number | null; detail: string | null }[] = [];
const store = {
  getRepository: async () => repository,
  getInstance: async () => row,
  listInstances: async () => [row],
  updateInstance: async (_id: string, fields: Partial<InstanceRow>) => {
    Object.assign(row, fields);
    if (fields.gitState || fields.gitPhase || fields.gitProgress !== undefined) {
      progress.push({ at: new Date().toISOString(), state: row.gitState, phase: row.gitPhase, progress: row.gitProgress, detail: row.gitDetail });
    }
  },
} as unknown as SupervisorStore;
const config = {
  worktreeRoot,
  repoPrepareTimeoutMs: 900_000,
  pinned: new Map(),
  reviewCheckSetpriv: '/usr/bin/setpriv',
} as unknown as SupervisorConfig;
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const cache = new RepositoryGitCache(config, store, logger as never);

const startedAt = Date.now();
await cache.begin(repositoryId);
const deadline = Date.now() + 900_000;
while (row.gitState === 'preparing') {
  if (Date.now() > deadline) throw new Error('timed out waiting for repository preparation');
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (row.gitState !== 'ready') throw new Error(`preparation failed: ${row.gitDetail}`);
const prepareMs = Date.now() - startedAt;
const cacheDir = join(worktreeRoot, 'm6c-a', GIT_CACHE_DIRECTORY);
const cacheHead = execFileSync('git', ['-C', cacheDir, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
const cacheBytes = execFileSync('sh', ['-c', `du -sb "${cacheDir}" | cut -f1`], { encoding: 'utf8' }).trim();

const directory = join(worktreeRoot, 'm6c-a', 'fix-evidence-task');
const command = buildInstancePrepareCommand({
  fullName,
  githubAccount: 'Bouyer12',
  githubCommitEmail: '202233540+Bouyer12@users.noreply.github.com',
  cacheDir,
});
const taskStarted = Date.now();
const task = spawnSync('sh', ['-c', command], {
  cwd: worktreeRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    DSH_SUPERAGENT_DIR: directory,
    DSH_SUPERAGENT_NAME: 'evidence-task',
    DSH_SUPERAGENT_WORKSPACE_BASE_COMMIT: cacheHead,
    DSH_SUPERAGENT_WORKSPACE_BASE_BRANCH: 'main',
    // Any remote access would fail; the first task must not need it.
    GIT_SSH_COMMAND: 'false',
    GIT_TERMINAL_PROMPT: '0',
  },
});
const taskMs = Date.now() - taskStarted;
if (task.status !== 0) throw new Error(`task prepare failed (${task.status}): ${task.stderr}`);

const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const origin = execFileSync('git', ['-C', directory, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const author = execFileSync('git', ['-C', directory, 'config', '--get', 'user.name'], { encoding: 'utf8' }).trim();
const email = execFileSync('git', ['-C', directory, 'config', '--get', 'user.email'], { encoding: 'utf8' }).trim();
const status = execFileSync('git', ['-C', directory, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
const commitSubject = execFileSync('git', ['-C', directory, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
const leftovers = readdirSync(join(worktreeRoot, 'm6c-a')).filter((name) => name.includes('.preparing-'));

console.log(JSON.stringify({
  fullName,
  remote: githubCloneUrl(fullName),
  prepareCommandExit: 0,
  preparation: {
    state: row.gitState,
    phase: row.gitPhase,
    attempts: row.gitAttempts,
    durationMs: prepareMs,
    cacheHead,
    cacheBytes: Number(cacheBytes),
    progress,
  },
  firstTask: {
    command,
    exitCode: task.status,
    durationMs: taskMs,
    head,
    branch,
    origin,
    author,
    email,
    clean: status === '',
    commitSubject,
    remoteAccessDisabled: true,
    leftovers,
    taskBytes: Number(execFileSync('sh', ['-c', `du -sb "${directory}" | cut -f1`], { encoding: 'utf8' }).trim()),
  },
}, null, 2));
