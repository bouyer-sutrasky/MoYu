import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newTaskFromTaskDataSchema, newTaskFromTaskPreviewDataSchema } from '@moyu/contracts';
import {
  conversations,
  messages,
  owners,
  repositories,
  sessions,
  taskLinks,
  type Database,
} from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig, type ApiConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './helpers';

interface Harness {
  app: FastifyInstance;
  database: Database;
  token: string;
  config: ApiConfig;
  ownerId: string;
  repositoryId: string;
  otherRepositoryId: string;
  foreignRepositoryId: string;
}

async function seedHarness(testDatabase: TestDatabase): Promise<Harness> {
  const database = testDatabase.db;
  const [owner] = await database.insert(owners).values({ displayName: 'L117 Owner' }).returning();
  const [otherOwner] = await database
    .insert(owners)
    .values({ displayName: 'L117 Other Owner' })
    .returning();
  if (!owner || !otherOwner) throw new Error('owner insert failed');
  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: 'Bouyer12/l117-source',
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  const [otherRepository] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: 'Bouyer12/l117-target',
      defaultBranch: 'trunk',
      status: 'active',
    })
    .returning();
  const [foreignRepository] = await database
    .insert(repositories)
    .values({
      ownerId: otherOwner.id,
      fullName: 'someone/l117-foreign',
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  if (!repository || !otherRepository || !foreignRepository) {
    throw new Error('repository insert failed');
  }
  const token = randomToken(32);
  await database.insert(sessions).values({
    ownerId: owner.id,
    tokenHash: hashSecret(token),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const config = loadConfig();
  const app = await buildApp({ config, database });
  await app.ready();
  return {
    app,
    database,
    token,
    config,
    ownerId: owner.id,
    repositoryId: repository.id,
    otherRepositoryId: otherRepository.id,
    foreignRepositoryId: foreignRepository.id,
  };
}

async function seedTask(
  harness: Harness,
  state: string,
  options: { pr?: boolean; baseCommit?: string; stopEvidence?: Record<string, unknown> } = {},
): Promise<{ taskId: string; conversationId: string }> {
  const [conversation] = await harness.database
    .insert(conversations)
    .values({
      ownerId: harness.ownerId,
      repositoryId: harness.repositoryId,
      mode: 'work',
      executionMode: 'execute',
      source: 'web',
      baseBranch: 'main',
      baseCommit: options.baseCommit ?? 'abc1234',
      title: `source ${state}`,
    })
    .returning();
  if (!conversation) throw new Error('conversation insert failed');
  const [task] = await harness.database
    .insert(taskLinks)
    .values({
      conversationId: conversation.id,
      repositoryId: harness.repositoryId,
      state: state as never,
      baseBranch: 'main',
      baseCommit: options.baseCommit ?? 'abc1234',
      stopEvidence: options.stopEvidence ?? {},
      prUrl: options.pr ? 'https://github.com/Bouyer12/l117-source/pull/7' : null,
      prNumber: options.pr ? 7 : null,
    })
    .returning();
  if (!task) throw new Error('task insert failed');
  await harness.database.insert(messages).values({
    conversationId: conversation.id,
    direction: 'outbound',
    kind: 'result',
    source: 'bridge',
    body: `delivered summary for ${state}`,
  });
  return { taskId: task.id, conversationId: conversation.id };
}

let testDatabase: TestDatabase;
let harness: Harness;
let completed: { taskId: string; conversationId: string };
let closed: { taskId: string; conversationId: string };
let running: { taskId: string; conversationId: string };
let cleaned: { taskId: string; conversationId: string };

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  harness = await seedHarness(testDatabase);
  completed = await seedTask(harness, 'completed', { pr: true });
  closed = await seedTask(harness, 'closed_unmerged', { pr: true });
  running = await seedTask(harness, 'running');
  cleaned = await seedTask(harness, 'completed', {
    baseCommit: 'def5678',
    stopEvidence: { worktreeRemoved: true, worktree: '/tmp/cleaned' },
  });
});

afterAll(async () => {
  await harness?.app.close();
  await testDatabase?.drop();
});

function cookie(): string {
  return `${sessionCookieName(harness.config)}=${harness.token}`;
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    repositoryId: harness.repositoryId,
    baseBranch: 'main',
    baseCommit: null,
    clientRequestId: randomUUID(),
    confirmed: true,
    ...overrides,
  };
}

