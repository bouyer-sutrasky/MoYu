import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { conversationListDataSchema, type ConversationListData } from '@moyu/contracts';
import { conversations, owners, repositories, sessions, taskLinks, type Database } from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './helpers';

interface Harness {
  app: FastifyInstance;
  database: Database;
  cookie: string;
  repositoryAId: string;
  repositoryBId: string;
}

function envelope(payload: unknown): unknown {
  return (payload as { data?: unknown }).data;
}

async function seedConversation(
  database: Database,
  input: {
    ownerId: string;
    repositoryId: string;
    title: string;
    state: (typeof taskLinks.$inferInsert)['state'];
    updatedAt: Date;
  },
): Promise<string> {
  const [conversation] = await database
    .insert(conversations)
    .values({
      ownerId: input.ownerId,
      repositoryId: input.repositoryId,
      mode: 'work',
      executionMode: 'execute',
      source: 'web',
      baseBranch: 'main',
      title: input.title,
      updatedAt: input.updatedAt,
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error('conversation insert returned no row');
  await database.insert(taskLinks).values({
    conversationId: conversation.id,
    repositoryId: input.repositoryId,
    state: input.state,
    baseBranch: 'main',
  });
  return conversation.id;
}

async function page(harness: Harness, query: string): Promise<ConversationListData> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/v1/conversations?${query}`,
    headers: { cookie: harness.cookie },
  });
  expect(response.statusCode).toBe(200);
  return conversationListDataSchema.parse(envelope(response.json()));
}

describe('workbench pending task query on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;
  const now = Date.parse('2026-03-01T00:00:00.000Z');

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    const database = testDatabase.db;
    const [owner] = await database
      .insert(owners)
      .values({ displayName: 'Pending Owner' })
      .returning();
    if (!owner) throw new Error('owner insert returned no row');
    const [repositoryA] = await database
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: 'Bouyer12/pending-a',
        defaultBranch: 'main',
        status: 'active',
      })
      .returning();
    const [repositoryB] = await database
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: 'Bouyer12/pending-b',
        defaultBranch: 'main',
        status: 'active',
      })
      .returning();
    if (!repositoryA || !repositoryB) throw new Error('repository insert returned no row');

    // A much older pending task must not be hidden behind a full page of newer
    // completed conversations.
    for (let index = 0; index < 60; index += 1) {
      await seedConversation(database, {
        ownerId: owner.id,
        repositoryId: repositoryA.id,
        title: `completed ${index}`,
        state: 'completed',
        updatedAt: new Date(now - index * 1000),
      });
    }
    await seedConversation(database, {
      ownerId: owner.id,
      repositoryId: repositoryA.id,
      title: 'old waiting input',
      state: 'waiting_input',
      updatedAt: new Date(now - 365 * 86_400_000),
    });

    const token = randomToken(32);
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabase.url,
      WEBAUTHN_ORIGIN: 'http://127.0.0.1:3220',
      WEBAUTHN_RP_ID: '127.0.0.1',
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
      repositoryAId: repositoryA.id,
      repositoryBId: repositoryB.id,
    };
  }, 60_000);

  afterAll(async () => {
    await harness?.app.close();
    await testDatabase?.drop();
  });

  it('finds an old pending task before pagination and separates the pending count from history', async () => {
    const pending = await page(
      harness,
      `repositoryId=${harness.repositoryAId}&pending=true&limit=3`,
    );
    expect(pending.pendingCount).toBe(1);
    expect(pending.conversations.map((conversation) => conversation.title)).toEqual([
      'old waiting input',
    ]);

    const history = await page(harness, `repositoryId=${harness.repositoryAId}&limit=3`);
    expect(history.pendingCount).toBe(1);
    expect(history.conversations.map((conversation) => conversation.title)).toEqual([
      'completed 0',
      'completed 1',
      'completed 2',
    ]);
  }, 30_000);

  it('orders by waiting_input, awaiting_review, blocked/failed, then queued/running/stopping', async () => {
    const ownerId = (
      await harness.database.execute<{ owner_id: string }>(
        sql`select owner_id from repositories where id = ${harness.repositoryAId}`,
      )
    ).rows[0]!.owner_id;
    const states = [
      ['running', 5],
      ['queued', 4],
      ['failed', 3],
      ['blocked', 2],
      ['awaiting_review', 1],
      ['waiting_input', 0],
    ] as const;
    for (const [state, offset] of states) {
      await seedConversation(harness.database, {
        ownerId,
        repositoryId: harness.repositoryAId,
        title: `state ${state}`,
        state,
        updatedAt: new Date(now - 100_000 + offset * 1000),
      });
    }

    const pending = await page(
      harness,
      `repositoryId=${harness.repositoryAId}&pending=true&limit=10`,
    );
    const titles = pending.conversations.map((conversation) => conversation.title);
    expect(titles.indexOf('state waiting_input')).toBeLessThan(
      titles.indexOf('state awaiting_review'),
    );
    // blocked/failed share one priority tier, and queued/running/stopping share
    // the next; inside a tier the newest updatedAt wins.
    expect(titles.indexOf('state awaiting_review')).toBeLessThan(titles.indexOf('state failed'));
    expect(titles.indexOf('state failed')).toBeLessThan(titles.indexOf('state blocked'));
    expect(titles.indexOf('state blocked')).toBeLessThan(titles.indexOf('state running'));
    expect(titles.indexOf('state running')).toBeLessThan(titles.indexOf('state queued'));
  }, 30_000);

  it('keeps repositories isolated and pages every pending rank exactly once', async () => {
    const ownerId = (
      await harness.database.execute<{ owner_id: string }>(
        sql`select owner_id from repositories where id = ${harness.repositoryBId}`,
      )
    ).rows[0]!.owner_id;
    await seedConversation(harness.database, {
      ownerId,
      repositoryId: harness.repositoryBId,
      title: 'repository B waiting',
      state: 'waiting_input',
      updatedAt: new Date(now - 200_000),
    });

    const repoB = await page(
      harness,
      `repositoryId=${harness.repositoryBId}&pending=true&limit=10`,
    );
    expect(repoB.conversations.map((conversation) => conversation.title)).toEqual([
      'repository B waiting',
    ]);

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix = cursor ? `&limit=2&cursor=${encodeURIComponent(cursor)}` : '&limit=2';
      const result = await page(
        harness,
        `repositoryId=${harness.repositoryAId}&pending=true${suffix}`,
      );
      collected.push(...result.conversations.map((conversation) => conversation.id));
      cursor = result.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor);
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.length).toBeGreaterThan(3);
  }, 30_000);
});
