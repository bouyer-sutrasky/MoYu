import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conversations,
  owners,
  repositories,
  repositoryAuditEvents,
  repositoryInstances,
  sessions,
  taskLinks,
  type Database,
} from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './helpers';

interface Harness {
  app: FastifyInstance;
  database: Database;
  cookie: string;
  cookieName: string;
  ownerId: string;
  repositoryAId: string;
  repositoryBId: string;
  supervisor: Server;
  supervisorUrl: string;
  supervisorCalls: string[];
  tempDir: string;
}

const SUPERVISOR_TOKEN = 'm5-test-supervisor-token-0123456789';
const CALLBACK_A = 'callback-token-a-0123456789abcdef';
const CALLBACK_B = 'callback-token-b-0123456789abcdef';
let failNextRemove = false;
let removeDelayMs = 0;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function instance(
  repositoryId: string,
  state: string,
  reasonCode: string,
  gitState: 'none' | 'preparing' | 'ready' | 'failed' = 'ready',
) {
  return {
    repositoryId,
    fullName: 'Bouyer12/unknown',
    defaultBranch: 'main',
    state,
    desiredState: state === 'sleeping' ? 'sleeping' : 'online',
    reasonCode,
    reasonDetail: null,
    waitingFor: null,
    queuePriority: 20,
    wakeRequestedAt: null,
    activationRequestedAt: state === 'online' ? new Date('2026-11-04T09:58:00.000Z') : null,
    lastActivityAt: null,
    lastProgressAt: null,
    lastStartedAt: state === 'online' ? new Date('2026-11-04T09:58:30.000Z') : null,
    lastOnlineAt: state === 'online' ? new Date('2026-11-04T10:00:00.000Z') : null,
    lastStoppedAt: null,
    lastHealthAt: new Date().toISOString(),
    pid: state === 'online' ? 1234 : null,
    port: state === 'online' ? 3402 : null,
    bridgePort: state === 'online' ? 3401 : null,
    profile: state === 'online' ? 'm5a' : null,
    attemptCount: 0,
    errorCode: null,
    errorDetail: null,
    gitState,
    gitPhase: gitState === 'preparing' ? 'receiving' : gitState === 'ready' ? 'ready' : null,
    gitProgress: gitState === 'preparing' ? 42 : gitState === 'ready' ? 100 : null,
    gitDetail:
      gitState === 'preparing'
        ? '正在接收对象 42%'
        : gitState === 'ready'
          ? '仓库副本已就绪。'
          : gitState === 'failed'
            ? '网络不可达'
            : null,
    gitStartedAt: gitState === 'none' ? null : new Date().toISOString(),
    gitFinishedAt:
      gitState === 'preparing' || gitState === 'none' ? null : new Date().toISOString(),
    gitAttempts: gitState === 'none' ? 0 : 1,
    gitHead: gitState === 'ready' ? 'a'.repeat(40) : null,
    updatedAt: new Date().toISOString(),
  };
}

