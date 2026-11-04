import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { loadConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './helpers';

let database: Database;
let app: FastifyInstance;
let testDatabase: TestDatabase;
let cookie: string;
let repositoryId: string;
let githubConversationId: string;
let webConversationId: string;
let webTaskId: string;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  database = testDatabase.db;
  const [owner] = await database.insert(owners).values({ displayName: 'Merge Owner' }).returning();
  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner!.id,
      fullName: 'Bouyer12/m4-merge-test',
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  repositoryId = repository!.id;
  const token = randomToken(32);
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: testDatabase.url,
    WEBAUTHN_ORIGIN: 'http://127.0.0.1:3210',
    WEBAUTHN_RP_ID: '127.0.0.1',
  });
  await database.insert(sessions).values({
    ownerId: owner!.id,
    tokenHash: hashSecret(token),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  cookie = `${sessionCookieName(config)}=${token}`;
  const [github] = await database
    .insert(conversations)
    .values({
      ownerId: owner!.id,
      repositoryId,
      mode: 'work',
      executionMode: 'execute',
      source: 'github',
      externalKey: 'github:1',
      externalUrl: 'https://github.com/Bouyer12/m4-merge-test/issues/1',
      baseBranch: 'main',
      title: 'GitHub import',
    })
    .returning();
  githubConversationId = github!.id;
  await database.insert(taskLinks).values({
    conversationId: githubConversationId,
    repositoryId,
    upstreamTicketId: 'github-ticket-1',
    state: 'running',
    baseBranch: 'main',
    executionMode: 'execute',
  });
  const [web] = await database
    .insert(conversations)
    .values({
      ownerId: owner!.id,
      repositoryId,
      mode: 'work',
      executionMode: 'execute',
      source: 'web',
      baseBranch: 'main',
      title: null,
    })
    .returning();
  webConversationId = web!.id;
  const [webTask] = await database
    .insert(taskLinks)
    .values({
      conversationId: webConversationId,
      repositoryId,
      state: 'pending_admission',
      baseBranch: 'main',
      executionMode: 'execute',
    })
    .returning();
  webTaskId = webTask!.id;
  app = buildApp({ config, database });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await testDatabase?.drop();
});

describe('Web entry after a GitHub import', () => {
  it('delivers the first Web message to the exact imported Issue/PR and removes the empty Web task', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${webConversationId}/messages`,
      headers: { cookie },
      payload: {
        clientMessageId: `merge-${randomUUID()}`,
        text: 'Same requirement: https://github.com/Bouyer12/m4-merge-test/issues/1#issuecomment-9',
      },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { data: { message: { conversationId: string } } };
    expect(body.data.message.conversationId).toBe(githubConversationId);

    const remaining = await database
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.repositoryId, repositoryId));
    expect(remaining.map((row) => row.id)).toEqual([githubConversationId]);
    const tasks = await database
      .select({ id: taskLinks.id })
      .from(taskLinks)
      .where(eq(taskLinks.repositoryId, repositoryId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).not.toBe(webTaskId);
    const githubMessages = await database
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, githubConversationId));
    expect(githubMessages).toHaveLength(1);
  });

  it('does not merge /issues/10 into the /issues/1 requirement', async () => {
    const [web] = await database
      .insert(conversations)
      .values({
        ownerId: (
          await database
            .select({ ownerId: repositories.ownerId })
            .from(repositories)
            .where(eq(repositories.id, repositoryId))
            .limit(1)
        )[0]!.ownerId,
        repositoryId,
        mode: 'work',
        executionMode: 'execute',
        source: 'web',
        baseBranch: 'main',
      })
      .returning();
    await database.insert(taskLinks).values({
      conversationId: web!.id,
      repositoryId,
      state: 'pending_admission',
      baseBranch: 'main',
      executionMode: 'execute',
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${web!.id}/messages`,
      headers: { cookie },
      payload: {
        clientMessageId: `merge-10-${randomUUID()}`,
        text: 'Different requirement: https://github.com/Bouyer12/m4-merge-test/issues/10',
      },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { data: { message: { conversationId: string } } };
    expect(body.data.message.conversationId).toBe(web!.id);
  });
});