describe('new task from a finished task', () => {
  it('previews the explicit inheritance of a completed task', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${completed.taskId}/new-task-preview`,
      headers: { cookie: cookie() },
    });
    expect(response.statusCode).toBe(200);
    const data = newTaskFromTaskPreviewDataSchema.parse(response.json().data);
    expect(data.inheritance).toMatchObject({
      fromTaskId: completed.taskId,
      fromConversationId: completed.conversationId,
      fromState: 'completed',
      deliverySummary: 'delivered summary for completed',
      baseCommit: 'abc1234',
      worktreeRecoverable: false,
      recovery: 'completed_new_task',
      reopensPullRequest: false,
      reusesSourceExecution: false,
    });
    expect(data.inheritance.pullRequest).toEqual({
      url: 'https://github.com/Bouyer12/l117-source/pull/7',
      number: 7,
    });
    expect(data.suggestedTarget.repositoryId).toBe(harness.repositoryId);
  });

  it('creates one independent task and lists every inherited field', async () => {
    const clientRequestId = randomUUID();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${completed.taskId}/new-task`,
      headers: { cookie: cookie() },
      payload: createBody({ clientRequestId }),
    });
    expect(response.statusCode).toBe(201);
    const data = newTaskFromTaskDataSchema.parse(response.json().data);
    expect(data.executionIdentity).toMatchObject({
      upstreamTicketId: null,
      reusesSourceSession: false,
      startsFromCommit: 'abc1234',
    });
    expect(data.executionIdentity.conversationId).toBe(data.conversation.id);
    expect(data.conversation.id).not.toBe(completed.conversationId);
    expect(data.conversation.task?.id).not.toBe(completed.taskId);
    expect(data.conversation.repositoryId).toBe(harness.repositoryId);
    expect(data.inheritance.deliverySummary).toBe('delivered summary for completed');
    expect(data.inheritance.reopensPullRequest).toBe(false);
    // The source task keeps its own PR; the new task owns nothing yet.
    expect(data.conversation.task?.prUrl).toBeNull();
    const [source] = await harness.database
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.id, completed.taskId))
      .limit(1);
    expect(source?.prUrl).toBe('https://github.com/Bouyer12/l117-source/pull/7');
    const [notice] = await harness.database
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, data.conversation.id), eq(messages.kind, 'notice')))
      .limit(1);
    expect(notice?.body).toContain('delivered summary for completed');
    expect(notice?.body).toContain('不是原现场恢复');
  });

  it('creates one task when the same request id is retried', async () => {
    const clientRequestId = randomUUID();
    const first = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${completed.taskId}/new-task`,
      headers: { cookie: cookie() },
      payload: createBody({ clientRequestId }),
    });
    const second = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${completed.taskId}/new-task`,
      headers: { cookie: cookie() },
      payload: createBody({ clientRequestId }),
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const one = newTaskFromTaskDataSchema.parse(first.json().data);
    const two = newTaskFromTaskDataSchema.parse(second.json().data);
    expect(two.conversation.id).toBe(one.conversation.id);
    expect(two.executionIdentity.taskId).toBe(one.executionIdentity.taskId);
    const rows = await harness.database
      .select()
      .from(conversations)
      .where(eq(conversations.clientRequestId, clientRequestId));
    expect(rows).toHaveLength(1);
    const tasks = await harness.database
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.conversationId, one.conversation.id));
    expect(tasks).toHaveLength(1);
  });

  it('allows another owned repository and refuses a foreign one', async () => {
    const allowed = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${completed.taskId}/new-task`,
      headers: { cookie: cookie() },
      payload: createBody({ repositoryId: harness.otherRepositoryId, baseBranch: 'trunk' }),
    });
    expect(allowed.statusCode).toBe(201);
    const data = newTaskFromTaskDataSchema.parse(allowed.json().data);
    expect(data.conversation.repositoryId).toBe(harness.otherRepositoryId);
    expect(data.conversation.task?.repositoryId).toBe(harness.otherRepositoryId);
    expect(data.conversation.task?.baseBranch).toBe('trunk');
    // A cross-repository task does not inherit the source commit.
    expect(data.executionIdentity.startsFromCommit).toBeNull();

    const refused = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${completed.taskId}/new-task`,
      headers: { cookie: cookie() },
      payload: createBody({ repositoryId: harness.foreignRepositoryId }),
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({
      error: { code: 'not_found', message: 'Repository not found' },
    });
  });

  it('states the closed-unmerged recovery path without reopening the PR', async () => {
    const preview = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${closed.taskId}/new-task-preview`,
      headers: { cookie: cookie() },
    });
    const data = newTaskFromTaskPreviewDataSchema.parse(preview.json().data);
    expect(data.inheritance.recovery).toBe('closed_unmerged_new_task');
    expect(data.inheritance.recoveryNote).toContain('不会重新打开原 PR');
    expect(data.inheritance.recoveryNote).toContain('不是恢复原现场');
    expect(data.inheritance.reopensPullRequest).toBe(false);
    const created = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${closed.taskId}/new-task`,
      headers: { cookie: cookie() },
      payload: createBody(),
    });
    expect(created.statusCode).toBe(201);
    const [source] = await harness.database
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.id, closed.taskId))
      .limit(1);
    expect(source?.state).toBe('closed_unmerged');
    expect(source?.prUrl).toBe('https://github.com/Bouyer12/l117-source/pull/7');
  });

  it('creates from a cleaned worktree and says the old scene is gone', async () => {
    const preview = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${cleaned.taskId}/new-task-preview`,
      headers: { cookie: cookie() },
    });
    const data = newTaskFromTaskPreviewDataSchema.parse(preview.json().data);
    expect(data.inheritance.worktreeRecoverable).toBe(false);
    expect(data.inheritance.worktreeNote).toContain('旧现场不可恢复');
    expect(data.inheritance.baseCommit).toBe('def5678');
    const created = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${cleaned.taskId}/new-task`,
      headers: { cookie: cookie() },
      payload: createBody({ baseCommit: 'def5678' }),
    });
    expect(created.statusCode).toBe(201);
    const body = newTaskFromTaskDataSchema.parse(created.json().data);
    expect(body.executionIdentity.startsFromCommit).toBe('def5678');
  });

  it('refuses a source task that has not finished', async () => {
    const preview = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${running.taskId}/new-task-preview`,
      headers: { cookie: cookie() },
    });
    expect(preview.statusCode).toBe(409);
    const created = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${running.taskId}/new-task`,
      headers: { cookie: cookie() },
      payload: createBody(),
    });
    expect(created.statusCode).toBe(409);
  });
});
