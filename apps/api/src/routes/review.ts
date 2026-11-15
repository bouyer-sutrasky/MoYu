import type { FastifyInstance } from 'fastify';

import { taskReviewDataSchema, uuidSchema } from '@moyu/contracts';
import type { Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import { collectChanges, loadOwnedTask, projectReview, runChecks } from '../domain/review';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';

export interface ReviewRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
}

/**
 * Review data for one task: stored worktree diff and check runs, plus the
 * delivery state. Reading is a pure projection of persisted artifacts, which is
 * why a platform restart does not lose a panel. Collection is the only part that
 * touches the runtime, and it goes through the host supervisor.
 */
export function registerReviewRoutes(
  app: FastifyInstance,
  dependencies: ReviewRouteDependencies,
): void {
  const { config, database, authenticate } = dependencies;

  const taskIdOf = (request: { params: unknown }): string => {
    const params = request.params as { id?: string };
    return parseInput(uuidSchema, params.id);
  };

  app.get('/api/v1/tasks/:id/review', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const { task, conversation } = await loadOwnedTask(database, auth.owner.id, taskIdOf(request));
    return sendData(
      reply,
      request,
      taskReviewDataSchema.parse({
        review: await projectReview(database, task, conversation),
      }),
    );
  });

  app.post(
    '/api/v1/tasks/:id/review/changes',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw ApiProblem.unauthorized();
      const { task, conversation, repository } = await loadOwnedTask(
        database,
        auth.owner.id,
        taskIdOf(request),
      );
      return sendData(
        reply,
        request,
        taskReviewDataSchema.parse({
          review: await collectChanges(database, config, repository, task, conversation),
        }),
      );
    },
  );

  app.post(
    '/api/v1/tasks/:id/review/checks',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw ApiProblem.unauthorized();
      const { task, conversation, repository } = await loadOwnedTask(
        database,
        auth.owner.id,
        taskIdOf(request),
      );
      return sendData(
        reply,
        request,
        taskReviewDataSchema.parse({
          review: await runChecks(database, config, repository, task, conversation),
        }),
      );
    },
  );
}
