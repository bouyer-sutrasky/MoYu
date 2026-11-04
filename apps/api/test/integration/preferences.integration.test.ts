import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conversationDetailDataSchema,
  repositoryBranchListDataSchema,
  repositoryPreferencesDataSchema,
  type RepositoryBranchListData,
  type RepositoryPreferencesData,
} from '@moyu/contracts';
import {
  conversations,
  owners,
  repositories,
  repositoryPreferences,
  sessions,
  taskLinks,
  type Database,
} from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './helpers';

const BRIDGE_TOKEN = 'm4-preferences-token-0123456789';
process.env.TEST_BRIDGE_TOKEN = BRIDGE_TOKEN;
const MODEL = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' };
const PLAIN_MODEL = { provider: 'commandcode', model: 'plain-model' };

interface FakeBranch {
  name: string;
  commit?: string | null;
}

interface FakeBridgeState {
  branches: FakeBranch[];
  branchesCapability: boolean;
  failBranches: boolean;
  models: Array<{
    provider: string;
    model: string;
    displayName?: string;
    reasoningEfforts?: string[];
  }>;
  authorizations: string[];
}

interface FakeBridge {
  url: string;
  state: FakeBridgeState;
  close: () => Promise<void>;
}

function jsonResponse(status: number, body: unknown): { status: number; body: string } {
  return { status, body: JSON.stringify(body) };
}

