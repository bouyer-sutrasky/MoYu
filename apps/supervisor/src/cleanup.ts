import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type { SupervisorConfig } from './config';
import type { SupervisorStore } from './store';
import { git, gitEnvironment, isStrictlyInside, locateTicketWorktree, runCommand } from './review';

/**
 * Host-side worktree cleanup.
 *
 * The platform can only name a repository id and a runtime ticket id. This
 * module resolves the directory from the supervisor's own WORKTREE_ROOT and
 * instance profile, proves the real path stays under that root, and refuses a
 * directory with any work still in it. Deletion is two-phase: the directory is
 * renamed into a quarantine area under the same root (an atomic namespace move),
 * then removed. A failed removal therefore leaves a quarantined tree, never a
 * half-deleted worktree at the original path.
 */

export interface CleanupInspection {
  ticketId: string;
  state: 'available' | 'cleaned' | 'unavailable';
  reason: string | null;
  directory: string | null;
  profile: string | null;
  branch: string | null;
  commit: string | null;
  upstream: string | null;
  ahead: number | null;
  dirty: boolean;
  dirtyEntries: number;
  unpushed: boolean;
  unpushedCommits: number | null;
  occupied: boolean;
  occupiedBy: Array<{ pid: number; command: string }>;
  locked: boolean;
  sizeBytes: number | null;
  fileCount: number;
  modifiedAt: string | null;
  eligible: boolean;
  reasons: string[];
}

export interface CleanupRemoval {
  state: 'removed' | 'already_cleaned' | 'quarantined';
  directory: string | null;
  trashPath: string | null;
  bytesFreed: number;
  reason: string;
  /** True when a linked worktree's administrative record was pruned from the source repository. */
  pruned: boolean;
  pruneError: string | null;
}

export interface TrashEmptyResult {
  removed: number;
  bytesFreed: number;
  failures: Array<{ path: string; error: string }>;
}

const MAX_WALK_ENTRIES = 200_000;
const MAX_WALK_DEPTH = 64;

function iso(value: Date): string {
  return value.toISOString();
}

/** True when a process can still be working inside this directory. */
function processesInside(directory: string): Array<{ pid: number; command: string }> {
  const found: Array<{ pid: number; command: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cwd: string;
    try {
      cwd = realpathSync(`/proc/${entry}/cwd`);
    } catch {
      continue;
    }
    if (cwd !== directory && !isStrictlyInside(directory, cwd)) continue;
    let command = '';
    try {
      command = readlinkSync(`/proc/${entry}/exe`);
    } catch {
      command = 'unknown';
    }
    found.push({ pid: Number(entry), command: command.split(sep).pop() ?? 'unknown' });
    if (found.length >= 20) break;
  }
  return found;
}

function walkSize(directory: string): {
  sizeBytes: number;
  fileCount: number;
  modifiedAt: string | null;
} {
  let sizeBytes = 0;
  let fileCount = 0;
  let newest = 0;
  let visited = 0;
  const stack: Array<{ path: string; depth: number }> = [{ path: directory, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_WALK_DEPTH) continue;
    let entries: string[];
    try {
      entries = readdirSync(current.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current.path, entry);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) {
        return { sizeBytes, fileCount, modifiedAt: newest ? iso(new Date(newest)) : null };
      }
      newest = Math.max(newest, stat.mtimeMs);
      if (stat.isSymbolicLink()) {
        // Count the link itself, never follow it outside the worktree.
        sizeBytes += stat.size;
        fileCount += 1;
      } else if (stat.isDirectory()) {
        stack.push({ path, depth: current.depth + 1 });
      } else if (stat.isFile()) {
        sizeBytes += stat.size;
        fileCount += 1;
      }
    }
  }
  return { sizeBytes, fileCount, modifiedAt: newest ? iso(new Date(newest)) : null };
}

async function gitDirectory(directory: string): Promise<string | null> {
  const result = await git(directory, ['rev-parse', '--git-dir']);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  if (!value) return null;
  return isAbsolute(value) ? value : join(directory, value);
}

