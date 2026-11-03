import { randomUUID } from 'node:crypto';

import { errorResponse, successResponse } from '@moyu/contracts';
import type { Database } from '@moyu/db';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import type { ApiConfig } from './config';
import { createLoggerOptions } from './logger';
import { SERVICE_NAME, SERVICE_VERSION } from './version';

export interface BuildAppOptions {
  config: ApiConfig;
  database?: Database;
}

export function buildApp({ config, database }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: createLoggerOptions(config),
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0 && header.length <= 200) {
        return header;
      }
      return randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/healthz', async (request) =>
    successResponse(
      {
        status: 'ok' as const,
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      },
      request.id,
    ),
  );

  app.get('/readyz', async (request, reply) => {
    if (!database) {
      return reply
        .code(503)
        .send(
          errorResponse('dependency_unavailable', 'Database is not configured', true, request.id),
        );
    }

    try {
      await database.execute(sql`select 1`);
      return successResponse({ status: 'ok' as const, database: 'ok' as const }, request.id);
    } catch (error) {
      request.log.error(
        { err: error, event: 'readiness.database_failed' },
        'readiness check failed',
      );
      return reply
        .code(503)
        .send(errorResponse('dependency_unavailable', 'Database is unavailable', true, request.id));
    }
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorResponse('not_found', 'Route not found', false, request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as FastifyError;
    const status = fastifyError.validation ? 422 : (fastifyError.statusCode ?? 500);

    if (status >= 500) {
      request.log.error({ err: error, event: 'request.failed' }, 'request failed');
    } else {
      request.log.warn({ err: error, event: 'request.rejected' }, 'request rejected');
    }

    const code =
      status === 404
        ? 'not_found'
        : status === 401
          ? 'unauthorized'
          : status === 403
            ? 'forbidden'
            : status === 409
              ? 'conflict'
              : status === 429
                ? 'rate_limited'
                : status >= 500
                  ? 'internal_error'
                  : 'invalid_request';

    return reply
      .code(status)
      .send(
        errorResponse(
          code,
          status >= 500 ? 'Internal server error' : fastifyError.message,
          status >= 500,
          request.id,
        ),
      );
  });

  return app;
}
