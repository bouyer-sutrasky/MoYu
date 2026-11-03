import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { errorResponse, successResponse } from '@moyu/contracts';
import type { Database } from '@moyu/db';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createAuthenticate } from './auth/guards';
import { createMachineAuthenticate } from './auth/machine';
import { SessionService } from './auth/sessions';
import type { ApiConfig } from './config';
import { createAppEventBus } from './events/bus';
import { ApiProblem } from './lib/errors';
import { createLoggerOptions } from './logger';
import { registerAttachmentRoutes } from './routes/attachments';
import { ensureConfiguredRepository } from './domain/repositories';
import { registerAuthRoutes } from './routes/auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerEventRoutes } from './routes/events';
import { registerRuntimeRoutes } from './routes/runtime';
import { registerRepositoryRoutes } from './routes/repositories';
import { SERVICE_NAME, SERVICE_VERSION } from './version';

export interface BuildAppOptions {
  config: ApiConfig;
  database?: Database;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

export function buildApp({ config, database }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: createLoggerOptions(config),
    // nginx is the only public listener and proxies from loopback. Trust its
    // X-Forwarded-For so rate limits and logs see the real client address.
    trustProxy: '127.0.0.1',
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0 && header.length <= 200) {
        return header;
      }
      return randomUUID();
    },
  });

  const eventBus = createAppEventBus();
  app.addHook('onClose', async () => {
    eventBus.close();
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
  });

  app.addHook('onRequest', async (request) => {
    const method = request.method.toUpperCase();
    if (!request.url.startsWith('/api/') || method === 'GET' || method === 'HEAD') {
      return;
    }
    const origin = request.headers.origin;
    if (origin && origin !== config.webauthnOrigin) {
      throw ApiProblem.forbidden('Request origin does not match the configured WebAuthn origin');
    }
  });

  app.register(fastifyCookie, {});

  const webDistDir = config.webDistDir ? path.resolve(config.webDistDir) : null;
  const hasWebBuild = Boolean(webDistDir && existsSync(path.join(webDistDir, 'index.html')));
  if (webDistDir && hasWebBuild) {
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      index: ['index.html'],
      cacheControl: false,
      setHeaders(response, filePath) {
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
        response.header(
          'cache-control',
          immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  const sessionService = database
    ? new SessionService(database, config.sessionTtlMs, eventBus)
    : undefined;

  if (database && sessionService) {
    const authenticate = createAuthenticate({ config, sessions: sessionService });
    const machineAuthenticate = createMachineAuthenticate(config);
    registerAuthRoutes(app, { config, database, sessions: sessionService });
    registerRepositoryRoutes(app, { config, database, authenticate });
    registerEventRoutes(app, {
      database,
      sessions: sessionService,
      events: eventBus,
      authenticate,
    });
    registerConversationRoutes(app, { config, database, authenticate, events: eventBus });
    registerRuntimeRoutes(app, {
      config,
      database,
      authenticate,
      machineAuthenticate,
      events: eventBus,
    });
    registerAttachmentRoutes(app, { config, database, authenticate });

    // Bind the configured repository once the owner exists; a first boot before
    // Passkey registration simply waits for a later call (list, conversation,
    // model catalog) to bind it again.
    app.addHook('onReady', async () => {
      try {
        const repository = await ensureConfiguredRepository(database, config);
        if (repository) {
          app.log.info(
            {
              event: 'repository.bound',
              repository: repository.fullName,
              bridge: Boolean(repository.bridgeUrl),
            },
            'repository runtime binding is active',
          );
        }
      } catch (error) {
        app.log.warn({ err: error, event: 'repository.bind_failed' }, 'repository binding failed');
      }
    });
  }

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
    const method = request.method.toUpperCase();
    if (
      hasWebBuild &&
      webDistDir &&
      (method === 'GET' || method === 'HEAD') &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/healthz') &&
      !request.url.startsWith('/readyz')
    ) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send(errorResponse('not_found', 'Route not found', false, request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiProblem) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, event: 'request.failed' }, 'request failed');
      } else {
        request.log.warn(
          { err: error, event: 'request.rejected', code: error.code },
          'request rejected',
        );
      }
      return reply
        .code(error.statusCode)
        .send(errorResponse(error.code, error.message, error.retryable, request.id));
    }

    if (error instanceof z.ZodError) {
      request.log.warn({ err: error, event: 'request.invalid' }, 'request validation failed');
      return reply
        .code(422)
        .send(
          errorResponse(
            'invalid_request',
            error.issues[0]?.message ?? 'Invalid request',
            false,
            request.id,
          ),
        );
    }

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
