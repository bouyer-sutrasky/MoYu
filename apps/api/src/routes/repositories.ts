import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  createRepositoryInputSchema,
  githubRepositoryListDataSchema,
  githubRepositoryListQuerySchema,
  repositoryActionDataSchema,
  repositoryDataSchema,
  repositoryListDataSchema,
  repositoryRuntimeDataSchema,
  updateRepositoryInputSchema,
  type RepositorySummary,
} from '@moyu/contracts';
import { repositories, repositoryAuditEvents, type Database, type Repository } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import {
  ensureConfiguredRepository,
  findOwnedRepository,
  setRepositoryCheckCommands,
} from '../domain/repositories';
import {
  createSupervisorClient,
  projectRuntime,
  sleepRepository,
  wakeRepository,
} from '../domain/instances';
import { listGithubRepositories, requireWritableGithubRepository } from '../github/repositories';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';
import { isUniqueViolation } from '../lib/pg';

export interface RepositoryRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
}

async function summarize(
  database: Database,
  config: ApiConfig,
  repository: Repository,
): Promise<RepositorySummary> {
  return {
    id: repository.id,
    fullName: repository.fullName,
    githubRepositoryId: repository.githubRepositoryId,
    defaultBranch: repository.defaultBranch,
    status: repository.status,
    checkCommands: repository.checkCommands ?? null,
    runtime: await projectRuntime(database, config, repository),
    createdAt: repository.createdAt.toISOString(),
    updatedAt: repository.updatedAt.toISOString(),
  };
}

/**
 * Repository inventory and the only owner operations allowed on a runtime.
 * Adding reads the dedicated GitHub account's actual permission; wake/sleep send
 * a repository id to the host supervisor, which owns every path, port and token.
 */
