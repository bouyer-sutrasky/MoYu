import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conversationDetailDataSchema,
  taskCommandDataSchema,
  type TaskSummary,
} from '@moyu/contracts';
import { owners, repositories, sessions, taskLinks, taskOperations, type Database } from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig, type ApiConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './helpers';

interface Harness {
  app: FastifyInstance;
  database: Database;
  token: string;
  cookieName: string;
  config: ApiConfig;
  ownerId: string;
  repositoryId: string;
}

async function seedHarness(testDatabase: TestDatabase): Promise<Harness> {
  const database = testDatabase.db;
  const [owner] = await database.insert(owners).values({ displayName: 'M4 Owner' }).returning();
  if (!owner) {
    throw new Error('owner insert returned no row');
  }
  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: 'Bouyer12/m4-execution-test',
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  if (!repository) {
    throw new Error('repository insert returned no row');
  }
  const token = randomToken(32);
  await database.insert(sessions).values({
    ownerId: owner.id,
    tokenHash: hashSecret(token),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: testDatabase.url,
    WEBAUTHN_ORIGIN: 'http://127.0.0.1:3210',
    WEBAUTHN_RP_ID: '127.0.0.1',
  });
  const app = buildApp({ config, database });
  await app.ready();
  return {
    app,
    database,
    token,
    cookieName: sessionCookieName(config),
    config,
    ownerId: owner.id,
    repositoryId: repository.id,
  };
}

function envelope(payload: unknown): unknown {
  return (payload as { data?: unknown }).data;
}

function authCookie(harness: Harness) {
  return { cookies: { [harness.cookieName]: harness.token } };
}

async function createConversation(
  harness: Harness,
  executionMode: 'execute' | 'discuss' = 'discuss',
) {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/conversations',
    ...authCookie(harness),
    payload: {
      repositoryId: harness.repositoryId,
      mode: 'work',
      executionMode,
      baseBranch: 'main',
      clientRequestId: `task-${randomUUID()}`,
    },
  });
  expect(response.statusCode).toBe(201);
  return conversationDetailDataSchema.parse(envelope(response.json())).conversation;
}

async function makeRuntimeAccepted(
  harness: Harness,
  conversationId: string,
  state: TaskSummary['state'],
) {
  const [task] = await harness.database
    .update(taskLinks)
    .set({
      upstreamTicketId: `ticket-${randomUUID()}`,
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      state,
    })
    .where(eq(taskLinks.conversationId, conversationId))
    .returning();
  if (!task) {
    throw new Error('task update returned no row');
  }
  return task;
}

async function command(
  harness: Harness,
  taskId: string,
  action: 'start' | 'stop' | 'resume' | 'retry',
  payload: Record<string, unknown>,
) {
  return harness.app.inject({
    method: 'POST',
    url: `/api/v1/tasks/${taskId}/${action}`,
    ...authCookie(harness),
    payload,
  });
}

