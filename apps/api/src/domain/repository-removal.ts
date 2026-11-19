import { and, eq, inArray, isNull } from 'drizzle-orm';

import { REPOSITORY_HISTORY_RETENTION_DAYS, type RepositoryDeletion } from '@moyu/contracts';
import {
  repositories,
  repositoryInstances,
  runtimeLeases,
  taskLinks,
  type Database,
  type Repository,
} from '@moyu/db';

import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';
import { createSupervisorClient } from '../runtime/supervisor';

/** Execution states that must finish before the repository can be removed. */
const ACTIVE_TASK_STATES = [
  'pending_admission',
  'queued',
  'discussing',
  'running',
  'waiting_input',
  'awaiting_review',
  'stopping',
] as const;

const HISTORY_RETENTION_MS = REPOSITORY_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function deletionFor(repository: Repository): RepositoryDeletion {
  const removedAt = repository.removedAt;
  const historyExpiresAt = removedAt ? new Date(removedAt.getTime() + HISTORY_RETENTION_MS) : null;
  return {
    state:
      repository.deletionState === 'deleting' ||
      repository.deletionState === 'failed' ||
      repository.deletionState === 'removed'
        ? repository.deletionState
        : 'none',
    detail: repository.deletionDetail,
    attempts: repository.deletionAttempts,
    startedAt: repository.deletionStartedAt?.toISOString() ?? null,
    finishedAt: repository.deletionFinishedAt?.toISOString() ?? null,
    removedAt: removedAt?.toISOString() ?? null,
    historyExpiresAt: historyExpiresAt?.toISOString() ?? null,
  };
}

function safeDetail(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/token[=:]\s*\S+/gi, 'token=[redacted]')
    .slice(0, 500);
}

/**
 * Explains why removal cannot start yet. Capacity and memory are not reasons:
 * the supervisor stops the instance before deleting its local resources.
 */
export async function repositoryRemovalBlocker(
  database: Database,
  repository: Repository,
): Promise<string | null> {
  const [instance] = await database
    .select()
    .from(repositoryInstances)
    .where(eq(repositoryInstances.repositoryId, repository.id))
    .limit(1);
  if (instance?.gitState === 'preparing') {
    return '仓库副本正在准备；完成后才能移除。请稍后重试。';
  }

  const tasks = await database
    .select({ id: taskLinks.id })
    .from(taskLinks)
    .where(
      and(
        eq(taskLinks.repositoryId, repository.id),
        inArray(taskLinks.state, [...ACTIVE_TASK_STATES]),
      ),
    )
    .limit(1);
  if (tasks.length > 0) {
    return '仍有进行中或排队中的任务；请等待它们结束或先停止，再移除仓库。';
  }

  const [lease] = await database
    .select({ id: runtimeLeases.id })
    .from(runtimeLeases)
    .where(
      and(
        eq(runtimeLeases.repositoryId, repository.id),
        eq(runtimeLeases.state, 'active'),
        isNull(runtimeLeases.releasedAt),
      ),
    )
    .limit(1);
  if (lease) {
    return '仍有执行租约占用这个仓库；请等待任务结束并释放租约后再移除。';
  }
  return null;
}

/** Marks a deletion interrupted by a service restart as retryable. */
export async function recoverInterruptedDeletions(database: Database): Promise<number> {
  const rows = await database
    .update(repositories)
    .set({
      deletionState: 'failed',
      deletionDetail: '服务重启中断了移除；本地资源可能已部分清理，请重试。',
      deletionFinishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(repositories.deletionState, 'deleting'))
    .returning({ id: repositories.id });
  return rows.length;
}

export interface RepositoryRemovalResult {
  repository: Repository;
  alreadyRemoved: boolean;
}

/**
 * Runs the owner-requested removal. Local resources belong to the host
 * supervisor; the API only owns the durable deletion state and validates that
 * no task still uses the repository. The GitHub remote is never touched.
 */
export async function removeRepository(
  database: Database,
  config: ApiConfig,
  repository: Repository,
  options: { log?: { warn: (fields: Record<string, unknown>, message: string) => void } } = {},
): Promise<RepositoryRemovalResult> {
  if (repository.deletionState === 'removed') {
    return { repository, alreadyRemoved: true };
  }
  const blocker = await repositoryRemovalBlocker(database, repository);
  if (blocker) throw ApiProblem.conflict(blocker);

  const [deleting] = await database
    .update(repositories)
    .set({
      deletionState: 'deleting',
      deletionDetail: null,
      deletionAttempts: repository.deletionAttempts + 1,
      deletionStartedAt: new Date(),
      deletionFinishedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, repository.id))
    .returning();
  const current = deleting ?? repository;

  const supervisor = createSupervisorClient(config);
  if (!supervisor) {
    // Without a supervisor there is no managed local instance to stop. A row
    // with an instance profile still owns local resources, so refuse instead of
    // claiming a cleanup that did not happen.
    const [instance] = await database
      .select({ profile: repositoryInstances.profile })
      .from(repositoryInstances)
      .where(eq(repositoryInstances.repositoryId, repository.id))
      .limit(1);
    if (instance?.profile) {
      const detail = '主机 supervisor 未配置，无法清理这个仓库的本地实例与副本。';
      await markFailed(database, repository.id, detail);
      throw ApiProblem.unavailable(detail);
    }
  } else {
    try {
      await supervisor.remove(repository.id);
    } catch (error) {
      const detail = safeDetail(error instanceof Error ? error.message : String(error));
      await markFailed(database, repository.id, detail);
      options.log?.warn(
        { event: 'repository.removal_failed', repositoryId: repository.id, error: detail },
        'repository removal failed; local resources stay retryable',
      );
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 409) {
        throw ApiProblem.conflict(detail);
      }
      throw ApiProblem.unavailable(`仓库移除失败：${detail}。修好原因后可重试。`);
    }
  }

  const [removed] = await database
    .update(repositories)
    .set({
      deletionState: 'removed',
      deletionDetail: null,
      deletionFinishedAt: new Date(),
      removedAt: new Date(),
      status: 'sleeping',
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, repository.id))
    .returning();
  return { repository: removed ?? current, alreadyRemoved: false };
}

async function markFailed(database: Database, repositoryId: string, detail: string): Promise<void> {
  await database
    .update(repositories)
    .set({
      deletionState: 'failed',
      deletionDetail: detail,
      deletionFinishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(repositories.id, repositoryId));
}
