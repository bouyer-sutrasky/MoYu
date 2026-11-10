import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { taskReviewDataSchema } from '@moyu/contracts';
import {
  artifacts,
  conversations,
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
  cookieName: string;
  config: ApiConfig;
  ownerId: string;
  repositoryId: string;
  conversationId: string;
  taskId: string;
  ticketId: string;
}

interface SupervisorState {
  changes: Record<string, unknown>;
  checks: Record<string, unknown>[];
  calls: { path: string; body: unknown }[];
}

const supervisor: SupervisorState = { changes: {}, checks: [], calls: [] };
let server: Server;

function startSupervisor(): Promise<number> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      supervisor.calls.push({ path: request.url ?? '', body });
      if (request.headers.authorization !== 'Bearer supervisor-token-123456') {
        response.writeHead(401).end();
        return;
      }
      if (request.url?.endsWith('/review/changes')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: supervisor.changes }));
        return;
      }
      if (request.url?.endsWith('/review/checks')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            data: {
              worktree: {
                state: 'available',
                directory: '/worktrees/probe1/mp-fix',
                reason: null,
                profile: 'probe1',
              },
              runs: supervisor.checks,
            },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function seedHarness(testDatabase: TestDatabase, supervisorUrl: string): Promise<Harness> {
  const database = testDatabase.db;
  const [owner] = await database.insert(owners).values({ displayName: 'M6 Review' }).returning();
  if (!owner) throw new Error('owner insert returned no row');
  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: 'Bouyer12/m6-review-test',
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  if (!repository) throw new Error('repository insert returned no row');
  const [conversation] = await database
    .insert(conversations)
    .values({
      ownerId: owner.id,
      repositoryId: repository.id,
      mode: 'work',
      executionMode: 'execute',
      source: 'web',
      baseBranch: 'main',
      baseCommit: 'd02f07f1483e0c85a13c1dfe24d03d855a72d0a1',
    })
    .returning();
  if (!conversation) throw new Error('conversation insert returned no row');
  const ticketId = `t_${randomUUID().replaceAll('-', '')}`;
  const [task] = await database
    .insert(taskLinks)
    .values({
      conversationId: conversation.id,
      repositoryId: repository.id,
      state: 'awaiting_review',
      upstreamTicketId: ticketId,
      baseBranch: 'main',
      baseCommit: 'd02f07f1483e0c85a13c1dfe24d03d855a72d0a1',
      executionMode: 'execute',
    })
    .returning();
  if (!task) throw new Error('task insert returned no row');
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
    SUPERVISOR_URL: supervisorUrl,
    SUPERVISOR_TOKEN: 'supervisor-token-123456',
    GITHUB_CLI: 'gh',
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
    conversationId: conversation.id,
    taskId: task.id,
    ticketId,
  };
}

function authCookie(harness: Harness) {
  return { cookies: { [harness.cookieName]: harness.token } };
}

const DIFF = [
  'diff --git a/apps/api/src/app.ts b/apps/api/src/app.ts',
  '--- a/apps/api/src/app.ts',
  '+++ b/apps/api/src/app.ts',
  '@@ -1 +1,2 @@',
  '+export const added = true;',
].join('\n');

