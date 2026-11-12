import { eq } from 'drizzle-orm';

import type { Repository } from '@moyu/db';
import { owners, repositories, repositoryAuditEvents, type Database } from '@moyu/db';

import type { ApiConfig } from '../config';
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
 * the effective value changes. The update and the audit are one transaction:
 * a successful response always has its who/what/when record committed.
 */
export async function setRepositoryCheckCommands(input: {
  database: Database;
  repository: Repository;
  actorOwnerId: string;
  commands: string[] | null;
}): Promise<Repository> {
  const { database, repository, actorOwnerId, commands } = input;
  return database.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(repositories)
      .set({ checkCommands: commands, updatedAt: new Date() })
      .where(eq(repositories.id, repository.id))
      .returning();
    if (!updated) {
      throw new Error('repository update returned no row');
    }
    if (!sameCommands(repository.checkCommands, commands)) {
      await transaction.insert(repositoryAuditEvents).values({
        repositoryId: repository.id,
        actorOwnerId,
        type: 'check_commands_updated',
        detail: { from: repository.checkCommands, to: commands },
      });
    }
    return updated;
  });
}
