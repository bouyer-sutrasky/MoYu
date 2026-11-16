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
    expectedInstanceId: z.string().min(1),
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
    expectedInstanceId: z.string().min(1),
  })
  .strict();

const promptsBodySchema = z
  .object({
    config: z.unknown(),
    baseRevision: z.number().int().nonnegative(),
    expectedInstanceId: z.string().min(1),
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
    return result.body && typeof result.body === 'object' && !Array.isArray(result.body)
      ? { ...(result.body as Record<string, unknown>), requestId: request.id }
      : result.body;
  }
  const body = result.body;
  const runtime =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const runtimeError =
    runtime.error && typeof runtime.error === 'object' && !Array.isArray(runtime.error)
      ? (runtime.error as Record<string, unknown>)
      : {};
  const message =
    typeof runtime.error === 'string'
      ? runtime.error
      : typeof runtimeError.message === 'string'
        ? runtimeError.message
        : 'The repository runtime rejected the settings request';
  const code =
    typeof runtimeError.code === 'string'
      ? runtimeError.code
      : result.status === 409
        ? 'settings_conflict'
        : result.status === 422
          ? 'invalid_settings'
          : result.status === 404
            ? 'not_found'
            : 'runtime_error';
  // The settings client renders field paths, setup problems and business
  // values from the top level. Keep only those public shapes; never promote
  // arbitrary runtime internals.
  const issues = Array.isArray(runtime.issues)
    ? runtime.issues
    : Array.isArray(runtimeError.issues)
      ? runtimeError.issues
      : [];
  const values =
    runtime.values && typeof runtime.values === 'object' && !Array.isArray(runtime.values)
      ? runtime.values
      : runtimeError.values &&
          typeof runtimeError.values === 'object' &&
          !Array.isArray(runtimeError.values)
        ? runtimeError.values
        : undefined;
  const setup =
    runtime.setup && typeof runtime.setup === 'object' && !Array.isArray(runtime.setup)
      ? runtime.setup
      : runtimeError.setup &&
          typeof runtimeError.setup === 'object' &&
          !Array.isArray(runtimeError.setup)
        ? runtimeError.setup
        : undefined;
  reply.code(result.status);
  return {
    error: {
      code,
      message: message.slice(0, 500),
      retryable:
        typeof runtimeError.retryable === 'boolean'
          ? runtimeError.retryable
          : result.status === 409 || result.status >= 500,
    },
    ...(issues.length > 0 ? { issues } : {}),
    ...(values ? { values } : {}),
    ...(setup ? { setup } : {}),
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
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const query = z
        .object({
          revision: z.coerce.number().int().nonnegative().optional(),
          offset: z.coerce.number().int().nonnegative().optional(),
        })
        .strict()
        .safeParse(request.query ?? {});
      if (!query.success) {
        throw ApiProblem.invalid('Prompt history accepts non-negative revision and offset only');
      }
      const supervisor = requireSupervisor(config);
      const forwarded: Record<string, string> = {};
      if (query.data.revision !== undefined) forwarded.revision = String(query.data.revision);
      if (query.data.offset !== undefined) forwarded.offset = String(query.data.offset);
      const result = await supervisor.panel(repository.id, {
        kind: 'read',
        page: 'prompts',
        ...(Object.keys(forwarded).length > 0 ? { query: forwarded } : {}),
      });
      return relay(reply, request, result);
    },
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
        throw ApiProblem.invalid('A settings save needs { value, revision, expectedInstanceId }');
      }
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panel(repository.id, {
        kind: 'save-settings',
        block: params.data.block,
        body: {
          value: body.data.value,
          revision: body.data.revision,
          expectedInstanceId: body.data.expectedInstanceId,
        },
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
        throw ApiProblem.invalid('A Deployment save needs { ops, revision, expectedInstanceId }');
      }
      const supervisor = requireSupervisor(config);
      const result = await supervisor.saveDeployment(repository.id, {
        ops: body.data.ops,
        revision: body.data.revision,
        expectedInstanceId: body.data.expectedInstanceId,
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
        throw ApiProblem.invalid(
          'A prompt save needs { config, baseRevision, expectedInstanceId }',
        );
      }
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panel(repository.id, {
        kind: 'save-prompts',
        body: {
          config: body.data.config,
          baseRevision: body.data.baseRevision,
          expectedInstanceId: body.data.expectedInstanceId,
        },
      });
      return relay(reply, request, result);
    },
  );

  const sourceIdSchema = z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9-]*$/, 'invalid source id');
  const ticketIdSchema = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/, 'invalid ticket id');

  app.post(
    '/api/v1/repositories/:id/superagent/prompts/preview',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const body = z
        .object({ config: z.unknown() })
        .strict()
        .safeParse(request.body ?? {});
      if (!body.success) throw ApiProblem.invalid('Prompt preview needs { config }');
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panelAction(repository.id, {
        kind: 'prompts-preview',
        body: { config: body.data.config },
      });
      return relay(reply, request, result);
    },
  );

  app.post(
    '/api/v1/repositories/:id/superagent/sources/:sourceId/labels',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const params = z.object({ sourceId: sourceIdSchema }).safeParse(request.params);
      if (!params.success) throw ApiProblem.invalid('Invalid source id');
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panelAction(repository.id, {
        kind: 'source-labels',
        sourceId: params.data.sourceId,
      });
      return relay(reply, request, result);
    },
  );

  app.post(
    '/api/v1/repositories/:id/superagent/policy-sync/:sourceId',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const params = z.object({ sourceId: sourceIdSchema }).safeParse(request.params);
      if (!params.success) throw ApiProblem.invalid('Invalid source id');
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panelAction(repository.id, {
        kind: 'policy-sync',
        sourceId: params.data.sourceId,
      });
      return relay(reply, request, result);
    },
  );

  app.post(
    '/api/v1/repositories/:id/superagent/executor/pause',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const body = z
        .object({ paused: z.boolean() })
        .strict()
        .safeParse(request.body ?? {});
      if (!body.success) throw ApiProblem.invalid('Executor pause needs { paused: boolean }');
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panelAction(repository.id, {
        kind: 'executor-pause',
        paused: body.data.paused,
      });
      return relay(reply, request, result);
    },
  );

  app.post(
    '/api/v1/repositories/:id/superagent/setup/check',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panelAction(repository.id, { kind: 'setup-check' });
      return relay(reply, request, result);
    },
  );

  app.get(
    '/api/v1/repositories/:id/superagent/tickets',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const query = z
        .object({
          state: z.string().min(1).max(80).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .strict()
        .safeParse(request.query ?? {});
      if (!query.success) throw ApiProblem.invalid('Invalid ticket query');
      const forwarded: Record<string, string> = {};
      if (query.data.state) forwarded.state = query.data.state;
      if (query.data.limit !== undefined) forwarded.limit = String(query.data.limit);
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panelAction(repository.id, {
        kind: 'tickets',
        query: forwarded,
      });
      return relay(reply, request, result);
    },
  );

  app.get(
    '/api/v1/repositories/:id/superagent/tickets/:ticketId',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const params = z.object({ ticketId: ticketIdSchema }).safeParse(request.params);
      if (!params.success) throw ApiProblem.invalid('Invalid ticket id');
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panelAction(repository.id, {
        kind: 'ticket',
        ticketId: params.data.ticketId,
      });
      return relay(reply, request, result);
    },
  );

  for (const action of ['retry', 'stop'] as const) {
    app.post(
      `/api/v1/repositories/:id/superagent/tickets/:ticketId/${action}`,
      { preHandler: authenticate },
      async (request, reply) => {
        const repository = await ownedRepository(request);
        const params = z.object({ ticketId: ticketIdSchema }).safeParse(request.params);
        if (!params.success) throw ApiProblem.invalid('Invalid ticket id');
        const supervisor = requireSupervisor(config);
        const result = await supervisor.panelAction(repository.id, {
          kind: action === 'retry' ? 'ticket-retry' : 'ticket-stop',
          ticketId: params.data.ticketId,
        });
        return relay(reply, request, result);
      },
    );
  }

  app.get(
    '/api/v1/repositories/:id/superagent/decisions',
    { preHandler: authenticate },
    async (request, reply) => {
      const repository = await ownedRepository(request);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          kind: z.string().max(200).optional(),
          window: z.string().max(20).optional(),
        })
        .strict()
        .safeParse(request.query ?? {});
      if (!query.success) throw ApiProblem.invalid('Invalid decisions query');
      const forwarded: Record<string, string> = {};
      if (query.data.limit !== undefined) forwarded.limit = String(query.data.limit);
      if (query.data.kind) forwarded.kind = query.data.kind;
      if (query.data.window) forwarded.window = query.data.window;
      const supervisor = requireSupervisor(config);
      const result = await supervisor.panelAction(repository.id, {
        kind: 'decisions',
        query: forwarded,
      });
      return relay(reply, request, result);
    },
  );
}