export function registerRepositoryRoutes(
  app: FastifyInstance,
  dependencies: RepositoryRouteDependencies,
): void {
  const { config, database, authenticate } = dependencies;

  app.get('/api/v1/repositories', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }

    await ensureConfiguredRepository(database, config);

    const rows = await database
      .select()
      .from(repositories)
      .where(eq(repositories.ownerId, auth.owner.id))
      .orderBy(repositories.fullName);

    return sendData(
      reply,
      request,
      repositoryListDataSchema.parse({
        repositories: await Promise.all(
          rows.map((repository) => summarize(database, config, repository)),
        ),
      }),
    );
  });

  app.get('/api/v1/github/repositories', { preHandler: authenticate }, async (request, reply) => {
    if (!request.auth) throw ApiProblem.unauthorized();
    const query = parseInput(githubRepositoryListQuerySchema, request.query);
    const result = await listGithubRepositories(config, {
      ...(query.q ? { q: query.q } : {}),
      limit: query.limit ?? 50,
    });
    return sendData(reply, request, githubRepositoryListDataSchema.parse(result));
  });

  app.post('/api/v1/repositories', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const input = parseInput(createRepositoryInputSchema, request.body);
    await ensureConfiguredRepository(database, config);

    const [existing] = await database
      .select()
      .from(repositories)
      .where(eq(repositories.fullName, input.fullName))
      .limit(1);
    if (existing) {
      throw ApiProblem.conflict('This repository has already been added');
    }

    // GitHub is the authority for the repository identity, default branch and
    // the dedicated account's write permission. An inaccessible repository is
    // not created locally.
    const github = await requireWritableGithubRepository(config, input.fullName);

    let repository: Repository;
    try {
      repository = await database.transaction(async (transaction) => {
        const [created] = await transaction
          .insert(repositories)
          .values({
            ownerId: auth.owner.id,
            fullName: github.fullName,
            githubRepositoryId: github.githubRepositoryId,
            defaultBranch: github.defaultBranch,
            checkCommands: input.checkCommands ?? null,
            status: 'provisioning',
          })
          .returning();
        if (!created) throw new Error('repository insert returned no row');
        if (input.checkCommands) {
          await transaction.insert(repositoryAuditEvents).values({
            repositoryId: created.id,
            actorOwnerId: auth.owner.id,
            type: 'check_commands_updated',
            detail: { from: null, to: input.checkCommands },
          });
        }
        return created;
      });
    } catch (error) {
      if (
        isUniqueViolation(error, 'repositories_full_name_uq') ||
        isUniqueViolation(error, 'repositories_github_id_uq')
      ) {
        throw ApiProblem.conflict('This repository has already been added');
      }
      throw error;
    }

    // The supervisor prepares the fixed profile/port/credential boundary. If it
    // is unreachable, the row stays visible as sleeping/unprovisioned instead of
    // pretending the runtime exists.
    const supervisor = createSupervisorClient(config);
    if (supervisor) {
      try {
        await supervisor.prepare(repository.id);
        await supervisor.wake(repository.id, 'new_task');
      } catch (error) {
        request.log.warn(
          {
            event: 'repository.provision_failed',
            repositoryId: repository.id,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          },
          'repository was added but its runtime could not be prepared',
        );
      }
    }

    const [refreshed] = await database
      .select()
      .from(repositories)
      .where(eq(repositories.id, repository.id))
      .limit(1);
    return sendData(
      reply,
      request,
      repositoryRuntimeDataSchema.parse({
        repositoryId: repository.id,
        runtime: await projectRuntime(database, config, refreshed ?? repository),
      }),
      201,
    );
  });

  /**
   * Changes only this repository's check-command override. The supervisor reads
   * the column directly; the platform does not forward commands to it. `null`
   * restores the process-wide REVIEW_CHECK_COMMANDS default.
   */
  app.patch('/api/v1/repositories/:id', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const params = request.params as { id?: string };
    const input = parseInput(updateRepositoryInputSchema, request.body);
    const repository = await findOwnedRepository(database, auth.owner.id, params.id ?? '');
    if (!repository) throw ApiProblem.notFound('Repository not found');
    const updated = await setRepositoryCheckCommands({
      database,
      repository,
      actorOwnerId: auth.owner.id,
      commands: input.checkCommands,
    });
    return sendData(
      reply,
      request,
      repositoryDataSchema.parse({
        repository: await summarize(database, config, updated),
      }),
    );
  });

  app.get(
    '/api/v1/repositories/:id/runtime',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw ApiProblem.unauthorized();
      const params = request.params as { id?: string };
      const repository = await findOwnedRepository(database, auth.owner.id, params.id ?? '');
      if (!repository) throw ApiProblem.notFound('Repository not found');
      return sendData(
        reply,
        request,
        repositoryRuntimeDataSchema.parse({
          repositoryId: repository.id,
          runtime: await projectRuntime(database, config, repository),
        }),
      );
    },
  );

  app.post(
    '/api/v1/repositories/:id/wake',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw ApiProblem.unauthorized();
      const params = request.params as { id?: string };
      const repository = await findOwnedRepository(database, auth.owner.id, params.id ?? '');
      if (!repository) throw ApiProblem.notFound('Repository not found');
      const runtime = await wakeRepository(database, config, repository);
      return sendData(
        reply,
        request,
        repositoryActionDataSchema.parse({
          repositoryId: repository.id,
          accepted: true,
          duplicate: runtime.state === 'online' || runtime.state === 'starting',
          runtime,
        }),
      );
    },
  );

  app.post(
    '/api/v1/repositories/:id/sleep',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw ApiProblem.unauthorized();
      const params = request.params as { id?: string };
      const repository = await findOwnedRepository(database, auth.owner.id, params.id ?? '');
      if (!repository) throw ApiProblem.notFound('Repository not found');
      const result = await sleepRepository(database, config, repository);
      return sendData(
        reply,
        request,
        repositoryActionDataSchema.parse({
          repositoryId: repository.id,
          accepted: result.accepted,
          duplicate: false,
          runtime: result.runtime,
        }),
        200,
      );
    },
  );
}