describe('M4 task commands', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    harness = await seedHarness(testDatabase);
  }, 60_000);

  afterAll(async () => {
    await harness?.app.close();
    await testDatabase?.drop();
  });

  it('starts a discussion only after the runtime accepted it and records the plan revision', async () => {
    const conversation = await createConversation(harness);
    const task = conversation.task!;

    const tooEarly = await command(harness, task.id, 'start', {
      expectedVersion: task.version,
      clientCommandId: `cmd-${randomUUID()}`,
      planRevision: 1,
    });
    expect(tooEarly.statusCode).toBe(409);

    const accepted = await makeRuntimeAccepted(harness, conversation.id, 'awaiting_review');
    const response = await command(harness, task.id, 'start', {
      expectedVersion: accepted.version,
      clientCommandId: `cmd-${randomUUID()}`,
      planRevision: 1,
    });
    expect(response.statusCode).toBe(202);
    const data = taskCommandDataSchema.parse(envelope(response.json()));
    expect(data.operation).toMatchObject({ kind: 'start', state: 'queued' });
    expect(data.task.planRevision).toBe(1);
    // The runtime has not confirmed the switch, so the platform still freezes discuss.
    expect(data.task.executionMode).toBe('discuss');

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversation.id}`,
      ...authCookie(harness),
    });
    const after = conversationDetailDataSchema.parse(envelope(detail.json())).conversation;
    expect(after.planRevision).toBe(1);
    expect(after.task?.planRevision).toBe(1);
  }, 30_000);

  it('wakes a sleeping repository when a stopped task is resumed', async () => {
    const conversation = await createConversation(harness);
    const task = await makeRuntimeAccepted(harness, conversation.id, 'stopped');
    const calls: Array<{ url: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        calls.push({
          url: request.url ?? '',
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { repositoryId: harness.repositoryId } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: harness.config.databaseUrl,
      WEBAUTHN_ORIGIN: 'http://127.0.0.1:3210',
      WEBAUTHN_RP_ID: '127.0.0.1',
      SUPERVISOR_URL: `http://127.0.0.1:${address.port}`,
      SUPERVISOR_TOKEN: 'task-wake-supervisor-token',
    });
    const app = buildApp({ config, database: harness.database });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/resume`,
        ...authCookie(harness),
        payload: { expectedVersion: task.version, clientCommandId: `resume-${randomUUID()}` },
      });
      expect(response.statusCode).toBe(202);
      expect(calls).toEqual([
        {
          url: `/control/v1/instances/${harness.repositoryId}/wake`,
          body: { reason: 'reply', priority: 10 },
        },
      ]);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('deduplicates a task command by clientCommandId and rejects a reused id with a different payload', async () => {
    const conversation = await createConversation(harness, 'execute');
    const task = await makeRuntimeAccepted(harness, conversation.id, 'running');
    const clientCommandId = `cmd-${randomUUID()}`;
    const payload = { expectedVersion: task.version, clientCommandId };

    const first = await command(harness, task.id, 'stop', payload);
    expect(first.statusCode).toBe(202);
    const firstData = taskCommandDataSchema.parse(envelope(first.json()));
    expect(firstData.operation.kind).toBe('pause');
    expect(firstData.task.state).toBe('stopping');
    expect(firstData.task.stopRequestedAt).not.toBeNull();

    const replay = await command(harness, task.id, 'stop', payload);
    expect(replay.statusCode).toBe(200);
    const replayData = taskCommandDataSchema.parse(envelope(replay.json()));
    expect(replayData.operation.id).toBe(firstData.operation.id);

    const conflict = await command(harness, task.id, 'stop', {
      ...payload,
      expectedVersion: task.version + 1,
    });
    expect(conflict.statusCode).toBe(409);
  }, 30_000);

  it('requires a newer plan revision and only starts a discussion', async () => {
    const discussion = await createConversation(harness);
    const task = await makeRuntimeAccepted(harness, discussion.id, 'awaiting_review');
    const first = await command(harness, task.id, 'start', {
      expectedVersion: task.version,
      clientCommandId: `cmd-${randomUUID()}`,
      planRevision: 2,
    });
    expect(first.statusCode).toBe(202);
    const [stored] = await harness.database
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.id, task.id));
    expect(stored?.planRevision).toBe(2);
    // A queued start blocks a second command for the same task.
    const again = await command(harness, task.id, 'stop', {
      expectedVersion: stored?.version ?? 0,
      clientCommandId: `cmd-${randomUUID()}`,
    });
    expect([409, 422]).toContain(again.statusCode);

    const executeConversation = await createConversation(harness, 'execute');
    const executeTask = await makeRuntimeAccepted(harness, executeConversation.id, 'running');
    const notDiscuss = await command(harness, executeTask.id, 'start', {
      expectedVersion: executeTask.version,
      clientCommandId: `cmd-${randomUUID()}`,
      planRevision: 1,
    });
    expect(notDiscuss.statusCode).toBe(409);
    expect(notDiscuss.json()).toMatchObject({ error: { code: 'conflict' } });
  }, 30_000);

  it('resumes only a stopped task and retries only a failed or blocked one', async () => {
    const stoppedConversation = await createConversation(harness, 'execute');
    const running = await makeRuntimeAccepted(harness, stoppedConversation.id, 'running');
    const notStopped = await command(harness, running.id, 'resume', {
      expectedVersion: running.version,
      clientCommandId: `cmd-${randomUUID()}`,
    });
    expect(notStopped.statusCode).toBe(409);

    const [stopped] = await harness.database
      .update(taskLinks)
      .set({ state: 'stopped', stoppedAt: new Date(), version: running.version + 1 })
      .where(eq(taskLinks.id, running.id))
      .returning();
    const resume = await command(harness, running.id, 'resume', {
      expectedVersion: stopped?.version ?? 0,
      clientCommandId: `cmd-${randomUUID()}`,
    });
    expect(resume.statusCode).toBe(202);
    expect(taskCommandDataSchema.parse(envelope(resume.json())).operation.kind).toBe('resume');

    const failedConversation = await createConversation(harness, 'execute');
    const failed = await makeRuntimeAccepted(harness, failedConversation.id, 'failed');
    const notRetryable = await command(harness, failed.id, 'resume', {
      expectedVersion: failed.version,
      clientCommandId: `cmd-${randomUUID()}`,
    });
    expect(notRetryable.statusCode).toBe(409);
    const retry = await command(harness, failed.id, 'retry', {
      expectedVersion: failed.version,
      clientCommandId: `cmd-${randomUUID()}`,
    });
    expect(retry.statusCode).toBe(202);
    expect(taskCommandDataSchema.parse(envelope(retry.json())).operation.kind).toBe('retry');
  }, 30_000);

  it('refuses a new message on a closed-unmerged task and keeps the conversation and worktree', async () => {
    const conversation = await createConversation(harness, 'execute');
    const task = await makeRuntimeAccepted(harness, conversation.id, 'closed_unmerged');
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.id}/messages`,
      ...authCookie(harness),
      payload: { clientMessageId: `msg-${randomUUID()}`, text: 'Please continue' },
    });
    expect(response.statusCode).toBe(409);
    const [stored] = await harness.database
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.id, task.id));
    expect(stored?.state).toBe('closed_unmerged');
    // The operation table is the durable command log; refusing a message does
    // not create a command either.
    const operations = await harness.database
      .select()
      .from(taskOperations)
      .where(eq(taskOperations.taskId, task.id));
    expect(operations).toHaveLength(0);
  }, 30_000);

  it('keeps one active command per task', async () => {
    const conversation = await createConversation(harness, 'execute');
    const task = await makeRuntimeAccepted(harness, conversation.id, 'running');
    const first = await command(harness, task.id, 'stop', {
      expectedVersion: task.version,
      clientCommandId: `cmd-${randomUUID()}`,
    });
    expect(first.statusCode).toBe(202);
    const [current] = await harness.database
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.id, task.id));
    const second = await command(harness, task.id, 'resume', {
      expectedVersion: current?.version ?? 0,
      clientCommandId: `cmd-${randomUUID()}`,
    });
    // A resume of a stopping task is refused by state, and the active-operation
    // index is the second boundary if two commands race.
    expect(second.statusCode).toBe(409);
  }, 30_000);
});