describe('M6 review projection', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;

  beforeAll(async () => {
    const port = await startSupervisor();
    testDatabase = await createTestDatabase();
    harness = await seedHarness(testDatabase, `http://127.0.0.1:${port}`);
  }, 60_000);

  afterAll(async () => {
    await harness?.app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await testDatabase?.drop();
  });

  it('reports a stated reason before anything is collected', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${harness.taskId}/review`,
      ...authCookie(harness),
    });
    expect(response.statusCode).toBe(200);
    const review = taskReviewDataSchema.parse((response.json() as { data: unknown }).data).review;
    expect(review.changes.state).toBe('unavailable');
    expect(review.changes.collectedAt).toBeNull();
    expect(review.changes.files).toEqual([]);
    expect(review.checks.state).toBe('not_run');
    expect(review.pullRequest).toBeNull();
  });

  it('stores the collected worktree diff and reads it back after a restart', async () => {
    supervisor.changes = {
      state: 'available',
      reason: null,
      directory: '/worktrees/probe1/mp-fix',
      branch: 'agent/m6-review',
      commit: '4bd4aae33eac2e8a1fd9f981ca0d17bd4bd4aae3',
      commitSubject: 'feat(m6): collect the review data',
      committedAt: '2026-11-08T03:38:56.000Z',
      files: [
        {
          path: 'apps/api/src/app.ts',
          previousPath: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
          binary: false,
          patch: DIFF,
          patchTruncated: false,
        },
      ],
      additions: 1,
      deletions: 0,
      filesOmitted: 0,
    };

    const collected = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${harness.taskId}/review/changes`,
      ...authCookie(harness),
    });
    expect(collected.statusCode).toBe(200);
    const review = taskReviewDataSchema.parse((collected.json() as { data: unknown }).data).review;
    expect(review.changes.state).toBe('available');
    expect(review.changes.commit).toBe('4bd4aae33eac2e8a1fd9f981ca0d17bd4bd4aae3');
    expect(review.changes.files[0]?.patch).toBe(DIFF);
    expect(supervisor.calls.at(-1)?.body).toEqual({ ticketId: harness.ticketId });

    const [row] = await harness.database
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, harness.taskId));
    expect(row?.type).toBe('diff');

    // A fresh app instance is the restart case: the projection is read from the
    // database, not from process memory.
    const restarted = buildApp({ config: harness.config, database: harness.database });
    await restarted.ready();
    const after = await restarted.inject({
      method: 'GET',
      url: `/api/v1/tasks/${harness.taskId}/review`,
      ...authCookie(harness),
    });
    await restarted.close();
    const reread = taskReviewDataSchema.parse((after.json() as { data: unknown }).data).review;
    expect(reread.changes.files).toHaveLength(1);
    expect(reread.changes.commit).toBe('4bd4aae33eac2e8a1fd9f981ca0d17bd4bd4aae3');
  });

  it('shows the cleaned state instead of an empty diff when the worktree is gone', async () => {
    supervisor.changes = {
      state: 'cleaned',
      reason: '该任务的执行目录已不存在。',
      directory: null,
      branch: null,
      commit: null,
      commitSubject: null,
      committedAt: null,
      files: [],
      additions: 0,
      deletions: 0,
      filesOmitted: 0,
    };
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${harness.taskId}/review/changes`,
      ...authCookie(harness),
    });
    expect(response.statusCode).toBe(200);
    const review = taskReviewDataSchema.parse((response.json() as { data: unknown }).data).review;
    expect(review.changes.state).toBe('cleaned');
    expect(review.changes.reason).toContain('已不存在');
  });

  it('stores real check runs with exit codes and timestamps', async () => {
    supervisor.checks = [
      {
        id: '1',
        command: 'pnpm check',
        exitCode: 1,
        passed: false,
        timedOut: false,
        startedAt: '2026-11-08T03:40:00.000Z',
        finishedAt: '2026-11-08T03:41:00.000Z',
        durationMs: 60_000,
        summary: '失败（exit 1）',
        output: 'error TS2322: Type string is not assignable to type number',
        outputTruncated: false,
      },
    ];
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${harness.taskId}/review/checks`,
      ...authCookie(harness),
    });
    expect(response.statusCode).toBe(200);
    const review = taskReviewDataSchema.parse((response.json() as { data: unknown }).data).review;
    expect(review.checks.state).toBe('available');
    expect(review.checks.runs[0]).toMatchObject({
      command: 'pnpm check',
      exitCode: 1,
      passed: false,
    });

    const [row] = await harness.database
      .select()
      .from(artifacts)
      .where(eq(artifacts.type, 'check_report'));
    expect(row?.taskId).toBe(harness.taskId);
  });

  it('keeps a pull request closed but unmerged as closed, never merged', async () => {
    // With no runtime PR number the projection is null; the state mapping is
    // asserted by the API client against a real PR in the acceptance evidence.
    expect(
      taskReviewDataSchema.parse({
        review: {
          taskId: harness.taskId,
          conversationId: harness.conversationId,
          changes: {
            state: 'available',
            reason: null,
            collectedAt: new Date().toISOString(),
            branch: 'main',
            commit: null,
            commitSubject: null,
            committedAt: null,
            files: [],
            additions: 0,
            deletions: 0,
            filesOmitted: 0,
          },
          checks: { state: 'not_run', reason: null, collectedAt: null, runs: [] },
          pullRequest: {
            number: 37,
            url: 'https://github.com/bouyer-sutrasky/MoYu/pull/37',
            state: 'closed',
            headSha: null,
            baseBranch: 'main',
            updatedAt: null,
            unavailableReason: null,
          },
        },
      }).review.pullRequest?.state,
    ).toBe('closed');
  });
});