export interface CleanupService {
  inspect(repositoryId: string, ticketId: string): Promise<CleanupInspection>;
  remove(repositoryId: string, ticketId: string): Promise<CleanupRemoval>;
  emptyTrash(repositoryId: string): Promise<TrashEmptyResult>;
}

export function createCleanupService(input: {
  config: SupervisorConfig;
  store: SupervisorStore;
  /** Test seam: a failing tree removal must leave a quarantine, never a half-deleted worktree. */
  removeTree?: (path: string) => void;
}): CleanupService {
  const { config, store } = input;
  const removeTree =
    input.removeTree ??
    ((path: string) => {
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
    });

  const profileFor = async (repositoryId: string): Promise<string | null> => {
    const instance = await store.getInstance(repositoryId);
    return instance?.profile ?? null;
  };

  const inspect = async (repositoryId: string, ticketId: string): Promise<CleanupInspection> => {
    const profile = await profileFor(repositoryId);
    const worktree = locateTicketWorktree({
      worktreeRoot: config.worktreeRoot,
      profile,
      ticketId,
    });
    const base: CleanupInspection = {
      ticketId,
      state: worktree.state,
      reason: worktree.reason,
      directory: worktree.directory,
      profile: worktree.profile,
      branch: null,
      commit: null,
      upstream: null,
      ahead: null,
      dirty: false,
      dirtyEntries: 0,
      unpushed: false,
      unpushedCommits: null,
      occupied: false,
      occupiedBy: [],
      locked: false,
      sizeBytes: null,
      fileCount: 0,
      modifiedAt: null,
      eligible: false,
      reasons: [],
    };
    if (worktree.state !== 'available' || !worktree.directory) {
      return { ...base, reasons: [worktree.reason ?? '执行目录不可用'] };
    }

    const directory = worktree.directory;
    const reasons: string[] = [];

    // The resolved ticket directory must itself be the git top level. A nested
    // or linked checkout would mean the ticket suffix and the real repository
    // disagree, and deleting it could take unrelated files with it.
    const topLevel = await git(directory, ['rev-parse', '--show-toplevel']);
    let resolvedTop: string | null = null;
    try {
      resolvedTop = topLevel.code === 0 ? realpathSync(topLevel.stdout.trim()) : null;
    } catch {
      resolvedTop = null;
    }
    if (!resolvedTop || resolvedTop !== directory) {
      return {
        ...base,
        state: 'unavailable',
        reasons: ['执行目录不是其 git 顶层，拒绝清理'],
      };
    }

    const [branch, head, status] = await Promise.all([
      git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(directory, ['rev-parse', 'HEAD']),
      git(directory, ['status', '--porcelain=v1', '-z']),
    ]);
    base.branch = branch.code === 0 ? branch.stdout.trim() : null;
    base.commit = head.code === 0 ? head.stdout.trim() : null;

    if (status.code !== 0) {
      return {
        ...base,
        state: 'unavailable',
        reasons: [`无法读取 git status：${status.stderr.trim()}`],
      };
    }
    const statusEntries = status.stdout
      .split('\0')
      .filter((entry) => entry.trim().length > 0).length;
    base.dirty = statusEntries > 0;
    base.dirtyEntries = statusEntries;

    const upstreamResult = await git(directory, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ]);
    const upstream =
      upstreamResult.code === 0 && upstreamResult.stdout.trim()
        ? upstreamResult.stdout.trim()
        : null;
    base.upstream = upstream;
    if (upstream) {
      const ahead = await git(directory, ['rev-list', '--count', `${upstream}..HEAD`]);
      if (ahead.code === 0) {
        const count = Number(ahead.stdout.trim());
        base.ahead = Number.isFinite(count) ? count : null;
        if (base.ahead !== null && base.ahead > 0) {
          base.unpushed = true;
          base.unpushedCommits = base.ahead;
        }
      } else {
        // An upstream that cannot be counted means pushed state is unknown.
        base.unpushed = true;
      }
    } else {
      // No configured upstream: prove HEAD is contained in a remote ref instead
      // of assuming a local-only branch is safe to remove.
      const remoteContains = await git(directory, ['branch', '-r', '--contains', 'HEAD']);
      const contained = remoteContains.code === 0 && remoteContains.stdout.trim().length > 0;
      base.upstream = null;
      if (!contained) {
        base.unpushed = true;
      }
    }

    const gitDir = await gitDirectory(directory);
    if (gitDir) {
      try {
        base.locked = existsSync(join(realpathSync(gitDir), 'index.lock'));
      } catch {
        base.locked = false;
      }
    }

    const occupiedBy = processesInside(directory);
    base.occupied = occupiedBy.length > 0;
    base.occupiedBy = occupiedBy;

    const size = walkSize(directory);
    base.sizeBytes = size.sizeBytes;
    base.fileCount = size.fileCount;
    base.modifiedAt = size.modifiedAt;

    if (base.dirty) {
      reasons.push(`有未提交或未跟踪改动（${base.dirtyEntries} 项）`);
    }
    if (base.unpushed) {
      reasons.push(
        base.unpushedCommits !== null
          ? `有未推送提交（${base.unpushedCommits} 个）`
          : '无法证明提交已推送',
      );
    }
    if (base.occupied) {
      reasons.push(`被进程占用（PID ${base.occupiedBy.map((entry) => entry.pid).join(', ')}）`);
    }
    if (base.locked) {
      reasons.push('git index.lock 存在，可能仍在执行操作');
    }
    if (reasons.length > 0) {
      return { ...base, eligible: false, reasons };
    }
    return {
      ...base,
      eligible: true,
      reasons: ['已合并且无未保存修改'],
    };
  };

  /**
   * Removes one inspected ticket directory. Every call re-inspects: a preview
   * is a proposal, not a permission to skip the current safety checks.
   */
  const remove = async (repositoryId: string, ticketId: string): Promise<CleanupRemoval> => {
    const inspection = await inspect(repositoryId, ticketId);
    if (inspection.state === 'cleaned') {
      return {
        state: 'already_cleaned',
        directory: null,
        trashPath: null,
        bytesFreed: 0,
        reason: inspection.reason ?? '执行目录已经不存在',
        pruned: false,
        pruneError: null,
      };
    }
    if (inspection.state !== 'available' || !inspection.directory) {
      throw Object.assign(new Error(inspection.reason ?? '执行目录不可用'), { statusCode: 409 });
    }
    if (!inspection.eligible) {
      throw Object.assign(new Error(inspection.reasons.join('；')), { statusCode: 409 });
    }

    const directory = inspection.directory;

    // A linked worktree leaves an administrative record in the source
    // repository's .git/worktrees even after its directory is gone. Capture the
    // common git dir now; after the atomic rename, `git worktree prune` removes
    // the stale record. A plain clone has no such record, so it is skipped.
    let linkedCommonGitDir: string | null = null;
    {
      const gitDir = await git(directory, ['rev-parse', '--absolute-git-dir']);
      const commonDir = await git(directory, ['rev-parse', '--git-common-dir']);
      if (gitDir.code === 0 && commonDir.code === 0) {
        try {
          const resolvedGitDir = realpathSync(gitDir.stdout.trim());
          const resolvedCommon = realpathSync(resolve(directory, commonDir.stdout.trim()));
          if (resolvedGitDir !== resolvedCommon) {
            linkedCommonGitDir = resolvedCommon;
          }
        } catch {
          linkedCommonGitDir = null;
        }
      }
    }

    const root = realpathSync(config.worktreeRoot);
    const trashRoot = join(root, '.cleanup-trash');
    mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const resolvedTrash = realpathSync(trashRoot);
    if (!isStrictlyInside(root, resolvedTrash)) {
      throw Object.assign(new Error('清理隔离区解析后超出工作区边界，拒绝删除'), {
        statusCode: 409,
      });
    }

    const trashPath = join(
      resolvedTrash,
      `${inspection.profile ?? 'profile'}-${ticketId.slice(0, 12)}-${randomUUID()}`,
    );
    if (!isStrictlyInside(root, directory) || !isStrictlyInside(resolvedTrash, trashPath)) {
      throw Object.assign(new Error('目标路径解析后超出工作区边界，拒绝删除'), {
        statusCode: 409,
      });
    }

    // Atomic namespace move first: after this returns the task worktree path is
    // gone in one step, so an interrupted removal cannot leave half a checkout
    // at the original location.
    try {
      renameSync(directory, trashPath);
    } catch (error) {
      throw Object.assign(
        new Error(
          `无法移动执行目录到清理隔离区：${error instanceof Error ? error.message : String(error)}`,
        ),
        { statusCode: 409 },
      );
    }

    // The worktree path is gone after the rename, so prune can drop its
    // administrative record now, even if the recursive removal still fails.
    let pruned = false;
    let pruneError: string | null = null;
    if (linkedCommonGitDir) {
      const result = await runCommand(
        ['git', '--git-dir', linkedCommonGitDir, 'worktree', 'prune'],
        {
          cwd: dirname(linkedCommonGitDir),
          timeoutMs: 20_000,
          env: gitEnvironment(),
        },
      );
      if (result.code === 0) {
        pruned = true;
      } else {
        pruneError = (result.stderr || 'git worktree prune failed').trim().slice(0, 500);
      }
    }

    const size = inspection.sizeBytes ?? 0;
    try {
      removeTree(trashPath);
    } catch (error) {
      return {
        state: 'quarantined',
        directory,
        trashPath,
        bytesFreed: 0,
        reason: `目录已移出工作区但删除失败：${error instanceof Error ? error.message : String(error)}`,
        pruned,
        pruneError,
      };
    }
    return {
      state: 'removed',
      directory,
      trashPath: null,
      bytesFreed: size,
      reason: '已删除',
      pruned,
      pruneError,
    };
  };

  /**
   * Purges quarantined trees for one profile. It runs on every execution so a
   * previous failed removal is retried instead of accumulating forever.
   */
  const emptyTrash = async (repositoryId: string): Promise<TrashEmptyResult> => {
    const profile = await profileFor(repositoryId);
    if (!profile) {
      return { removed: 0, bytesFreed: 0, failures: [] };
    }
    const root = realpathSync(config.worktreeRoot);
    const trashRoot = join(root, '.cleanup-trash');
    if (!existsSync(trashRoot)) {
      return { removed: 0, bytesFreed: 0, failures: [] };
    }
    const resolvedTrash = realpathSync(trashRoot);
    if (!isStrictlyInside(root, resolvedTrash)) {
      return {
        removed: 0,
        bytesFreed: 0,
        failures: [{ path: trashRoot, error: '清理隔离区超出工作区边界，拒绝清理' }],
      };
    }
    let removed = 0;
    let bytesFreed = 0;
    const failures: Array<{ path: string; error: string }> = [];
    for (const entry of readdirSync(resolvedTrash)) {
      if (!entry.startsWith(`${profile}-`)) continue;
      const path = join(resolvedTrash, entry);
      let resolved: string;
      try {
        resolved = realpathSync(path);
      } catch {
        continue;
      }
      if (!isStrictlyInside(resolvedTrash, resolved)) {
        failures.push({ path, error: '隔离目录解析后超出边界，拒绝清理' });
        continue;
      }
      let size = 0;
      try {
        size = walkSize(resolved).sizeBytes;
      } catch {
        size = 0;
      }
      try {
        removeTree(resolved);
        removed += 1;
        bytesFreed += size;
      } catch (error) {
        failures.push({
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { removed, bytesFreed, failures };
  };

  return { inspect, remove, emptyTrash };
}

/** Exported for unit tests: the size walker does not follow symlinks. */
export const __test = { walkSize, processesInside };