async function startFakeSupervisor(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://supervisor.test');
    calls.push(`${request.method} ${url.pathname}`);
    if (request.headers.authorization !== `Bearer ${SUPERVISOR_TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }
    const match = url.pathname.match(
      /instances\/([^/]+)\/(prepare|wake|sleep|touch|retry|git\/prepare|remove)$/,
    );
    if (!match) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const repositoryId = match[1]!;
    const action = match[2]!;
    response.setHeader('content-type', 'application/json');
    if (action === 'remove') {
      if (failNextRemove) {
        failNextRemove = false;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'local cleanup failed (test)' } }));
        return;
      }
      const send = () => {
        response.writeHead(200);
        response.end(
          JSON.stringify({
            data: { removed: true, alreadyRemoved: false, profile: 'm5a', paths: [] },
          }),
        );
      };
      if (removeDelayMs > 0) setTimeout(send, removeDelayMs);
      else send();
      return;
    }
    if (action === 'sleep') {
      response.writeHead(409);
      response.end(
        JSON.stringify({
          data: {
            accepted: false,
            duplicate: false,
            instance: instance(repositoryId, 'online', 'sleep_refused'),
          },
        }),
      );
      return;
    }
    if (action === 'git/prepare') {
      response.end(
        JSON.stringify({ data: instance(repositoryId, 'sleeping', 'never_started', 'preparing') }),
      );
      return;
    }
    if (action === 'wake' || action === 'retry') {
      response.end(
        JSON.stringify({
          data: {
            accepted: true,
            duplicate: false,
            instance: instance(repositoryId, 'starting', 'starting'),
          },
        }),
      );
      return;
    }
    response.end(JSON.stringify({ data: instance(repositoryId, 'sleeping', 'never_started') }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, calls };
}

function writeFakeGh(directory: string): string {
  const path = join(directory, 'gh');
  writeFileSync(
    path,
    `#!/bin/sh
case "$*" in
  *user/repos*) echo '[[{"id":101,"full_name":"Bouyer12/m5a-alpha","default_branch":"main","private":true,"permissions":{"admin":true,"push":true}},{"id":102,"full_name":"Bouyer12/m5a-beta","default_branch":"trunk","private":true,"permissions":{"admin":false,"push":true}}]]' ;;
  *repos/Bouyer12/readonly*) echo '{"id":103,"full_name":"Bouyer12/readonly","default_branch":"main","private":true,"permissions":{"admin":false,"push":false}}' ;;
  *repos/Bouyer12/missing*) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  *repos/Bouyer12/m5a-alpha*) echo '{"id":101,"full_name":"Bouyer12/m5a-alpha","default_branch":"main","private":true,"permissions":{"admin":true,"push":true}}' ;;
  *repos/Bouyer12/m5a-beta*) echo '{"id":102,"full_name":"Bouyer12/m5a-beta","default_branch":"trunk","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-gamma*) echo '{"id":104,"full_name":"Bouyer12/m5a-gamma","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-delta*) echo '{"id":105,"full_name":"Bouyer12/m5a-delta","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-epsilon*) echo '{"id":106,"full_name":"Bouyer12/m5a-epsilon","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-zeta*) echo '{"id":107,"full_name":"Bouyer12/m5a-zeta","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-eta*) echo '{"id":108,"full_name":"Bouyer12/m5a-eta","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-theta*) echo '{"id":109,"full_name":"Bouyer12/m5a-theta","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-iota*) echo '{"id":110,"full_name":"Bouyer12/m5a-iota","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-kappa*) echo '{"id":111,"full_name":"Bouyer12/m5a-kappa","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *repos/Bouyer12/m5a-lambda*) echo '{"id":112,"full_name":"Bouyer12/m5a-lambda","default_branch":"main","private":true,"permissions":{"admin":false,"push":true}}' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe('multi-repository lifecycle API on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    const database = testDatabase.db;
    const [owner] = await database.insert(owners).values({ displayName: 'M5 Owner' }).returning();
    if (!owner) throw new Error('owner insert returned no row');

    const tempDir = mkdtempSync(join(tmpdir(), 'moyu-m5-gh-'));
    const gh = writeFakeGh(tempDir);
    const supervisor = await startFakeSupervisor();

    const [repositoryA] = await database
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: 'Bouyer12/m5a-alpha',
        defaultBranch: 'main',
        bridgeUrl: 'http://127.0.0.1:3401',
        bridgeCredentialRef: 'file:a.json',
        bridgeCallbackTokenHash: sha256(CALLBACK_A),
        status: 'active',
      })
      .returning();
    const [repositoryB] = await database
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: 'Bouyer12/m5a-beta',
        defaultBranch: 'trunk',
        bridgeUrl: 'http://127.0.0.1:3403',
        bridgeCredentialRef: 'file:b.json',
        bridgeCallbackTokenHash: sha256(CALLBACK_B),
        status: 'sleeping',
      })
      .returning();
    if (!repositoryA || !repositoryB) throw new Error('repository insert failed');
    await database.insert(repositoryInstances).values([
      {
        repositoryId: repositoryA.id,
        state: 'online',
        desiredState: 'online',
        reasonCode: 'listening',
        pid: 1234,
        port: 3402,
        bridgePort: 3401,
        activationRequestedAt: new Date('2026-11-04T09:58:00.000Z'),
        lastStartedAt: new Date('2026-11-04T09:58:30.000Z'),
        lastOnlineAt: new Date('2026-11-04T10:00:00.000Z'),
        lastHealthAt: new Date(),
        gitState: 'ready',
        gitPhase: 'ready',
        gitProgress: 100,
        gitFinishedAt: new Date('2026-11-04T09:59:00.000Z'),
        gitHead: 'a'.repeat(40),
      },
      {
        repositoryId: repositoryB.id,
        state: 'sleeping',
        desiredState: 'sleeping',
        reasonCode: 'evicted',
        lastProgressAt: new Date('2026-11-04T10:00:00Z'),
      },
    ]);

    const token = randomToken(32);
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabase.url,
      WEBAUTHN_ORIGIN: 'http://127.0.0.1:3230',
      WEBAUTHN_RP_ID: '127.0.0.1',
      GITHUB_CLI: gh,
      SUPERVISOR_URL: supervisor.url,
      SUPERVISOR_TOKEN,
      RUNTIME_CREDENTIALS_DIR: tempDir,
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
      cookieName: sessionCookieName(config),
      ownerId: owner.id,
      repositoryAId: repositoryA.id,
      repositoryBId: repositoryB.id,
      supervisor: supervisor.server,
      supervisorUrl: supervisor.url,
      supervisorCalls: supervisor.calls,
      tempDir,
    };
  }, 60_000);

  afterAll(async () => {
    await harness?.app.close();
    await new Promise<void>((resolve) => harness?.supervisor.close(() => resolve()));
    await testDatabase?.drop();
    if (harness?.tempDir) rmSync(harness.tempDir, { recursive: true, force: true });
  });

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    cookie = harness.cookie,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
    return harness.app.inject({
      method,
      url: path,
      headers: { cookie },
      ...(body === undefined ? {} : { payload: body }),
    });
  }

  it('lists repositories from the dedicated account and validates push permission', async () => {
    const list = await request('GET', '/api/v1/github/repositories?q=m5a');
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.data.repositories.map((row: { fullName: string }) => row.fullName)).toEqual([
      'Bouyer12/m5a-alpha',
      'Bouyer12/m5a-beta',
    ]);
    expect(body.data.repositories[1].defaultBranch).toBe('trunk');

    const denied = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/readonly',
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toMatch(/write|push/i);

    const missing = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/missing',
    });
    expect(missing.statusCode).toBe(403);
  });

  it('adds a repository once and reports duplicates as a conflict', async () => {
    const created = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-gamma',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.runtime.state).toBe('sleeping');

    const duplicate = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-gamma',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.message).toMatch(/already been added/);

    const rows = await harness.database.select().from(repositories);
    expect(rows.filter((row) => row.fullName === 'Bouyer12/m5a-gamma')).toHaveLength(1);
  });

  it('projects lifecycle state, waiting reason and allowed actions', async () => {
    const sleeping = await request('GET', `/api/v1/repositories/${harness.repositoryBId}/runtime`);
    expect(sleeping.statusCode).toBe(200);
    const runtime = sleeping.json().data.runtime;
    expect(runtime.state).toBe('sleeping');
    expect(runtime.listener).toBe('paused');
    expect(runtime.reason).toContain('GitHub 监听已暂停');
    expect(runtime.lastProgressAt).toBe('2026-11-04T10:00:00.000Z');
    expect(
      runtime.actions.find((action: { action: string }) => action.action === 'wake'),
    ).toMatchObject({ enabled: true });

    const online = await request('GET', `/api/v1/repositories/${harness.repositoryAId}/runtime`);
    expect(online.json().data.runtime.listener).toBe('active');
    expect(online.json().data.runtime.executionSlot).toBe('free');
    expect(online.json().data.runtime.activation).toMatchObject({
      phase: 'ready',
      requestedAt: '2026-11-04T09:58:00.000Z',
      onlineAt: '2026-11-04T10:00:00.000Z',
      elapsedMs: 120_000,
      readyMs: 120_000,
      retryAction: null,
    });
    expect(sleeping.json().data.runtime.activation).toMatchObject({
      phase: 'idle',
      requestedAt: null,
      elapsedMs: null,
      retryAction: 'wake',
    });
  });

  it('explains and gates execution on the repository Git copy, and retries it at repository level', async () => {
    await harness.database
      .update(repositoryInstances)
      .set({
        gitState: 'preparing',
        gitPhase: 'receiving',
        gitProgress: 42,
        gitDetail: 'Receiving objects: 42% (420/1000)',
        gitStartedAt: new Date(),
        gitAttempts: 1,
      })
      .where(eq(repositoryInstances.repositoryId, harness.repositoryAId));

    const runtime = await request('GET', `/api/v1/repositories/${harness.repositoryAId}/runtime`);
    expect(runtime.statusCode).toBe(200);
    expect(runtime.json().data.runtime.preparation).toMatchObject({
      state: 'preparing',
      phase: 'receiving',
      progress: 42,
      attempts: 1,
    });
    expect(runtime.json().data.runtime.reason).toContain('仓库副本准备中');
    expect(runtime.json().data.runtime.waitingFor).toBe('repository_copy');

    const gated = await request('POST', '/api/v1/conversations', {
      repositoryId: harness.repositoryAId,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      clientRequestId: `prepare-gate-${randomUUID()}`,
    });
    expect(gated.statusCode).toBe(409);
    expect(gated.json().error.message).toContain('仓库副本准备中');

    const retry = await request('POST', `/api/v1/repositories/${harness.repositoryAId}/prepare`);
    expect(retry.statusCode).toBe(202);
    expect(retry.json().data.runtime.actions).toContainEqual(
      expect.objectContaining({ action: 'prepare', enabled: false }),
    );

    await harness.database
      .update(repositoryInstances)
      .set({
        gitState: 'failed',
        gitPhase: null,
        gitProgress: null,
        gitDetail: '仓库副本准备失败（阶段 connecting）：网络不可达',
        gitFinishedAt: new Date(),
      })
      .where(eq(repositoryInstances.repositoryId, harness.repositoryAId));
    const failed = await request('POST', '/api/v1/conversations', {
      repositoryId: harness.repositoryAId,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      clientRequestId: `prepare-gate-${randomUUID()}`,
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.message).toContain('仓库副本准备失败');
    const failedRuntime = await request(
      'GET',
      `/api/v1/repositories/${harness.repositoryAId}/runtime`,
    );
    expect(failedRuntime.json().data.runtime.actions).toContainEqual(
      expect.objectContaining({ action: 'prepare', enabled: true }),
    );

    await harness.database
      .update(repositoryInstances)
      .set({
        gitState: 'ready',
        gitPhase: 'ready',
        gitProgress: 100,
        gitDetail: '仓库副本已就绪，可用于新任务。',
        gitFinishedAt: new Date(),
        gitHead: 'a'.repeat(40),
      })
      .where(eq(repositoryInstances.repositoryId, harness.repositoryAId));
    const accepted = await request('POST', '/api/v1/conversations', {
      repositoryId: harness.repositoryAId,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      clientRequestId: `prepare-gate-${randomUUID()}`,
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('accepts a wake and reports a refused sleep without pretending the instance stopped', async () => {
    const wake = await request('POST', `/api/v1/repositories/${harness.repositoryBId}/wake`);
    expect(wake.statusCode).toBe(200);
    expect(wake.json().data.accepted).toBe(true);

    const sleep = await request('POST', `/api/v1/repositories/${harness.repositoryAId}/sleep`);
    expect(sleep.statusCode).toBe(200);
    expect(sleep.json().data.accepted).toBe(false);
    expect(sleep.json().data.runtime.state).toBe('online');
  });

  it('rejects a callback token minted for another repository', async () => {
    const conversationId = randomUUID();
    await harness.database.insert(conversations).values({
      id: conversationId,
      ownerId: harness.ownerId,
      repositoryId: harness.repositoryAId,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      source: 'web',
      clientRequestId: randomUUID(),
    });
    await harness.database.insert(taskLinks).values({
      conversationId,
      repositoryId: harness.repositoryAId,
      state: 'running',
      baseBranch: 'main',
    });
    const payload = {
      sourceEventId: `m5-test-${randomBytes(4).toString('hex')}`,
      type: 'channel.message',
      conversationId,
      ticketId: null,
      triggerId: null,
      messageKind: 'reply',
      text: 'hello',
      at: new Date().toISOString(),
    };

    const wrong = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      headers: { authorization: `Bearer ${CALLBACK_B}` },
      payload,
    });
    expect(wrong.statusCode).toBe(401);

    const right = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      headers: { authorization: `Bearer ${CALLBACK_A}` },
      payload,
    });
    expect(right.statusCode).toBe(200);

    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      headers: { authorization: `Bearer ${CALLBACK_A}` },
      payload,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().data.duplicate).toBe(true);
  });

  it('stores per-repository check commands and audits every accepted change', async () => {
    const created = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-delta',
      checkCommands: ['npm ci --no-audit --no-fund', 'npm test'],
    });
    expect(created.statusCode).toBe(201);
    const repositoryId = created.json().data.repositoryId as string;

    const listed = await request('GET', '/api/v1/repositories');
    expect(listed.statusCode).toBe(200);
    const row = listed
      .json()
      .data.repositories.find((item: { id: string }) => item.id === repositoryId);
    expect(row.checkCommands).toEqual(['npm ci --no-audit --no-fund', 'npm test']);

    const auditRows = () =>
      harness.database
        .select()
        .from(repositoryAuditEvents)
        .where(eq(repositoryAuditEvents.repositoryId, repositoryId))
        .orderBy(repositoryAuditEvents.createdAt);

    expect(await auditRows()).toMatchObject([
      {
        actorOwnerId: harness.ownerId,
        type: 'check_commands_updated',
        detail: { from: null, to: ['npm ci --no-audit --no-fund', 'npm test'] },
      },
    ]);

    const updated = await request('PATCH', `/api/v1/repositories/${repositoryId}`, {
      checkCommands: ['pnpm check'],
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.repository.checkCommands).toEqual(['pnpm check']);
    expect((await auditRows()).at(-1)).toMatchObject({
      actorOwnerId: harness.ownerId,
      detail: { from: ['npm ci --no-audit --no-fund', 'npm test'], to: ['pnpm check'] },
    });

    // The same value is a no-op and does not add another audit row.
    const same = await request('PATCH', `/api/v1/repositories/${repositoryId}`, {
      checkCommands: ['pnpm check'],
    });
    expect(same.statusCode).toBe(200);
    expect(await auditRows()).toHaveLength(2);

    const cleared = await request('PATCH', `/api/v1/repositories/${repositoryId}`, {
      checkCommands: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.repository.checkCommands).toBeNull();
    expect((await auditRows()).at(-1)).toMatchObject({
      detail: { from: ['pnpm check'], to: null },
    });

    const rejected = await request('PATCH', `/api/v1/repositories/${repositoryId}`, {
      checkCommands: [],
    });
    expect(rejected.statusCode).toBe(422);
    expect(await auditRows()).toHaveLength(3);

    const missing = await request('PATCH', `/api/v1/repositories/${randomUUID()}`, {
      checkCommands: ['true'],
    });
    expect(missing.statusCode).toBe(404);
  });

  it('serializes concurrent changes so the audit rows form a chain', async () => {
    const created = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-epsilon',
    });
    expect(created.statusCode).toBe(201);
    const repositoryId = created.json().data.repositoryId as string;

    const [first, second] = await Promise.all([
      request('PATCH', `/api/v1/repositories/${repositoryId}`, {
        checkCommands: ['echo first'],
      }),
      request('PATCH', `/api/v1/repositories/${repositoryId}`, {
        checkCommands: ['echo second'],
      }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const rows = await harness.database
      .select()
      .from(repositoryAuditEvents)
      .where(eq(repositoryAuditEvents.repositoryId, repositoryId));
    expect(rows).toHaveLength(2);
    const details = rows.map((row) => row.detail as { from: unknown; to: unknown });
    const startsFromNull = details.find((detail) => detail.from === null);
    const chained = details.find((detail) => detail !== startsFromNull);
    expect(startsFromNull).toBeDefined();
    expect(chained).toBeDefined();
    expect(chained?.from).toEqual(startsFromNull?.to);

    const [stored] = await harness.database
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    expect(stored?.checkCommands).toEqual(chained?.to);
  });

  it('explains every switch phase and exposes the allowed retry', async () => {
    const update = (fields: Record<string, unknown>) =>
      harness.database
        .update(repositoryInstances)
        .set({ updatedAt: new Date(), ...fields })
        .where(eq(repositoryInstances.repositoryId, harness.repositoryAId));

    await update({
      state: 'sleeping',
      desiredState: 'online',
      reasonCode: 'capacity_wait',
      gitState: 'ready',
      gitPhase: 'ready',
    });
    let runtime = (
      await request('GET', `/api/v1/repositories/${harness.repositoryAId}/runtime`)
    ).json().data.runtime;
    expect(runtime.activation).toMatchObject({
      phase: 'queued',
      requestedAt: '2026-11-04T09:58:00.000Z',
      retryAction: null,
    });
    expect(runtime.activation.detail).toContain('等待');

    await update({ state: 'fault', desiredState: 'online', reasonCode: 'start_failed' });
    runtime = (await request('GET', `/api/v1/repositories/${harness.repositoryAId}/runtime`)).json()
      .data.runtime;
    expect(runtime.activation.phase).toBe('failed');
    expect(runtime.activation.retryAction).toBe('retry');

    await update({
      state: 'sleeping',
      desiredState: 'online',
      reasonCode: 'wake_queued',
      gitState: 'failed',
      gitPhase: null,
    });
    runtime = (await request('GET', `/api/v1/repositories/${harness.repositoryAId}/runtime`)).json()
      .data.runtime;
    expect(runtime.activation).toMatchObject({
      phase: 'failed',
      retryAction: 'prepare',
    });

    await update({
      state: 'starting',
      desiredState: 'online',
      reasonCode: 'starting',
      gitState: 'preparing',
      gitPhase: 'receiving',
    });
    runtime = (await request('GET', `/api/v1/repositories/${harness.repositoryAId}/runtime`)).json()
      .data.runtime;
    expect(runtime.activation.phase).toBe('preparing');
    expect(runtime.activation.retryAction).toBe(null);

    await update({
      state: 'online',
      desiredState: 'online',
      reasonCode: 'listening',
      gitState: 'ready',
      gitPhase: 'ready',
    });
  });

  it('removes a repository, keeps history, blocks work and supports re-add', async () => {
    const [conversation] = await harness.database
      .insert(conversations)
      .values({
        ownerId: harness.ownerId,
        repositoryId: harness.repositoryBId,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'trunk',
      })
      .returning();
    if (!conversation) throw new Error('conversation insert returned no row');
    const [task] = await harness.database
      .insert(taskLinks)
      .values({
        conversationId: conversation.id,
        repositoryId: harness.repositoryBId,
        state: 'running',
        baseBranch: 'trunk',
      })
      .returning();
    if (!task) throw new Error('task insert returned no row');

    const blocked = await request('DELETE', `/api/v1/repositories/${harness.repositoryBId}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain('任务');

    await harness.database
      .update(taskLinks)
      .set({ state: 'completed' })
      .where(eq(taskLinks.id, task.id));

    const removed = await request('DELETE', `/api/v1/repositories/${harness.repositoryBId}`);
    expect(removed.statusCode).toBe(202);
    expect(removed.json().data.repository.deletion).toMatchObject({
      state: 'removed',
      attempts: 1,
    });
    expect(removed.json().data.repository.deletion.removedAt).not.toBeNull();

    const list = await request('GET', '/api/v1/repositories');
    expect(
      list.json().data.repositories.map((repository: { id: string }) => repository.id),
    ).not.toContain(harness.repositoryBId);

    // History stays in PostgreSQL; the now-hidden repository's links answer a
    // readable fallback instead of a generic not-found.
    const history = await harness.database
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(history).toHaveLength(1);
    const oldLink = await request('GET', `/api/v1/repositories/${harness.repositoryBId}/runtime`);
    expect(oldLink.statusCode).toBe(404);
    expect(oldLink.json().error.message).toContain('已从 MoYu 移除');

    const duplicate = await request('DELETE', `/api/v1/repositories/${harness.repositoryBId}`);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().data.repository.deletion.state).toBe('removed');

    const readd = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-beta',
    });
    expect(readd.statusCode).toBe(201);
    const [restored] = await harness.database
      .select()
      .from(repositories)
      .where(eq(repositories.id, harness.repositoryBId));
    expect(restored?.id).toBe(harness.repositoryBId);
    expect(restored?.deletionState).toBe('none');
    expect(restored?.removedAt).toBeNull();
    const restoredHistory = await harness.database
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(restoredHistory).toHaveLength(1);
  });

  it('does not restore expired history when re-adding without an API restart', async () => {
    const [expired] = await harness.database
      .insert(repositories)
      .values({
        ownerId: harness.ownerId,
        fullName: 'Bouyer12/m5a-kappa',
        status: 'sleeping',
        deletionState: 'removed',
        removedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        deletionFinishedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      })
      .returning();
    if (!expired) throw new Error('expired repository was not inserted');
    const [oldConversation] = await harness.database
      .insert(conversations)
      .values({
        ownerId: harness.ownerId,
        repositoryId: expired.id,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
      })
      .returning();
    if (!oldConversation) throw new Error('expired conversation was not inserted');

    const readd = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-kappa',
    });
    expect(readd.statusCode).toBe(201);
    expect(readd.json().data.repositoryId).toBe(expired.id);
    const [restored] = await harness.database
      .select()
      .from(repositories)
      .where(eq(repositories.id, expired.id));
    expect(restored?.deletionState).toBe('none');
    expect(restored?.removedAt).toBeNull();
    const history = await harness.database
      .select()
      .from(conversations)
      .where(eq(conversations.id, oldConversation.id));
    expect(history).toHaveLength(0);
  });

  it('purges expired history under the re-add lock without deleting a new session', async () => {
    const [expired] = await harness.database
      .insert(repositories)
      .values({
        ownerId: harness.ownerId,
        fullName: 'Bouyer12/m5a-lambda',
        status: 'sleeping',
        deletionState: 'removed',
        removedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        deletionFinishedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      })
      .returning();
    if (!expired) throw new Error('expired repository was not inserted');
    const [oldConversation] = await harness.database
      .insert(conversations)
      .values({
        ownerId: harness.ownerId,
        repositoryId: expired.id,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
      })
      .returning();
    if (!oldConversation) throw new Error('expired conversation was not inserted');

    // Hold the same repository row lock so the purge and the re-add both stop
    // before their state checks; releasing it makes them contend for real.
    const blocker = await testDatabase.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('select 1 from repositories where id = $1 for update', [expired.id]);
      const { purgeExpiredRepositoryHistory } = await import('../../src/domain/repository-removal');
      const purge = purgeExpiredRepositoryHistory(harness.database);
      const readd = request('POST', '/api/v1/repositories', {
        fullName: 'Bouyer12/m5a-lambda',
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await blocker.query('COMMIT');
      const [, readdResult] = await Promise.all([purge, readd]);
      expect(readdResult.statusCode).toBe(201);

      const oldHistory = await harness.database
        .select()
        .from(conversations)
        .where(eq(conversations.id, oldConversation.id));
      expect(oldHistory).toHaveLength(0);

      const created = await request('POST', '/api/v1/conversations', {
        repositoryId: expired.id,
        mode: 'work',
        executionMode: 'discuss',
        baseBranch: 'main',
        clientRequestId: `purge-race-${randomUUID()}`,
      });
      expect(created.statusCode).toBe(201);
      const newConversationId = created.json().data.conversation.id as string;
      await purgeExpiredRepositoryHistory(harness.database);
      const newHistory = await harness.database
        .select()
        .from(conversations)
        .where(eq(conversations.id, newConversationId));
      expect(newHistory).toHaveLength(1);
    } finally {
      blocker.release();
    }
  });

  it('keeps a failed removal retryable and recovers an interrupted deletion', async () => {
    const created = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-zeta',
    });
    expect(created.statusCode).toBe(201);
    const repositoryId = created.json().data.repositoryId as string;

    failNextRemove = true;
    const failed = await request('DELETE', `/api/v1/repositories/${repositoryId}`);
    expect(failed.statusCode).toBe(503);
    const [afterFailure] = await harness.database
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    expect(afterFailure?.deletionState).toBe('failed');
    expect(afterFailure?.deletionDetail).toContain('local cleanup failed');

    const retried = await request('DELETE', `/api/v1/repositories/${repositoryId}`);
    expect(retried.statusCode).toBe(202);
    expect(retried.json().data.repository.deletion).toMatchObject({
      state: 'removed',
      attempts: 2,
    });

    await harness.database
      .update(repositories)
      .set({ deletionState: 'deleting', removedAt: null })
      .where(eq(repositories.id, repositoryId));
    const { recoverInterruptedDeletions } = await import('../../src/domain/repository-removal');
    await recoverInterruptedDeletions(harness.database);
    const [afterRestart] = await harness.database
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    expect(afterRestart?.deletionState).toBe('failed');
    expect(afterRestart?.deletionDetail).toContain('服务重启');
  });

  it('claims a concurrent removal once and keeps a late result from finishing it', async () => {
    const created = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-eta',
    });
    expect(created.statusCode).toBe(201);
    const repositoryId = created.json().data.repositoryId as string;
    const before = harness.supervisorCalls.filter((call) =>
      call.endsWith(`/instances/${repositoryId}/remove`),
    ).length;

    removeDelayMs = 100;
    const [first, second] = await Promise.all([
      request('DELETE', `/api/v1/repositories/${repositoryId}`),
      request('DELETE', `/api/v1/repositories/${repositoryId}`),
    ]);
    removeDelayMs = 0;
    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 202]);
    const removeCalls = harness.supervisorCalls.filter((call) =>
      call.endsWith(`/instances/${repositoryId}/remove`),
    ).length;
    expect(removeCalls - before).toBe(1);
    const [row] = await harness.database
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    expect(row?.deletionState).toBe('removed');

    // A result carrying an older operation id must not change the row.
    await harness.database
      .update(repositories)
      .set({
        deletionState: 'deleting',
        deletionOperationId: '00000000-0000-4000-8000-0000000000aa',
        removedAt: null,
      })
      .where(eq(repositories.id, repositoryId));
    const { finalizeRemoval } = await import('../../src/domain/repository-removal');
    expect(
      await finalizeRemoval(
        harness.database,
        repositoryId,
        '00000000-0000-4000-8000-0000000000bb',
        { ok: true },
      ),
    ).toBeNull();
    const [stillDeleting] = await harness.database
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    expect(stillDeleting?.deletionState).toBe('deleting');
    expect(stillDeleting?.removedAt).toBeNull();
  });

  it('does not reassign a removed repository to another owner', async () => {
    const created = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-iota',
    });
    expect(created.statusCode).toBe(201);
    const repositoryId = created.json().data.repositoryId as string;
    const removed = await request('DELETE', `/api/v1/repositories/${repositoryId}`);
    expect(removed.statusCode).toBe(202);

    const [otherOwner] = await harness.database
      .insert(owners)
      .values({ displayName: 'Other Re-add Owner' })
      .returning();
    if (!otherOwner) throw new Error('other owner insert returned no row');
    const token = randomToken(32);
    await harness.database.insert(sessions).values({
      ownerId: otherOwner.id,
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const readd = await request(
      'POST',
      '/api/v1/repositories',
      { fullName: 'Bouyer12/m5a-iota' },
      `${harness.cookieName}=${token}`,
    );
    expect(readd.statusCode).toBe(409);
    expect(readd.json().error.message).toContain('another owner');
    const [row] = await harness.database
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId));
    expect(row?.ownerId).toBe(harness.ownerId);
    expect(row?.deletionState).toBe('removed');
  });

  it('serializes deletion against task admission and purges only expired history', async () => {
    const created = await request('POST', '/api/v1/repositories', {
      fullName: 'Bouyer12/m5a-theta',
    });
    expect(created.statusCode).toBe(201);
    const repositoryId = created.json().data.repositoryId as string;

    const [admission, removal] = await Promise.all([
      request('POST', '/api/v1/conversations', {
        repositoryId,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
        clientRequestId: `race-${randomUUID()}`,
      }),
      request('DELETE', `/api/v1/repositories/${repositoryId}`),
    ]);
    // The row lock makes one of the two win; the loser must explain the state.
    expect([admission.statusCode, removal.statusCode].filter((code) => code < 300)).toHaveLength(1);
    if (admission.statusCode === 201) expect(removal.statusCode).toBe(409);
    else expect(admission.statusCode).toBe(409);

    // Retention: an old removed repository loses its history; a recent one keeps it.
    const [oldRepo] = await harness.database
      .insert(repositories)
      .values({
        ownerId: harness.ownerId,
        fullName: 'Bouyer12/retention-old',
        status: 'sleeping',
        deletionState: 'removed',
        removedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      })
      .returning();
    const [recentRepo] = await harness.database
      .insert(repositories)
      .values({
        ownerId: harness.ownerId,
        fullName: 'Bouyer12/retention-recent',
        status: 'sleeping',
        deletionState: 'removed',
        removedAt: new Date(),
      })
      .returning();
    if (!oldRepo || !recentRepo) throw new Error('retention repositories were not inserted');
    const [oldConversation] = await harness.database
      .insert(conversations)
      .values({
        ownerId: harness.ownerId,
        repositoryId: oldRepo.id,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
      })
      .returning();
    const [recentConversation] = await harness.database
      .insert(conversations)
      .values({
        ownerId: harness.ownerId,
        repositoryId: recentRepo.id,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
      })
      .returning();
    if (!oldConversation || !recentConversation) {
      throw new Error('retention conversations were not inserted');
    }
    const { purgeExpiredRepositoryHistory } = await import('../../src/domain/repository-removal');
    await purgeExpiredRepositoryHistory(harness.database);
    const oldRows = await harness.database
      .select()
      .from(conversations)
      .where(eq(conversations.id, oldConversation.id));
    const recentRows = await harness.database
      .select()
      .from(conversations)
      .where(eq(conversations.id, recentConversation.id));
    expect(oldRows).toHaveLength(0);
    expect(recentRows).toHaveLength(1);
  });

  it('does not let another owner remove a repository', async () => {
    const [otherOwner] = await harness.database
      .insert(owners)
      .values({ displayName: 'Other Removal Owner' })
      .returning();
    if (!otherOwner) throw new Error('other owner insert returned no row');
    const token = randomToken(32);
    await harness.database.insert(sessions).values({
      ownerId: otherOwner.id,
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const response = await request(
      'DELETE',
      `/api/v1/repositories/${harness.repositoryAId}`,
      undefined,
      `${harness.cookieName}=${token}`,
    );
    expect(response.statusCode).toBe(404);
  });

  it('does not let another owner change a repository check-command override', async () => {
    const [otherOwner] = await harness.database
      .insert(owners)
      .values({ displayName: 'Other Owner' })
      .returning();
    if (!otherOwner) throw new Error('other owner insert returned no row');
    const token = randomToken(32);
    await harness.database.insert(sessions).values({
      ownerId: otherOwner.id,
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const response = await request(
      'PATCH',
      `/api/v1/repositories/${harness.repositoryAId}`,
      { checkCommands: ['echo other-owner'] },
      `${harness.cookieName}=${token}`,
    );
    expect(response.statusCode).toBe(404);
  });
});
