import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { repositoryListDataSchema } from '@moyu/contracts';
import { repositories, type Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import { ApiProblem } from '../lib/errors';
import { sendData } from '../lib/http';

export interface RepositoryRouteDependencies {
  database: Database;
  authenticate: Authenticate;
}

/**
 * Read-only repository inventory for the M2 shell. Adding, waking and branch
 * listing are M3/M4 operations and stay visibly unavailable in the UI.
 */
export function registerRepositoryRoutes(
  app: FastifyInstance,
  dependencies: RepositoryRouteDependencies,
): void {
  const { database, authenticate } = dependencies;

  app.get('/api/v1/repositories', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }

    const rows = await database
      .select()
      .from(repositories)
      .where(eq(repositories.ownerId, auth.owner.id))
      .orderBy(repositories.fullName);

    return sendData(
      reply,
      request,
      repositoryListDataSchema.parse({
        repositories: rows.map((repository) => ({
          id: repository.id,
          fullName: repository.fullName,
          githubRepositoryId: repository.githubRepositoryId,
          defaultBranch: repository.defaultBranch,
          status: repository.status,
          createdAt: repository.createdAt.toISOString(),
          updatedAt: repository.updatedAt.toISOString(),
        })),
      }),
    );
  });
}
