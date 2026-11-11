import type { FastifyInstance } from 'fastify';

import {
  cleanupExecuteDataSchema,
  cleanupExecuteInputSchema,
  cleanupPreviewDataSchema,
  cleanupPreviewInputSchema,
  cleanupRunsDataSchema,
  cleanupRunsQuerySchema,
} from '@moyu/contracts';
import type { Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import { executeCleanup, listCleanupRuns, previewCleanup } from '../domain/cleanup';
import { findOwnedRepository } from '../domain/repositories';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';

export interface CleanupRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
}

/**
 * Worktree cleanup endpoints. Preview is a dry run that records every proposed
 * path, size and skip reason. Execution names exactly one preview run; the
 * server re-checks merge state, retention and the real worktree before deleting
 * anything, and a repeated execution returns the stored result.
 */
export function registerCleanupRoutes(
  app: FastifyInstance,
  dependencies: CleanupRouteDependencies,
): void {
  const { config, database, authenticate } = dependencies;

  app.post('/api/v1/cleanup/preview', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const input = parseInput(cleanupPreviewInputSchema, request.body ?? {});
    if (input.repositoryId) {
      const repository = await findOwnedRepository(database, auth.owner.id, input.repositoryId);
      if (!repository) throw ApiProblem.notFound('Repository not found');
    }
    const run = await previewCleanup({
      config,
      database,
      ownerId: auth.owner.id,
      repositoryId: input.repositoryId,
    });
    return sendData(reply, request, cleanupPreviewDataSchema.parse({ run }));
  });

  app.post('/api/v1/cleanup/execute', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const input = parseInput(cleanupExecuteInputSchema, request.body);
    const result = await executeCleanup({
      config,
      database,
      ownerId: auth.owner.id,
      previewRunId: input.runId,
    });
    return sendData(reply, request, cleanupExecuteDataSchema.parse(result));
  });

  app.get('/api/v1/cleanup/runs', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const query = parseInput(cleanupRunsQuerySchema, request.query);
    const runs = await listCleanupRuns({
      database,
      ownerId: auth.owner.id,
      limit: query.limit,
    });
    return sendData(reply, request, cleanupRunsDataSchema.parse({ runs }));
  });
}
