import { eq } from 'drizzle-orm';

import type { Repository } from '@moyu/db';
import { owners, repositories, repositoryAuditEvents, type Database } from '@moyu/db';

import type { ApiConfig } from '../config';
import { REPOSITORY_HISTORY_RETENTION_DAYS } from '@moyu/contracts';
import { ApiProblem } from '../lib/errors';
import { ensureLegacyInstance } from './instances';

/**
 * Binds the configured repository to this API process. The deployment fact is
 * the environment (owner/name plus a loopback Bridge endpoint); the database row
 * carries no secret, only a reference name for the machine token.
 */
export async function ensureConfiguredRepository(
  database: Database,
  config: ApiConfig,
): Promise<Repository | null> {
  const fullName = config.bridgeRepository;
  if (!fullName) {
    return null;
  }
  const [owner] = await database.select().from(owners).orderBy(owners.createdAt).limit(1);
  if (!owner) {
    return null;
  }
  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName,
      defaultBranch: config.bridgeDefaultBranch,
      status: config.bridgeUrl ? 'active' : 'provisioning',
      bridgeUrl: config.bridgeUrl ?? null,
      bridgeCredentialRef: config.bridgeCredentialRef ?? null,
    })
    .onConflictDoUpdate({
      target: repositories.fullName,
      set: {
        defaultBranch: config.bridgeDefaultBranch,
        status: config.bridgeUrl ? 'active' : 'provisioning',
        bridgeUrl: config.bridgeUrl ?? null,
        bridgeCredentialRef: config.bridgeCredentialRef ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (repository) {
    await ensureLegacyInstance(database, config, repository);
  }
  return repository ?? null;
}

export async function findOwnedRepository(
  database: Database,
  ownerId: string,
  repositoryId: string,
): Promise<Repository | undefined> {
  const [repository] = await database
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repository || repository.ownerId !== ownerId) {
    return undefined;
  }
  if (repository.deletionState === 'removed') {
    const expired =
      repository.removedAt !== null &&
      Date.now() - repository.removedAt.getTime() >
        REPOSITORY_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    throw ApiProblem.notFound(
      expired
        ? '该仓库已从 MoYu 移除，历史保留期已结束并已清理；不能通过旧链接访问。'
        : '该仓库已从 MoYu 移除；历史任务与会话在 30 天保留期内只读保存，重新接入同一仓库可恢复。',
    );
  }
  if (repository.deletionState === 'deleting' || repository.deletionState === 'failed') {
    throw ApiProblem.conflict(
      repository.deletionState === 'deleting'
        ? '该仓库正在从 MoYu 移除；完成前不能开始新任务、准备仓库或修改设置。'
        : `该仓库上次移除失败：${repository.deletionDetail ?? '原因未知'}。请重试移除或等待处理。`,
    );
  }
  return repository;
}

function sameCommands(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((command, index) => command === right[index]);
}

/**
 * Updates the repository's check-command override and records an audit row when
 * the effective value changes. The row is locked and re-read inside the
 * transaction, so two concurrent changes cannot both claim the same `from`
 * value; the update and its audit commit together.
 */
export async function setRepositoryCheckCommands(input: {
  database: Database;
  repository: Repository;
  actorOwnerId: string;
  commands: string[] | null;
}): Promise<Repository> {
  const { database, repository, actorOwnerId, commands } = input;
  return database.transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(repositories)
      .where(eq(repositories.id, repository.id))
      .for('update');
    if (!current) {
      throw new Error('repository disappeared during update');
    }
    if (sameCommands(current.checkCommands, commands)) {
      return current;
    }
    const [updated] = await transaction
      .update(repositories)
      .set({ checkCommands: commands, updatedAt: new Date() })
      .where(eq(repositories.id, repository.id))
      .returning();
    if (!updated) {
      throw new Error('repository update returned no row');
    }
    await transaction.insert(repositoryAuditEvents).values({
      repositoryId: repository.id,
      actorOwnerId,
      type: 'check_commands_updated',
      detail: { from: current.checkCommands, to: commands },
    });
    return updated;
  });
}
