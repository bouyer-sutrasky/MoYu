import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  repositoryBranchListDataSchema,
  repositoryPreferencesDataSchema,
  repositoryPreferencesInputSchema,
  type RepositoryPreferences,
  type RepositoryPreferencesData,
} from '@moyu/contracts';
import {
  repositoryPreferences,
  type Database,
  type Repository,
  type RepositoryPreferencesRow,
} from '@moyu/db';
import { decodeModelId, encodeModelId } from '@moyu/runtime-client';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import { findOwnedRepository } from '../domain/repositories';
import {
  advertisesBranches,
  assertBranchAvailable,
  assertModelAvailable,
} from '../domain/runtime-selection';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';
import { createBridgeClient } from '../runtime/bridge';

export interface PreferenceRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
}

function toPreferences(row: RepositoryPreferencesRow): RepositoryPreferences {
  const identity = decodeModelId(row.modelId);
  return {
    executionMode: row.executionMode,
    baseBranch: row.baseBranch,
    model: identity
      ? {
          provider: identity.provider,
          model: identity.model,
          reasoningEffort: row.modelReasoningEffort,
        }
      : null,
  };
}

function toPreferencesData(
  repository: Repository,
  row: RepositoryPreferencesRow | null,
): RepositoryPreferencesData {
  const defaults: RepositoryPreferences = {
    executionMode: 'execute',
    baseBranch: repository.defaultBranch,
    model: null,
  };
  return {
    repositoryId: repository.id,
    preferences: row ? toPreferences(row) : null,
    effective: row
      ? { ...toPreferences(row), source: 'saved' }
      : { ...defaults, source: 'repository' },
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

async function loadPreferences(
  database: Database,
  ownerId: string,
  repositoryId: string,
): Promise<RepositoryPreferencesRow | null> {
  const [row] = await database
    .select()
    .from(repositoryPreferences)
    .where(
      and(
        eq(repositoryPreferences.ownerId, ownerId),
        eq(repositoryPreferences.repositoryId, repositoryId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The UI may submit an empty reasoning-effort select as `""`. Treat that as
 * "no explicit effort" before validating the strict input contract; a non-empty
 * value still has to be listed by the runtime.
 */
function normalizePreferencesBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  const model = record.model;
  if (typeof model !== 'object' || model === null || Array.isArray(model)) {
    return body;
  }
  const modelRecord = model as Record<string, unknown>;
  if (modelRecord.reasoningEffort !== '') {
    return body;
  }
  return { ...record, model: { ...modelRecord, reasoningEffort: null } };
}

async function ownedRepositoryOrThrow(
  database: Database,
  ownerId: string,
  repositoryId: string,
): Promise<Repository> {
  const repository = await findOwnedRepository(database, ownerId, repositoryId);
  if (!repository) {
    throw ApiProblem.notFound('Repository not found');
  }
  return repository;
}

export function registerPreferenceRoutes(
  app: FastifyInstance,
  dependencies: PreferenceRouteDependencies,
): void {
  const { config, database, authenticate } = dependencies;

  app.get(
    '/api/v1/repositories/:id/preferences',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const repository = await ownedRepositoryOrThrow(database, auth.owner.id, params.id ?? '');
      const row = await loadPreferences(database, auth.owner.id, repository.id);
      return sendData(
        reply,
        request,
        repositoryPreferencesDataSchema.parse(toPreferencesData(repository, row)),
      );
    },
  );

  app.put(
    '/api/v1/repositories/:id/preferences',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const repository = await ownedRepositoryOrThrow(database, auth.owner.id, params.id ?? '');
      const input = parseInput(
        repositoryPreferencesInputSchema,
        normalizePreferencesBody(request.body),
      );
      const reasoningEffort = input.model?.reasoningEffort ?? null;

      let bridge;
      try {
        bridge = createBridgeClient(config, repository);
      } catch (error) {
        request.log.warn(
          { err: error, event: 'bridge.preferences_unavailable' },
          'repository runtime is not configured',
        );
        throw ApiProblem.unavailable(
          'The repository runtime is not reachable; preferences were not saved',
        );
      }

      let catalog;
      let capabilities;
      try {
        [catalog, capabilities] = await Promise.all([bridge.models(), bridge.capabilities()]);
      } catch (error) {
        request.log.warn(
          { err: error, event: 'bridge.preferences_unavailable' },
          'repository runtime is not reachable',
        );
        throw ApiProblem.unavailable(
          'The repository runtime is not reachable; preferences were not saved',
        );
      }

      if (input.model) {
        assertModelAvailable(catalog, {
          provider: input.model.provider,
          model: input.model.model,
          reasoningEffort,
        });
      }

      if (advertisesBranches(capabilities)) {
        let branches;
        try {
          branches = await bridge.branches();
        } catch (error) {
          request.log.warn(
            { err: error, event: 'bridge.branch_list_unavailable' },
            'repository runtime could not list branches',
          );
          throw ApiProblem.unavailable(
            'The repository runtime could not list branches; preferences were not saved',
          );
        }
        assertBranchAvailable(branches, input.baseBranch);
      }

      const [row] = await database
        .insert(repositoryPreferences)
        .values({
          ownerId: auth.owner.id,
          repositoryId: repository.id,
          executionMode: input.executionMode,
          baseBranch: input.baseBranch,
          modelId: input.model ? encodeModelId(input.model) : null,
          modelReasoningEffort: reasoningEffort,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [repositoryPreferences.ownerId, repositoryPreferences.repositoryId],
          set: {
            executionMode: input.executionMode,
            baseBranch: input.baseBranch,
            modelId: input.model ? encodeModelId(input.model) : null,
            modelReasoningEffort: reasoningEffort,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) {
        throw new Error('repository preference upsert returned no row');
      }
      return sendData(
        reply,
        request,
        repositoryPreferencesDataSchema.parse(toPreferencesData(repository, row)),
      );
    },
  );

  app.delete(
    '/api/v1/repositories/:id/preferences',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const repository = await ownedRepositoryOrThrow(database, auth.owner.id, params.id ?? '');
      await database
        .delete(repositoryPreferences)
        .where(
          and(
            eq(repositoryPreferences.ownerId, auth.owner.id),
            eq(repositoryPreferences.repositoryId, repository.id),
          ),
        );
      return sendData(
        reply,
        request,
        repositoryPreferencesDataSchema.parse(toPreferencesData(repository, null)),
      );
    },
  );

  app.get(
    '/api/v1/repositories/:id/branches',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const repository = await ownedRepositoryOrThrow(database, auth.owner.id, params.id ?? '');

      let bridge;
      try {
        bridge = createBridgeClient(config, repository);
      } catch (error) {
        request.log.warn(
          { err: error, event: 'bridge.branches_unavailable' },
          'repository runtime is not configured',
        );
        throw ApiProblem.unavailable('The repository runtime is not reachable');
      }

      let capabilities;
      try {
        capabilities = await bridge.capabilities();
      } catch (error) {
        request.log.warn(
          { err: error, event: 'bridge.branches_unavailable' },
          'repository runtime is not reachable',
        );
        throw ApiProblem.unavailable('The repository runtime is not reachable');
      }

      if (!advertisesBranches(capabilities)) {
        return sendData(
          reply,
          request,
          repositoryBranchListDataSchema.parse({
            repositoryId: repository.id,
            status: 'unsupported',
            branches: [],
            hasMore: false,
            checkedAt: new Date().toISOString(),
          }),
        );
      }

      let result;
      try {
        result = await bridge.branches();
      } catch (error) {
        request.log.warn(
          { err: error, event: 'bridge.branch_list_failed' },
          'repository runtime could not list branches',
        );
        throw ApiProblem.unavailable('The repository runtime could not list branches');
      }

      const branches = [...result.branches]
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map((branch) => ({ name: branch.name, commit: branch.commit || null }));
      return sendData(
        reply,
        request,
        repositoryBranchListDataSchema.parse({
          repositoryId: repository.id,
          status: 'ready',
          branches,
          hasMore: result.hasMore ?? false,
          checkedAt: new Date().toISOString(),
        }),
      );
    },
  );
}
