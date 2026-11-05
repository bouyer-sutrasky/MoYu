import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conversations,
  owners,
  repositories,
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
  ownerId: string;
  repositoryAId: string;
  repositoryBId: string;
  supervisor: Server;
  supervisorUrl: string;
  tempDir: string;
}

const SUPERVISOR_TOKEN = 'm5-test-supervisor-token-0123456789';
const CALLBACK_A = 'callback-token-a-0123456789abcdef';
const CALLBACK_B = 'callback-token-b-0123456789abcdef';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function instance(repositoryId: string, state: string, reasonCode: string) {
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
    lastActivityAt: null,
    lastProgressAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    lastHealthAt: new Date().toISOString(),
    pid: state === 'online' ? 1234 : null,
    port: state === 'online' ? 3402 : null,
    bridgePort: state === 'online' ? 3401 : null,
    profile: state === 'online' ? 'm5a' : null,
    attemptCount: 0,
    errorCode: null,
    errorDetail: null,
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
    const match = url.pathname.match(/instances\/([^/]+)\/(prepare|wake|sleep|touch|retry)$/);
    if (!match) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const repositoryId = match[1]!;
    const action = match[2]!;
    response.setHeader('content-type', 'application/json');
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
        lastHealthAt: new Date(),
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
      ownerId: owner.id,
      repositoryAId: repositoryA.id,
      repositoryBId: repositoryB.id,
      supervisor: supervisor.server,
      supervisorUrl: supervisor.url,
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
    method: 'GET' | 'POST',
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
});
