import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { uuidSchema } from '@moyu/contracts';

import type { SupervisorConfig } from './config';
import { instanceIdentity, type SupervisorStore } from './store';
import type { SupervisorLogger } from './logger';
import { gitCachePath } from './git-cache';
import { buildInstancePrepareCommand, type InstanceManager } from './manager';
import { managedSettingsIssues } from './managed-settings';
import { createReviewService } from './review';
import { createCleanupService } from './cleanup';
import { applyDeploymentOps, readDeployment, withDeploymentLock } from './deployment-config';
import {
  PANEL_PROMPTS_PATH,
  PANEL_READ_PATHS,
  isSettingsBlock,
  panelCall,
  panelErrorText,
} from './panel-proxy';

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

  /**
   * Repository-level retry of the reusable Git copy. It only names a repository;
   * the supervisor owns the path, remote, credential identity and timeout.
   */
  app.post('/control/v1/instances/:repositoryId/git/prepare', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const instance = await manager.prepareGit(repositoryId);
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

  /**
   * Removes one repository's runtime and local resources. The caller names only
   * a repository id; every profile, path and credential comes from supervisor
   * state. The endpoint is idempotent and refuses while work still holds it.
   */
  app.post('/control/v1/instances/:repositoryId/remove', async (request) => {
    const repositoryId = repositoryIdOf(request);
    return { data: await manager.removeRepository(repositoryId) };
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

  /**
   * Loopback proxy for one instance's settings panel. The browser reaches this
   * only through the authenticated API; the port comes from the instance row and
   * every path is checked against an allow-list.
   */
  const panelInstanceFor = async (repositoryId: string) => {
    const row = await options.store.getInstance(repositoryId);
    if (!row) {
      throw Object.assign(new Error('Instance not found'), { statusCode: 404 });
    }
    if (row.state !== 'online' || !row.port) {
      throw Object.assign(
        new Error(
          `The runtime is not online (state=${row.state}); settings can only be read or written while it is running`,
        ),
        { statusCode: 409 },
      );
    }
    return { row, port: row.port, instanceId: instanceIdentity(row) };
  };

  /** Instance identity and the exact platform-managed values for a write. */
  const managedInvariantsFor = async (repositoryId: string) => {
    const instance = await panelInstanceFor(repositoryId);
    const repository = await options.store.getRepository(repositoryId);
    if (!repository) {
      throw Object.assign(new Error('Repository not found'), { statusCode: 404 });
    }
    const profile = instance.row.profile;
    if (!profile) {
      throw Object.assign(new Error('Instance profile is not prepared yet'), { statusCode: 409 });
    }
    return {
      instance,
      invariants: {
        repository: instance.row.fullName,
        ownerId: repository.ownerId,
        githubAllowedUsers: config.githubAllowedUsers,
        githubCli: config.githubCli,
        worktreeDir: join(config.worktreeRoot, profile),
        prepare: buildInstancePrepareCommand({
          fullName: instance.row.fullName,
          githubAccount: config.githubAccount,
          githubCommitEmail: config.githubCommitEmail,
          cacheDir: gitCachePath(config.worktreeRoot, profile),
        }),
      },
    };
  };

  app.get('/control/v1/instances/:repositoryId/panel/:page', async (request, reply) => {
    const repositoryId = repositoryIdOf(request);
    const page = (request.params as { page?: string }).page ?? '';
    const path = page === 'policy-history' ? '/policy/history' : `/${page}`;
    if (!PANEL_READ_PATHS.has(path)) {
      return reply.code(422).send({
        error: { code: 'invalid_request', message: `Unsupported panel page: ${page}` },
      });
    }
    const query = z
      .object({
        revision:
          page === 'prompts'
            ? z.coerce.number().int().nonnegative().optional()
            : z.never().optional(),
        offset:
          page === 'prompts'
            ? z.coerce.number().int().nonnegative().optional()
            : z.never().optional(),
      })
      .strict()
      .safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(422).send({
        error: {
          code: 'invalid_request',
          message: 'This panel page accepts no query parameters',
        },
      });
    }
    const queryString = new URLSearchParams(
      Object.entries(query.data)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)] as [string, string]),
    ).toString();
    const targetPath = queryString ? `${path}?${queryString}` : path;
    const instance = await panelInstanceFor(repositoryId);
    const result = await panelCall({ port: instance.port, path: targetPath });
    if (result.status >= 400) {
      logger.info(
        {
          event: 'supervisor.panel_read_failed',
          repositoryId,
          page,
          detail: panelErrorText(result),
        },
        'runtime panel read failed',
      );
    }
    // The browser must bind drafts and writes to the exact prepared instance.
    // The runtime's masterId is useful context, but the supervisor's prepared
    // row identity also changes when a repository is re-provisioned.
    const body =
      result.status < 300 &&
      (page === 'state' || page === 'prompts') &&
      result.body &&
      typeof result.body === 'object' &&
      !Array.isArray(result.body)
        ? { ...(result.body as Record<string, unknown>), moyuInstanceId: instance.instanceId }
        : result.body;
    return reply.code(result.status).send(body);
  });

  app.put('/control/v1/instances/:repositoryId/panel/settings/:block', async (request, reply) => {
    const repositoryId = repositoryIdOf(request);
    const raw = (request.params as { block?: string }).block ?? '';
    let block: string;
    try {
      block = decodeURIComponent(raw);
    } catch {
      return reply
        .code(422)
        .send({ error: { code: 'invalid_request', message: 'Malformed settings block' } });
    }
    if (!isSettingsBlock(block)) {
      return reply.code(422).send({
        error: { code: 'invalid_request', message: `Unsupported settings block: ${block}` },
      });
    }
    const body = z
      .object({
        value: z.record(z.string(), z.unknown()),
        revision: z.number().int().nonnegative(),
        expectedInstanceId: z.string().min(1),
      })
      .strict()
      .safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(422).send({
        error: {
          code: 'invalid_request',
          message: 'A settings save needs { value, revision, expectedInstanceId }',
        },
      });
    }
    const { instance, invariants } = await managedInvariantsFor(repositoryId);
    if (body.data.expectedInstanceId !== instance.instanceId) {
      return reply.code(409).send({
        error: {
          code: 'instance_changed',
          message:
            'The runtime instance changed since this draft was loaded; reload its settings before saving',
        },
        instanceId: instance.instanceId,
      });
    }
    const issues = managedSettingsIssues(block, body.data.value, invariants);
    if (issues.length > 0) {
      return reply.code(422).send({
        error: {
          code: 'managed_field',
          message: 'The request tries to change platform-managed settings',
        },
        issues,
      });
    }
    const result = await panelCall({
      port: instance.port,
      path: `/settings/${encodeURIComponent(block)}`,
      method: 'PUT',
      body: { value: body.data.value, revision: body.data.revision },
    });
    logger.info(
      {
        event: 'supervisor.panel_settings_saved',
        repositoryId,
        block,
        status: result.status,
        ...(result.status >= 400 ? { detail: panelErrorText(result) } : {}),
      },
      'runtime settings save relayed',
    );
    return reply.code(result.status).send(result.body);
  });

  app.put('/control/v1/instances/:repositoryId/panel/prompts', async (request, reply) => {
    const repositoryId = repositoryIdOf(request);
    const body = z
      .object({
        config: z.unknown(),
        baseRevision: z.number().int().nonnegative(),
        expectedInstanceId: z.string().min(1),
      })
      .strict()
      .safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(422).send({
        error: {
          code: 'invalid_request',
          message: 'A prompt save needs { config, baseRevision, expectedInstanceId }',
        },
      });
    }
    const instance = await panelInstanceFor(repositoryId);
    if (body.data.expectedInstanceId !== instance.instanceId) {
      return reply.code(409).send({
        error: {
          code: 'instance_changed',
          message:
            'The runtime instance changed since these prompts were loaded; reload before saving',
        },
        instanceId: instance.instanceId,
      });
    }
    const result = await panelCall({
      port: instance.port,
      path: PANEL_PROMPTS_PATH,
      method: 'PUT',
      body: { config: body.data.config, baseRevision: body.data.baseRevision },
    });
    return reply.code(result.status).send(result.body);
  });

  const sourceIdSchema = z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9-]*$/, 'source id must be lowercase');
  const ticketIdSchema = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/, 'invalid ticket id');

  const requireInstalledSource = async (repositoryId: string, sourceId: string) => {
    const instance = await panelInstanceFor(repositoryId);
    const settings = await panelCall({ port: instance.port, path: '/settings' });
    if (settings.status >= 400) {
      throw Object.assign(new Error('The runtime settings could not be read'), {
        statusCode: settings.status,
      });
    }
    const body = settings.body as { sources?: Array<{ id?: unknown }> } | null;
    const installed = Array.isArray(body?.sources)
      ? body.sources.some((source) => source.id === sourceId)
      : false;
    if (!installed) {
      throw Object.assign(new Error(`Source ${sourceId} is not installed on this instance`), {
        statusCode: 422,
        issues: [{ path: 'id', message: `Source ${sourceId} is not installed` }],
      });
    }
    return instance;
  };

  app.post(
    '/control/v1/instances/:repositoryId/panel-action/prompts/preview',
    async (request, reply) => {
      const repositoryId = repositoryIdOf(request);
      const body = z
        .object({ config: z.unknown() })
        .strict()
        .safeParse(request.body ?? {});
      if (!body.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_request', message: 'config is required' } });
      }
      const instance = await panelInstanceFor(repositoryId);
      const result = await panelCall({
        port: instance.port,
        path: '/prompts/preview',
        method: 'POST',
        body: body.data.config,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    '/control/v1/instances/:repositoryId/panel-action/sources/:sourceId/labels',
    async (request, reply) => {
      const repositoryId = repositoryIdOf(request);
      const params = z.object({ sourceId: sourceIdSchema }).safeParse(request.params);
      if (!params.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_request', message: 'Invalid source id' } });
      }
      const instance = await requireInstalledSource(repositoryId, params.data.sourceId);
      const result = await panelCall({
        port: instance.port,
        path: `/sources/${encodeURIComponent(params.data.sourceId)}/labels`,
        method: 'POST',
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    '/control/v1/instances/:repositoryId/panel-action/policy-sync/:sourceId',
    async (request, reply) => {
      const repositoryId = repositoryIdOf(request);
      const params = z.object({ sourceId: sourceIdSchema }).safeParse(request.params);
      if (!params.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_request', message: 'Invalid source id' } });
      }
      const instance = await requireInstalledSource(repositoryId, params.data.sourceId);
      const result = await panelCall({
        port: instance.port,
        path: `/policy-sync/${encodeURIComponent(params.data.sourceId)}`,
        method: 'POST',
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    '/control/v1/instances/:repositoryId/panel-action/executor/pause',
    async (request, reply) => {
      const repositoryId = repositoryIdOf(request);
      const body = z
        .object({ paused: z.boolean() })
        .strict()
        .safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(422).send({
          error: { code: 'invalid_request', message: 'paused must be a boolean' },
        });
      }
      const instance = await panelInstanceFor(repositoryId);
      const result = await panelCall({
        port: instance.port,
        path: '/executor/pause',
        method: 'POST',
        body: { paused: body.data.paused },
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    '/control/v1/instances/:repositoryId/panel-action/setup/check',
    async (request, reply) => {
      const repositoryId = repositoryIdOf(request);
      const instance = await panelInstanceFor(repositoryId);
      const result = await panelCall({
        port: instance.port,
        path: '/setup/check',
        method: 'POST',
        body: {},
        timeoutMs: 60_000,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  const panelQuery = async (
    repositoryId: string,
    path: string,
    input: Record<string, string | number | undefined>,
  ) => {
    const instance = await panelInstanceFor(repositoryId);
    const search = new URLSearchParams(
      Object.entries(input)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => [key, String(value)] as [string, string]),
    ).toString();
    return panelCall({ port: instance.port, path: `${path}${search ? `?${search}` : ''}` });
  };

  app.get('/control/v1/instances/:repositoryId/panel-action/tickets', async (request, reply) => {
    const repositoryId = repositoryIdOf(request);
    const query = z
      .object({
        state: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .safeParse(request.query ?? {});
    if (!query.success) {
      return reply
        .code(422)
        .send({ error: { code: 'invalid_request', message: 'Invalid ticket query' } });
    }
    const result = await panelQuery(repositoryId, '/tickets', query.data);
    return reply.code(result.status).send(result.body);
  });

  app.get(
    '/control/v1/instances/:repositoryId/panel-action/tickets/:ticketId',
    async (request, reply) => {
      const repositoryId = repositoryIdOf(request);
      const params = z.object({ ticketId: ticketIdSchema }).safeParse(request.params);
      if (!params.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_request', message: 'Invalid ticket id' } });
      }
      const result = await panelQuery(
        repositoryId,
        `/tickets/${encodeURIComponent(params.data.ticketId)}`,
        {},
      );
      return reply.code(result.status).send(result.body);
    },
  );

  for (const action of ['retry', 'stop'] as const) {
    app.post(
      `/control/v1/instances/:repositoryId/panel-action/tickets/:ticketId/${action}`,
      async (request, reply) => {
        const repositoryId = repositoryIdOf(request);
        const params = z.object({ ticketId: ticketIdSchema }).safeParse(request.params);
        if (!params.success) {
          return reply
            .code(422)
            .send({ error: { code: 'invalid_request', message: 'Invalid ticket id' } });
        }
        const instance = await panelInstanceFor(repositoryId);
        const result = await panelCall({
          port: instance.port,
          path: `/tickets/${encodeURIComponent(params.data.ticketId)}/${action}`,
          method: 'POST',
          body: {},
          timeoutMs: 60_000,
        });
        return reply.code(result.status).send(result.body);
      },
    );
  }

  app.get('/control/v1/instances/:repositoryId/panel-action/decisions', async (request, reply) => {
    const repositoryId = repositoryIdOf(request);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        kind: z.string().max(200).optional(),
        window: z.string().max(20).optional(),
      })
      .strict()
      .safeParse(request.query ?? {});
    if (!query.success) {
      return reply
        .code(422)
        .send({ error: { code: 'invalid_request', message: 'Invalid decisions query' } });
    }
    const result = await panelQuery(repositoryId, '/decisions', query.data);
    return reply.code(result.status).send(result.body);
  });

  /** Reads the instance's Deployment snapshot from its own profile patch. */
  const profilePatchFor = async (
    repositoryId: string,
  ): Promise<{ profile: string; path: string; instanceId: string }> => {
    const row = await options.store.getInstance(repositoryId);
    if (!row?.profile) {
      throw Object.assign(new Error('Instance profile is not prepared yet'), { statusCode: 404 });
    }
    return {
      profile: row.profile,
      path: join(config.dshHome, 'profiles', row.profile, 'cordis.patch.yml'),
      instanceId: instanceIdentity(row),
    };
  };

  app.get('/control/v1/instances/:repositoryId/deployment', async (request) => {
    const repositoryId = repositoryIdOf(request);
    const target = await profilePatchFor(repositoryId);
    const text = readFileSync(target.path, 'utf8');
    return {
      data: { ...readDeployment(text), profile: target.profile, instanceId: target.instanceId },
    };
  });

  app.put('/control/v1/instances/:repositoryId/deployment', async (request, reply) => {
    const repositoryId = repositoryIdOf(request);
    const body = z
      .object({
        ops: z
          .array(
            z.union([
              z
                .object({
                  op: z.literal('set'),
                  path: z.array(z.string()).min(1),
                  value: z.unknown(),
                })
                .strict(),
              z.object({ op: z.literal('unset'), path: z.array(z.string()).min(1) }).strict(),
            ]),
          )
          .min(1)
          .max(8),
        revision: z.number().int().nonnegative(),
        expectedInstanceId: z.string().min(1),
      })
      .strict()
      .parse(request.body ?? {});
    return withDeploymentLock(repositoryId, async () => {
      const target = await profilePatchFor(repositoryId);
      if (body.expectedInstanceId !== target.instanceId) {
        return reply.code(409).send({
          error: {
            code: 'instance_changed',
            message:
              'The runtime instance changed since this Deployment snapshot was loaded; reload before saving',
          },
          instanceId: target.instanceId,
        });
      }
      const before = readFileSync(target.path, 'utf8');
      const snapshot = readDeployment(before);
      if (snapshot.revision !== body.revision) {
        return reply.code(409).send({
          error: {
            code: 'settings_conflict',
            message: 'The Deployment settings changed. Reload before saving.',
          },
          revision: snapshot.revision,
        });
      }
      let applied;
      try {
        applied = applyDeploymentOps(before, body.ops as never);
      } catch (error) {
        return reply.code(422).send({
          error: {
            code: 'invalid_deployment',
            message: error instanceof Error ? error.message : 'Invalid Deployment change',
          },
          revision: snapshot.revision,
        });
      }

      // Write a unique sibling with mode 0600, fsync it, then rename. Two
      // clients with the same revision are serialized by withDeploymentLock;
      // a crash before rename leaves only an fenced temp file, never a
      // truncated profile.
      const temporary = `${target.path}.tmp-${process.pid}-${randomUUID()}`;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, applied.text, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, target.path);
        // Make the rename durable too. Directory fsync is best-effort on filesystems
        // that do not support it; the file itself is already closed and fsynced.
        try {
          const directory = openSync(dirname(target.path), 'r');
          try {
            fsyncSync(directory);
          } finally {
            closeSync(directory);
          }
        } catch {
          // The rename is still atomic; report the save rather than inventing a failure.
        }
      } catch (error) {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {
            // Already closed.
          }
        }
        try {
          unlinkSync(temporary);
        } catch {
          // The temp file may not exist or may already have been renamed.
        }
        throw error;
      }

      const savedSnapshot = readDeployment(readFileSync(target.path, 'utf8'));
      // The file is already durable. A restart failure must not turn a
      // committed save into a 500 that invites the browser to resend the PUT.
      let restart: { restarted: boolean; reason?: string };
      try {
        restart = await manager.restart(repositoryId);
      } catch (error) {
        restart = {
          restarted: false,
          reason: `The Deployment settings were saved, but the restart request failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      logger.info(
        {
          event: 'supervisor.deployment_saved',
          repositoryId,
          profile: target.profile,
          applied: applied.applied,
          revision: savedSnapshot.revision,
          restarting: restart.restarted,
          restartRequired: !restart.restarted,
        },
        'instance Deployment settings saved',
      );
      return {
        data: {
          saved: true,
          revision: savedSnapshot.revision,
          snapshot: { ...savedSnapshot, instanceId: target.instanceId },
          profile: target.profile,
          applied: applied.applied,
          restarting: restart.restarted,
          restartRequired: !restart.restarted,
          restartRefused: restart.restarted ? null : (restart.reason ?? null),
        },
      };
    });
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
    const issues = (error as { issues?: unknown }).issues;
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
      ...(Array.isArray(issues) ? { issues } : {}),
    });
  });

  return app;
}
