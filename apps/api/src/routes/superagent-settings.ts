import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { uuidSchema } from '@moyu/contracts';
import { type Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import { findOwnedRepository } from '../domain/repositories';
import { ApiProblem } from '../lib/errors';
import {
  createSupervisorClient,
  type PanelResult,
  type SupervisorClient,
} from '../runtime/supervisor';

export interface SuperagentSettingsDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
}

/**
 * Per-repository Superagent settings, relayed to the repository's own runtime.
 *
 * The browser names a repository it owns and a block; it never names a port, a
 * URL, a profile or a token. The API asks the host supervisor, which resolves the
 * instance port from its own state and only relays an allow-listed panel call.
 */
const blockSchema = z
  .string()
  .regex(/^(policy|eval|executor|pause|source:[a-z][a-z0-9-]*)$/, 'unsupported settings block');

const saveBodySchema = z
  .object({
    value: z.unknown(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

const deploymentOpSchema = z.union([
  z.object({ op: z.literal('set'), path: z.array(z.string()).min(1), value: z.unknown() }).strict(),
  z.object({ op: z.literal('unset'), path: z.array(z.string()).min(1) }).strict(),
]);

const deploymentBodySchema = z
  .object({
    ops: z.array(deploymentOpSchema).min(1).max(8),
    revision: z.number().int().nonnegative(),
  })
  .strict();

const promptsBodySchema = z
  .object({
    config: z.unknown(),
    baseRevision: z.number().int().nonnegative(),
  })
  .strict();

function requireSupervisor(config: ApiConfig): SupervisorClient {
  const supervisor = createSupervisorClient(config);
  if (!supervisor) {
    throw ApiProblem.unavailable('The host supervisor is not configured');
  }
  return supervisor;
}

/**
 * Relays a panel result. The runtime answers with its own error shape, and its
 * 409/422 are meaningful to the settings UI, so they are passed through rather
 * than flattened into a generic failure.
 */
function relay(reply: FastifyReply, request: FastifyRequest, result: PanelResult) {
  if (result.status >= 200 && result.status < 300) {
    reply.code(result.status);
    return result.body;
  }
  const body = result.body;
  const message =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : body &&
          typeof body === 'object' &&
          (body as { error?: { message?: unknown } }).error &&
          typeof (body as { error: { message?: unknown } }).error.message === 'string'
        ? String((body as { error: { message: string } }).error.message)
        : 'The repository runtime rejected the settings request';
  reply.code(result.status);
  return {
    error: {
      code:
        result.status === 409
          ? 'settings_conflict'
          : result.status === 422
            ? 'invalid_settings'
            : result.status === 404
              ? 'not_found'
              : 'runtime_error',
      message: message.slice(0, 500),
      retryable: result.status === 409 || result.status >= 500,
    },
    requestId: request.id,
    runtime: body,
  };
}

export function registerSuperagentSettingsRoutes(
  app: FastifyInstance,
  dependencies: SuperagentSettingsDependencies,
): void {
  const { config, database, authenticate } = dependencies;

  const ownedRepository = async (request: FastifyRequest) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const params = z.object({ id: uuidSchema }).safeParse(request.params);
    if (!params.success) throw ApiProblem.invalid('Invalid repository id');
    const repository = await findOwnedRepository(database, auth.owner.id, params.data.id);
    if (!repository) throw ApiProblem.notFound('Repository not found');
    return repository;
  };

  const read =
    (page: 'state' | 'settings' | 'sources' | 'models' | 'prompts' | 'policy-history') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const repository = await ownedRepository(request);
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panel(repository.id, { kind: 'read', page });
      return relay(reply, request, result);
    };

  app.get(
    '/api/v1/repositories/:id/superagent/settings',
    { preHandler: authenticate },
    read('settings'),
  );
  app.get('/api/v1/repositories/:id/superagent/state', { preHandler: authenticate }, read('state'));
  app.get(
    '/api/v1/repositories/:id/superagent/sources',
    { preHandler: authenticate },
    read('sources'),
  );
  app.get(
    '/api/v1/repositories/:id/superagent/models',
    { preHandler: authenticate },
    read('models'),
  );
  app.get(
    '/api/v1/repositories/:id/superagent/prompts',
    { preHandler: authenticate },
    read('prompts'),
  );
  app.get(
    '/api/v1/repositories/:id/superagent/policy-history',
    { preHandler: authenticate },
    read('policy-history'),
  );

  app.put(
    '/api/v1/repositories/:id/superagent/settings/:block',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const params = z.object({ block: blockSchema }).safeParse(request.params);
      if (!params.success) {
        throw ApiProblem.invalid('Unsupported settings block');
      }
      const body = saveBodySchema.safeParse(request.body);
      if (!body.success) {
        throw ApiProblem.invalid('A settings save needs { value, revision }');
      }
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panel(repository.id, {
        kind: 'save-settings',
        block: params.data.block,
        body: { value: body.data.value, revision: body.data.revision },
      });
      return relay(reply, request, result);
    },
  );

  app.get(
    '/api/v1/repositories/:id/superagent/deployment',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const supervisor = requireSupervisor(config);
      const result = await supervisor.deployment(repository.id);
      return relay(reply, request, result);
    },
  );

  app.put(
    '/api/v1/repositories/:id/superagent/deployment',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const body = deploymentBodySchema.safeParse(request.body);
      if (!body.success) {
        throw ApiProblem.invalid('A Deployment save needs { ops, revision }');
      }
      const supervisor = requireSupervisor(config);
      const result = await supervisor.saveDeployment(repository.id, {
        ops: body.data.ops,
        revision: body.data.revision,
      });
      return relay(reply, request, result);
    },
  );

  app.put(
    '/api/v1/repositories/:id/superagent/prompts',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const body = promptsBodySchema.safeParse(request.body);
      if (!body.success) {
        throw ApiProblem.invalid('A prompt save needs { config, baseRevision }');
      }
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panel(repository.id, {
        kind: 'save-prompts',
        body: { config: body.data.config, baseRevision: body.data.baseRevision },
      });
      return relay(reply, request, result);
    },
  );
}