async function startFakeBridge(options?: { branchesCapability?: boolean }): Promise<FakeBridge> {
  const state: FakeBridgeState = {
    branches: [
      { name: 'main', commit: 'a'.repeat(40) },
      { name: 'release', commit: '' },
      { name: 'feature/x', commit: 'b'.repeat(40) },
    ],
    branchesCapability: options?.branchesCapability ?? true,
    failBranches: false,
    models: [
      { ...MODEL, displayName: 'DeepSeek', reasoningEfforts: ['low', 'high'] },
      { ...PLAIN_MODEL, displayName: 'Plain' },
    ],
    authorizations: [],
  };

  const server: Server = createServer((request, response) => {
    state.authorizations.push(String(request.headers.authorization ?? ''));
    if (request.headers.authorization !== `Bearer ${BRIDGE_TOKEN}`) {
      const unauthorized = jsonResponse(401, {
        error: { code: 'unauthorized', message: 'bad machine token', retryable: false },
      });
      response.writeHead(unauthorized.status, { 'content-type': 'application/json' });
      response.end(unauthorized.body);
      return;
    }

    const url = new URL(request.url ?? '/', 'http://bridge.test');
    const method = request.method ?? 'GET';
    let payload: { status: number; body: string } | null = null;
    if (method === 'GET' && url.pathname === '/bridge/v1/capabilities') {
      payload = jsonResponse(200, {
        protocolVersion: '1.0',
        upstream: { package: 'fake-bridge', version: '1.0.0', commit: null },
        capabilities: {
          trigger: true,
          events: true,
          tickets: true,
          models: true,
          pause: true,
          resume: true,
          retry: true,
          readOnlyDiscussion: true,
          ...(state.branchesCapability ? { branches: true } : {}),
        },
        source: { kind: 'test', enabled: true },
      });
    } else if (method === 'GET' && url.pathname === '/bridge/v1/models') {
      payload = jsonResponse(200, { models: state.models });
    } else if (method === 'GET' && url.pathname === '/bridge/v1/branches') {
      payload = state.failBranches
        ? jsonResponse(500, {
            error: { code: 'branch_list_failed', message: 'git failed', retryable: true },
          })
        : jsonResponse(200, { branches: state.branches, hasMore: false });
    } else {
      payload = jsonResponse(404, {
        error: { code: 'not_found', message: 'unknown bridge route', retryable: false },
      });
    }

    response.writeHead(payload.status, { 'content-type': 'application/json' });
    response.end(payload.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function unusedBridgeUrl(): Promise<string> {
  const bridge = await startFakeBridge();
  const url = bridge.url;
  await bridge.close();
  return url;
}

interface Harness {
  app: FastifyInstance;
  database: Database;
  cookie: string;
  ownerId: string;
  fullBridge: FakeBridge;
  noBranchesBridge: FakeBridge;
  repositoryAId: string;
  repositoryBId: string;
  repositoryCId: string;
  repositoryNoBranchesId: string;
  repositoryUnreachableId: string;
  repositoryWithoutBridgeId: string;
}

function envelope(payload: unknown): unknown {
  return (payload as { data?: unknown }).data;
}

function errorBody(payload: unknown): { code: string; message: string } {
  return (payload as { error: { code: string; message: string } }).error;
}

describe('repository preferences and branch availability on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    const database = testDatabase.db;
    const [owner] = await database
      .insert(owners)
      .values({ displayName: 'Preferences Owner' })
      .returning();
    if (!owner) throw new Error('owner insert returned no row');

    const fullBridge = await startFakeBridge();
    const noBranchesBridge = await startFakeBridge({ branchesCapability: false });
    const unreachableUrl = await unusedBridgeUrl();

    const insertRepository = async (
      fullName: string,
      bridgeUrl: string | null,
      defaultBranch = 'main',
    ) => {
      const [repository] = await database
        .insert(repositories)
        .values({
          ownerId: owner.id,
          fullName,
          defaultBranch,
          bridgeUrl,
          bridgeCredentialRef: bridgeUrl ? 'TEST_BRIDGE_TOKEN' : null,
          status: bridgeUrl ? 'active' : 'provisioning',
        })
        .returning();
      if (!repository) throw new Error('repository insert returned no row');
      return repository;
    };

    const repositoryA = await insertRepository('Bouyer12/preferences-a', fullBridge.url);
    const repositoryB = await insertRepository('Bouyer12/preferences-b', fullBridge.url);
    const repositoryC = await insertRepository('Bouyer12/preferences-c', fullBridge.url);
    const repositoryNoBranches = await insertRepository(
      'Bouyer12/preferences-no-branches',
      noBranchesBridge.url,
    );
    const repositoryUnreachable = await insertRepository(
      'Bouyer12/preferences-unreachable',
      unreachableUrl,
    );
    const repositoryWithoutBridge = await insertRepository('Bouyer12/preferences-no-bridge', null);

    const token = randomToken(32);
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabase.url,
      WEBAUTHN_ORIGIN: 'http://127.0.0.1:3230',
      WEBAUTHN_RP_ID: '127.0.0.1',
      BRIDGE_TOKEN,
    });
    await database.insert(sessions).values({
      ownerId: owner.id,
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const app = buildApp({ config, database });
    await app.ready();
    harness = {
      app,
      database,
      cookie: `${sessionCookieName(config)}=${token}`,
      ownerId: owner.id,
      fullBridge,
      noBranchesBridge,
      repositoryAId: repositoryA.id,
      repositoryBId: repositoryB.id,
      repositoryCId: repositoryC.id,
      repositoryNoBranchesId: repositoryNoBranches.id,
      repositoryUnreachableId: repositoryUnreachable.id,
      repositoryWithoutBridgeId: repositoryWithoutBridge.id,
    };
  }, 60_000);

  afterAll(async () => {
    await harness?.app.close();
    await harness?.fullBridge.close();
    await harness?.noBranchesBridge.close();
    await testDatabase?.drop();
  });

  async function getPreferences(repositoryId: string) {
    return await harness.app.inject({
      method: 'GET',
      url: `/api/v1/repositories/${repositoryId}/preferences`,
      headers: { cookie: harness.cookie },
    });
  }

  async function putPreferences(repositoryId: string, payload: Record<string, unknown>) {
    return await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/repositories/${repositoryId}/preferences`,
      headers: { cookie: harness.cookie },
      payload,
    });
  }

  async function deletePreferences(repositoryId: string) {
    return await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/repositories/${repositoryId}/preferences`,
      headers: { cookie: harness.cookie },
    });
  }

  async function getBranches(repositoryId: string) {
    return await harness.app.inject({
      method: 'GET',
      url: `/api/v1/repositories/${repositoryId}/branches`,
      headers: { cookie: harness.cookie },
    });
  }

  async function createConversation(repositoryId: string, payload: Record<string, unknown>) {
    return await harness.app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { cookie: harness.cookie },
      payload: {
        repositoryId,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
        clientRequestId: `pref-${randomUUID()}`,
        ...payload,
      },
    });
  }

  async function preferenceRowCount(repositoryId: string): Promise<number> {
    const rows = await harness.database
      .select({ id: repositoryPreferences.id })
      .from(repositoryPreferences)
      .where(
        and(
          eq(repositoryPreferences.ownerId, harness.ownerId),
          eq(repositoryPreferences.repositoryId, repositoryId),
        ),
      );
    return rows.length;
  }

  function parsePreferences(response: { json: () => unknown }): RepositoryPreferencesData {
    return repositoryPreferencesDataSchema.parse(envelope(response.json()));
  }

  it('reports repository defaults and null saved preferences', async () => {
    const response = await getPreferences(harness.repositoryAId);
    expect(response.statusCode).toBe(200);
    expect(parsePreferences(response)).toEqual({
      repositoryId: harness.repositoryAId,
      preferences: null,
      effective: {
        executionMode: 'execute',
        baseBranch: 'main',
        model: null,
        source: 'repository',
      },
      updatedAt: null,
    });
  });

  it('saves, reloads and scopes a preference without changing a frozen conversation', async () => {
    const created = await createConversation(harness.repositoryAId, {
      baseBranch: 'main',
      model: { ...PLAIN_MODEL },
    });
    expect(created.statusCode).toBe(201);
    const conversation = conversationDetailDataSchema.parse(envelope(created.json())).conversation;
    expect(conversation.baseBranch).toBe('main');
    expect(conversation.model).toEqual({ ...PLAIN_MODEL, reasoningEffort: null });

    const payload = {
      executionMode: 'discuss' as const,
      baseBranch: 'release',
      model: {
        provider: MODEL.provider,
        model: MODEL.model,
        reasoningEffort: 'high',
      },
    };
    const saved = await putPreferences(harness.repositoryAId, payload);
    expect(saved.statusCode).toBe(200);
    const savedData = parsePreferences(saved);
    expect(savedData.preferences).toEqual(payload);
    expect(savedData.effective).toEqual({ ...payload, source: 'saved' });
    expect(savedData.updatedAt).toBeTruthy();

    const reloaded = await getPreferences(harness.repositoryAId);
    expect(reloaded.statusCode).toBe(200);
    expect(parsePreferences(reloaded)).toEqual(savedData);

    const row = await harness.database
      .select()
      .from(repositoryPreferences)
      .where(eq(repositoryPreferences.repositoryId, harness.repositoryAId))
      .limit(1);
    expect(row[0]?.modelId).toBe(`${MODEL.provider}/${MODEL.model}`);
    expect(row[0]?.modelReasoningEffort).toBe('high');

    // Preferences are defaults only: the conversation and task created above
    // keep the branch, model and execution mode frozen at creation time.
    const [storedConversation] = await harness.database
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id))
      .limit(1);
    const [storedTask] = await harness.database
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.conversationId, conversation.id))
      .limit(1);
    expect(storedConversation).toMatchObject({
      baseBranch: 'main',
      modelId: `${PLAIN_MODEL.provider}/${PLAIN_MODEL.model}`,
      modelReasoningEffort: null,
      executionMode: 'execute',
    });
    expect(storedTask).toMatchObject({
      baseBranch: 'main',
      modelId: `${PLAIN_MODEL.provider}/${PLAIN_MODEL.model}`,
      modelReasoningEffort: null,
      executionMode: 'execute',
    });
  });

  it('keeps preferences isolated per repository', async () => {
    const before = await getPreferences(harness.repositoryBId);
    expect(parsePreferences(before).preferences).toBeNull();

    const savedB = await putPreferences(harness.repositoryBId, {
      executionMode: 'execute',
      baseBranch: 'main',
      model: null,
    });
    expect(savedB.statusCode).toBe(200);
    expect(parsePreferences(savedB).preferences).toEqual({
      executionMode: 'execute',
      baseBranch: 'main',
      model: null,
    });

    const stillA = parsePreferences(await getPreferences(harness.repositoryAId));
    expect(stillA.preferences?.baseBranch).toBe('release');
    expect(await preferenceRowCount(harness.repositoryAId)).toBe(1);
    expect(await preferenceRowCount(harness.repositoryBId)).toBe(1);
  });

  it('lists branches sorted by name and reports the runtime commit or null', async () => {
    const response = await getBranches(harness.repositoryAId);
    expect(response.statusCode).toBe(200);
    const data: RepositoryBranchListData = repositoryBranchListDataSchema.parse(
      envelope(response.json()),
    );
    expect(data.status).toBe('ready');
    expect(data.repositoryId).toBe(harness.repositoryAId);
    expect(data.hasMore).toBe(false);
    expect(data.branches).toEqual([
      { name: 'feature/x', commit: 'b'.repeat(40) },
      { name: 'main', commit: 'a'.repeat(40) },
      { name: 'release', commit: null },
    ]);
    expect(Number.isNaN(Date.parse(data.checkedAt))).toBe(false);
    expect(harness.fullBridge.state.authorizations).toContain(`Bearer ${BRIDGE_TOKEN}`);
  });

  it('validates creation against the runtime but keeps working when it is unreachable', async () => {
    const missingBranch = await createConversation(harness.repositoryAId, {
      baseBranch: 'no-such-branch',
      model: { ...PLAIN_MODEL },
    });
    expect(missingBranch.statusCode).toBe(422);
    expect(errorBody(missingBranch.json()).message).toContain(
      'The base branch no longer exists: no-such-branch',
    );

    const missingModel = await createConversation(harness.repositoryAId, {
      baseBranch: 'main',
      model: { provider: 'commandcode', model: 'not-in-catalog' },
    });
    expect(missingModel.statusCode).toBe(422);
    expect(errorBody(missingModel.json()).message).toContain('commandcode/not-in-catalog');

    const unreachable = await createConversation(harness.repositoryUnreachableId, {
      baseBranch: 'any-branch',
      model: { provider: 'commandcode', model: 'not-in-catalog' },
    });
    expect(unreachable.statusCode).toBe(201);

    const noBridge = await createConversation(harness.repositoryWithoutBridgeId, {
      baseBranch: 'any-branch',
      model: { provider: 'commandcode', model: 'not-in-catalog' },
    });
    expect(noBridge.statusCode).toBe(201);
  });

  it('rejects a deleted branch with 422 and writes no preference row', async () => {
    const saved = harness.fullBridge.state.branches;
    harness.fullBridge.state.branches = saved.filter((branch) => branch.name !== 'release');
    try {
      expect(await preferenceRowCount(harness.repositoryCId)).toBe(0);
      const response = await putPreferences(harness.repositoryCId, {
        executionMode: 'execute',
        baseBranch: 'release',
        model: null,
      });
      expect(response.statusCode).toBe(422);
      expect(errorBody(response.json()).message).toContain(
        'The base branch no longer exists: release',
      );
      expect(await preferenceRowCount(harness.repositoryCId)).toBe(0);
    } finally {
      harness.fullBridge.state.branches = saved;
    }
  });

  it('rejects unknown models and unavailable reasoning efforts with 422', async () => {
    const unknown = await putPreferences(harness.repositoryCId, {
      executionMode: 'execute',
      baseBranch: 'main',
      model: { provider: 'commandcode', model: 'not-in-catalog' },
    });
    expect(unknown.statusCode).toBe(422);
    expect(errorBody(unknown.json()).message).toContain('commandcode/not-in-catalog');

    const unsupportedEffort = await putPreferences(harness.repositoryCId, {
      executionMode: 'execute',
      baseBranch: 'main',
      model: { ...PLAIN_MODEL, reasoningEffort: 'high' },
    });
    expect(unsupportedEffort.statusCode).toBe(422);
    expect(errorBody(unsupportedEffort.json()).message).toContain('reasoning effort');
    expect(await preferenceRowCount(harness.repositoryCId)).toBe(0);

    const normalized = await putPreferences(harness.repositoryCId, {
      executionMode: 'execute',
      baseBranch: 'main',
      model: { ...MODEL, reasoningEffort: '' },
    });
    expect(normalized.statusCode).toBe(200);
    expect(parsePreferences(normalized).preferences?.model).toEqual({
      ...MODEL,
      reasoningEffort: null,
    });
  });

  it('accepts a preference when the runtime cannot list branches', async () => {
    const response = await putPreferences(harness.repositoryNoBranchesId, {
      executionMode: 'discuss',
      baseBranch: 'branch-not-verifiable',
      model: { ...PLAIN_MODEL },
    });
    expect(response.statusCode).toBe(200);
    expect(parsePreferences(response).preferences).toEqual({
      executionMode: 'discuss',
      baseBranch: 'branch-not-verifiable',
      model: { ...PLAIN_MODEL, reasoningEffort: null },
    });
    expect(await preferenceRowCount(harness.repositoryNoBranchesId)).toBe(1);

    const branches = await getBranches(harness.repositoryNoBranchesId);
    expect(branches.statusCode).toBe(200);
    expect(repositoryBranchListDataSchema.parse(envelope(branches.json()))).toMatchObject({
      repositoryId: harness.repositoryNoBranchesId,
      status: 'unsupported',
      branches: [],
      hasMore: false,
    });
  });

  it('returns 503 and saves nothing when the runtime is unreachable or branch listing fails', async () => {
    const unreachable = await putPreferences(harness.repositoryUnreachableId, {
      executionMode: 'execute',
      baseBranch: 'main',
      model: null,
    });
    expect(unreachable.statusCode).toBe(503);
    expect(errorBody(unreachable.json()).code).toBe('dependency_unavailable');
    expect(await preferenceRowCount(harness.repositoryUnreachableId)).toBe(0);

    const unreachableBranches = await getBranches(harness.repositoryUnreachableId);
    expect(unreachableBranches.statusCode).toBe(503);

    harness.fullBridge.state.failBranches = true;
    try {
      const listFailed = await getBranches(harness.repositoryAId);
      expect(listFailed.statusCode).toBe(503);

      const saveFailed = await putPreferences(harness.repositoryAId, {
        executionMode: 'execute',
        baseBranch: 'main',
        model: null,
      });
      expect(saveFailed.statusCode).toBe(503);
    } finally {
      harness.fullBridge.state.failBranches = false;
    }

    const stillSaved = parsePreferences(await getPreferences(harness.repositoryAId));
    expect(stillSaved.preferences).toEqual({
      executionMode: 'discuss',
      baseBranch: 'release',
      model: { ...MODEL, reasoningEffort: 'high' },
    });
  });

  it('deletes the preference row and returns repository defaults', async () => {
    const response = await deletePreferences(harness.repositoryBId);
    expect(response.statusCode).toBe(200);
    expect(parsePreferences(response)).toEqual({
      repositoryId: harness.repositoryBId,
      preferences: null,
      effective: {
        executionMode: 'execute',
        baseBranch: 'main',
        model: null,
        source: 'repository',
      },
      updatedAt: null,
    });
    expect(await preferenceRowCount(harness.repositoryBId)).toBe(0);

    const reloaded = await getPreferences(harness.repositoryBId);
    expect(parsePreferences(reloaded).preferences).toBeNull();
  });

  it('returns 404 for repositories owned by someone else', async () => {
    expect((await getPreferences(randomUUID())).statusCode).toBe(404);
    expect((await getBranches(randomUUID())).statusCode).toBe(404);
    const response = await putPreferences(randomUUID(), {
      executionMode: 'execute',
      baseBranch: 'main',
      model: null,
    });
    expect(response.statusCode).toBe(404);
  });
});
