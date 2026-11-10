import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { uuidSchema } from '@moyu/contracts';

import type { SupervisorConfig } from './config';
import type { SupervisorStore } from './store';
import type { SupervisorLogger } from './logger';
import type { InstanceManager } from './manager';
import { createReviewService } from './review';
import { createCleanupService } from './cleanup';

const wakeSchema = z
  .object({
    priority: z.number().int().min(1).max(100).optional(),
    reason: z.enum(['new_task', 'reply', 'manual', 'retry']).optional(),
    execution: z
      .object({
        ticketId: z.string().min(1).max(200),
        assignmentId: z.string().min(1).max(200),
        leaseId: z.string().min(1).max(200),
        fencingToken: z.string().min(1).max(200),
      })
      .optional(),
  })
  .strict();

const sleepSchema = z.object({ manual: z.boolean().optional() }).strict();

const reviewTicketSchema = z.object({ ticketId: z.string().min(1).max(200) }).strict();

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function repositoryIdOf(request: { params: unknown }): string {
  const parsed = z.object({ repositoryId: uuidSchema }).safeParse(request.params);
  if (!parsed.success) throw Object.assign(new Error('Invalid repository id'), { statusCode: 422 });
  return parsed.data.repositoryId;
}

export function buildSupervisorServer(options: {
  config: SupervisorConfig;
  manager: InstanceManager;
  store: SupervisorStore;
  logger: SupervisorLogger;
}): FastifyInstance {
  const { config, manager, logger } = options;
  const review = createReviewService({ config, store: options.store, logger });
  const cleanup = createCleanupService({ config, store: options.store });
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });

  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'machine token required' } });
      return;
    }
    const supplied = header.slice('Bearer '.length).trim();
    if (!supplied || !timingSafeEqual(digest(supplied), digest(config.token))) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'machine token invalid' } });
    }
  });

  app.get('/control/v1/health', async () => ({ status: 'ok', service: 'moyu-supervisor' }));

  app.post('/control/v1/instances/:repositoryId/prepare', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const instance = await manager.prepare(repositoryId);
    return { data: instance };
  });

  app.post('/control/v1/instances/:repositoryId/wake', async (request, reply) => {
    const repositoryId = repositoryIdOf(request);
    const body = wakeSchema.parse(request.body ?? {});
    const result = await manager.wake(repositoryId, {
      priority: body.priority ?? (body.reason === 'reply' ? 10 : 20),
      reason: body.reason ?? 'manual',
      ...(body.execution ? { execution: body.execution } : {}),
    });
    if (!result.accepted) return reply.code(409).send({ data: result });
    return { data: result };
  });

  app.post('/control/v1/instances/:repositoryId/sleep', async (request, reply) => {
    const repositoryId = repositoryIdOf(request);
    const body = sleepSchema.parse(request.body ?? {});
    const result = await manager.sleep(repositoryId, body.manual ?? true);
    return reply.code(result.accepted ? 200 : 409).send({ data: result });
  });

  app.post('/control/v1/instances/:repositoryId/touch', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const instance = await manager.touch(repositoryId);
    return { data: instance };
  });

  app.post('/control/v1/instances/:repositoryId/retry', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const result = await manager.wake(repositoryId, { priority: 5, reason: 'retry' });
    return { data: result };
  });

  // Review inspection. The caller names only a ticket id; the supervisor resolves
  // the worktree under its own configured root and the check commands come from
  // its own configuration, never from the request.
  app.post('/control/v1/instances/:repositoryId/review/worktree', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const body = reviewTicketSchema.parse(request.body ?? {});
    return { data: await review.resolve(repositoryId, body.ticketId) };
  });

  app.post('/control/v1/instances/:repositoryId/review/changes', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const body = reviewTicketSchema.parse(request.body ?? {});
    return { data: await review.changes(repositoryId, body.ticketId) };
  });

  app.post('/control/v1/instances/:repositoryId/review/checks', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const body = reviewTicketSchema.parse(request.body ?? {});
    const worktree = await review.resolve(repositoryId, body.ticketId);
    const runs = await review.checks(repositoryId, body.ticketId);
    return { data: { worktree, runs } };
  });

  // Cleanup inspection and deletion. The caller names only a ticket id; the
  // directory, profile and boundary come from this process's configuration and
  // every destructive call re-checks the real worktree state.
  app.post('/control/v1/instances/:repositoryId/cleanup/inspect', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const body = reviewTicketSchema.parse(request.body ?? {});
    return { data: await cleanup.inspect(repositoryId, body.ticketId) };
  });

  app.post('/control/v1/instances/:repositoryId/cleanup/delete', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const body = reviewTicketSchema.parse(request.body ?? {});
    return { data: await cleanup.remove(repositoryId, body.ticketId) };
  });

  app.post('/control/v1/instances/:repositoryId/cleanup/trash', async (request) => {
    const repositoryId = repositoryIdOf(request);
    return { data: await cleanup.emptyTrash(repositoryId) };
  });

  app.get('/control/v1/instances/:repositoryId', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const instance = await manager.touch(repositoryId);
    return { data: instance };
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : 'supervisor request failed';
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : error instanceof z.ZodError
          ? 422
          : 500;
    if (statusCode >= 500) {
      logger.error(
        { event: 'supervisor.request_failed', error: message.slice(0, 300) },
        'supervisor request failed',
      );
    }
    void reply.code(statusCode).send({
      error: {
        code:
          statusCode === 422
            ? 'invalid_request'
            : statusCode === 404
              ? 'not_found'
              : 'internal_error',
        message: statusCode >= 500 ? 'supervisor request failed' : message,
      },
    });
  });

  return app;
}
