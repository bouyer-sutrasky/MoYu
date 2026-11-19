import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull, lte } from 'drizzle-orm';

import { REPOSITORY_HISTORY_RETENTION_DAYS, type RepositoryDeletion } from '@moyu/contracts';
import {
  conversations,
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

/** Task states that still own the repository or its worktree. */
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

type QueryExecutor = Pick<Database, 'select'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

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
  database: QueryExecutor,
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
    return '仍有进行中、排队中或等待人工处理的任务；请先结束它们，再移除仓库。';
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

/**
 * Takes the repository row lock for task admission. A removal claim holds the
 * same lock while it checks the task table and writes `deleting`, so a task can
 * never be inserted against a repository that has just started removal.
 */
export async function lockRepositoryForAdmission(
  transaction: Transaction,
  repositoryId: string,
): Promise<void> {
  const [repository] = await transaction
    .select({ deletionState: repositories.deletionState })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .for('update');
  if (!repository) throw ApiProblem.notFound('Repository not found');
  if (repository.deletionState !== 'none') {
    throw ApiProblem.conflict(
      repository.deletionState === 'deleting'
        ? '该仓库正在从 MoYu 移除；完成前不能开始新任务或执行。'
        : '该仓库上次移除失败；请先重试移除或等待处理。',
    );
  }
}

export type RemovalOutcome = 'removed' | 'failed' | 'in-progress' | 'already-removed';

export interface RepositoryRemovalResult {
  repository: Repository;
  outcome: RemovalOutcome;
}

type Claim =
  | { kind: 'missing' }
  | { kind: 'removed'; repository: Repository }
  | { kind: 'in-progress'; repository: Repository }
  | { kind: 'claimed'; repository: Repository; operationId: string };

/** Atomically checks blockers, claims the removal and records its operation id. */
async function claimRemoval(
  database: Database,
  repositoryId: string,
  ownerId: string,
): Promise<Claim> {
  return database.transaction(async (transaction) => {
    const [repository] = await transaction
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .for('update');
    if (!repository || repository.ownerId !== ownerId) return { kind: 'missing' };
    if (repository.deletionState === 'removed') {
      return { kind: 'removed', repository };
    }
    if (repository.deletionState === 'deleting') {
      return { kind: 'in-progress', repository };
    }
    const blocker = await repositoryRemovalBlocker(transaction, repository);
    if (blocker) throw ApiProblem.conflict(blocker);
    const operationId = randomUUID();
    const [claimed] = await transaction
      .update(repositories)
      .set({
        deletionState: 'deleting',
        deletionOperationId: operationId,
        deletionDetail: null,
        deletionAttempts: repository.deletionAttempts + 1,
        deletionStartedAt: new Date(),
        deletionFinishedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repositoryId))
      .returning();
    if (!claimed) throw new Error('repository removal claim returned no row');
    return { kind: 'claimed', repository: claimed, operationId };
  });
}

/** Only the current operation may finish; a late result updates nothing. */
export async function finalizeRemoval(
  database: Database,
  repositoryId: string,
  operationId: string,
  outcome: { ok: true } | { ok: false; detail: string },
): Promise<Repository | null> {
  const [updated] = await database
    .update(repositories)
    .set(
      outcome.ok
        ? {
            deletionState: 'removed',
            deletionOperationId: null,
            deletionDetail: null,
            deletionFinishedAt: new Date(),
            removedAt: new Date(),
            status: 'sleeping',
            updatedAt: new Date(),
          }
        : {
            deletionState: 'failed',
            deletionOperationId: null,
            deletionDetail: outcome.detail,
            deletionFinishedAt: new Date(),
            updatedAt: new Date(),
          },
    )
    .where(
      and(
        eq(repositories.id, repositoryId),
        eq(repositories.deletionState, 'deleting'),
        eq(repositories.deletionOperationId, operationId),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function findRepository(
  database: Database,
  repositoryId: string,
): Promise<Repository | null> {
  const [repository] = await database
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  return repository ?? null;
}

/**
 * Runs the owner-requested removal. Local resources belong to the host
 * supervisor; the API owns the durable claim and validates that no task still
 * uses the repository. The GitHub remote is never touched.
 */
export async function removeRepository(
  database: Database,
  config: ApiConfig,
  repositoryId: string,
  ownerId: string,
  options: { log?: { warn: (fields: Record<string, unknown>, message: string) => void } } = {},
): Promise<RepositoryRemovalResult> {
  const claim = await claimRemoval(database, repositoryId, ownerId);
  if (claim.kind === 'missing') throw ApiProblem.notFound('Repository not found');
  if (claim.kind === 'removed') {
    return { repository: claim.repository, outcome: 'already-removed' };
  }
  if (claim.kind === 'in-progress') {
    return { repository: claim.repository, outcome: 'in-progress' };
  }

  const supervisor = createSupervisorClient(config);
  if (!supervisor) {
    // Without a supervisor there is no managed local instance to stop. A row
    // with an instance profile still owns local resources, so refuse instead of
    // claiming a cleanup that did not happen.
    const [instance] = await database
      .select({ profile: repositoryInstances.profile })
      .from(repositoryInstances)
      .where(eq(repositoryInstances.repositoryId, repositoryId))
      .limit(1);
    if (instance?.profile) {
      const detail = '主机 supervisor 未配置，无法清理这个仓库的本地实例与副本。';
      const current = await finalizeRemoval(database, repositoryId, claim.operationId, {
        ok: false,
        detail,
      });
      return { repository: current ?? claim.repository, outcome: 'failed' };
    }
  } else {
    try {
      await supervisor.remove(repositoryId);
    } catch (error) {
      const detail = safeDetail(error instanceof Error ? error.message : String(error));
      const current = await finalizeRemoval(database, repositoryId, claim.operationId, {
        ok: false,
        detail,
      });
      options.log?.warn(
        { event: 'repository.removal_failed', repositoryId, error: detail },
        'repository removal failed; local resources stay retryable',
      );
      return {
        repository: current ?? (await findRepository(database, repositoryId)) ?? claim.repository,
        outcome: 'failed',
      };
    }
  }

  const removed = await finalizeRemoval(database, repositoryId, claim.operationId, { ok: true });
  if (removed) return { repository: removed, outcome: 'removed' };
  // A newer operation finished first; report its state rather than overwriting.
  const current = (await findRepository(database, repositoryId)) ?? claim.repository;
  return {
    repository: current,
    outcome: current.deletionState === 'removed' ? 'already-removed' : 'in-progress',
  };
}

/** Marks a deletion interrupted by a service restart as retryable. */
export async function recoverInterruptedDeletions(database: Database): Promise<number> {
  const rows = await database
    .update(repositories)
    .set({
      deletionState: 'failed',
      deletionOperationId: null,
      deletionDetail: '服务重启中断了移除；本地资源可能已部分清理，请重试。',
      deletionFinishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(repositories.deletionState, 'deleting'))
    .returning({ id: repositories.id });
  return rows.length;
}

/**
 * Removes the retained history of repositories whose 30-day window has ended.
 * The repository row stays removed; only conversations/tasks/messages are
 * deleted, which is exactly the confirmation text the owner saw.
 */
export async function purgeExpiredRepositoryHistory(
  database: Database,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_MS);
  const expired = await database
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.deletionState, 'removed'), lte(repositories.removedAt, cutoff)));
  const ids = expired.map((row) => row.id);
  if (ids.length === 0) return 0;
  const rows = await database
    .delete(conversations)
    .where(inArray(conversations.repositoryId, ids))
    .returning({ id: conversations.id });
  return rows.length;
}
