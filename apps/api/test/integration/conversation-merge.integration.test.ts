import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conversations,
  deliveries,
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
    const clientMessageId = `merge-${randomUUID()}`;
    const text =
      'Same requirement: https://github.com/Bouyer12/m4-merge-test/issues/1#issuecomment-9';
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${webConversationId}/messages`,
      headers: { cookie },
      payload: { clientMessageId, text },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { data: { message: { id: string; conversationId: string } } };
    expect(body.data.message.conversationId).toBe(githubConversationId);

    const source = await database
      .select({ mergedInto: conversations.mergedIntoConversationId })
      .from(conversations)
      .where(eq(conversations.id, webConversationId))
      .limit(1);
    expect(source[0]?.mergedInto).toBe(githubConversationId);
    const tasks = await database
      .select({ id: taskLinks.id })
      .from(taskLinks)
      .where(eq(taskLinks.repositoryId, repositoryId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).not.toBe(webTaskId);

    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${webConversationId}/messages`,
      headers: { cookie },
      payload: { clientMessageId, text },
    });
    expect(retry.statusCode).toBe(200);
    const retryBody = retry.json() as {
      data: { duplicate: boolean; message: { id: string; conversationId: string } };
    };
    expect(retryBody.data.duplicate).toBe(true);
    expect(retryBody.data.message.id).toBe(body.data.message.id);
    expect(retryBody.data.message.conversationId).toBe(githubConversationId);

    const later = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${webConversationId}/messages`,
      headers: { cookie },
      payload: {
        clientMessageId: `later-${randomUUID()}`,
        text: 'Follow-up on the same requirement',
      },
    });
    expect(later.statusCode).toBe(202);
    expect(
      (later.json() as { data: { message: { conversationId: string } } }).data.message
        .conversationId,
    ).toBe(githubConversationId);
    const githubMessages = await database
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, githubConversationId));
    expect(githubMessages).toHaveLength(2);
  });

  it('returns one receipt for concurrent retries with the same clientMessageId', async () => {
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
    const clientMessageId = `race-${randomUUID()}`;
    const text = 'Race: https://github.com/Bouyer12/m4-merge-test/issues/1';
    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url: `/api/v1/conversations/${web!.id}/messages`,
          headers: { cookie },
          payload: { clientMessageId, text },
        }),
      ),
    );
    if (![200, 202].includes(first!.statusCode) || ![200, 202].includes(second!.statusCode))
      console.log('RACE_BODY', first!.statusCode, first!.body, second!.statusCode, second!.body);
    expect([first!.statusCode, second!.statusCode].sort()).toEqual([200, 202]);
    const receipt = first!.statusCode === 200 ? first!.json() : second!.json();
    expect((receipt as { data: { duplicate: boolean } }).data.duplicate).toBe(true);
    const targetMessages = await database
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, githubConversationId),
          eq(messages.clientMessageId, clientMessageId),
        ),
      );
    expect(targetMessages).toHaveLength(1);
  });

  it('delivers different concurrent Web messages to the target once the alias is being created', async () => {
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
    const url = 'https://github.com/Bouyer12/m4-merge-test/issues/1';
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${web!.id}/messages`,
        headers: { cookie },
        payload: { clientMessageId: `a-${randomUUID()}`, text: `First ${url}` },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${web!.id}/messages`,
        headers: { cookie },
        payload: { clientMessageId: `b-${randomUUID()}`, text: `Second ${url}` },
      }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    for (const response of responses) {
      expect(
        (response.json() as { data: { message: { conversationId: string } } }).data.message
          .conversationId,
      ).toBe(githubConversationId);
    }
    const sourceMessages = await database
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, web!.id));
    expect(sourceMessages).toHaveLength(0);
  });

  it('routes an ordinary supplementary message and a URL merge into the one target task', async () => {
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
    const ordinaryId = `ordinary-${randomUUID()}`;
    const urlId = `url-${randomUUID()}`;
    const [ordinary, merge] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${web!.id}/messages`,
        headers: { cookie },
        payload: { clientMessageId: ordinaryId, text: 'A supplementary note without a URL' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${web!.id}/messages`,
        headers: { cookie },
        payload: {
          clientMessageId: urlId,
          text: 'Same requirement https://github.com/Bouyer12/m4-merge-test/issues/1',
        },
      }),
    ]);
    expect([ordinary.statusCode, merge.statusCode]).toEqual([202, 202]);
    const source = await database
      .select({ mergedInto: conversations.mergedIntoConversationId })
      .from(conversations)
      .where(eq(conversations.id, web!.id))
      .limit(1);
    expect(source[0]?.mergedInto).toBe(githubConversationId);
    const sourceMessages = await database
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, web!.id));
    expect(sourceMessages).toHaveLength(0);
    const targetIds = await database
      .select({ clientMessageId: messages.clientMessageId })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, githubConversationId),
          inArray(messages.clientMessageId, [ordinaryId, urlId]),
        ),
      );
    expect(targetIds.map((row) => row.clientMessageId).sort()).toEqual([ordinaryId, urlId].sort());
    const tasks = await database
      .select({ id: taskLinks.id })
      .from(taskLinks)
      .where(eq(taskLinks.repositoryId, repositoryId));
    expect(tasks).toHaveLength(1);
    // Alias reads resolve to the target and see the moved ordinary message.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${web!.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { data: { conversation: { id: string } } }).data.conversation.id).toBe(
      githubConversationId,
    );
  });

  it('moves a multi-level reply chain atomically during a URL merge', async () => {
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
    const insert = async (body: string, replyTo: string | null) => {
      const [message] = await database
        .insert(messages)
        .values({
          conversationId: web!.id,
          direction: 'inbound',
          kind: 'user',
          clientMessageId: `chain-${randomUUID()}`,
          body,
          replyToMessageId: replyTo,
          source: 'web',
        })
        .returning();
      await database
        .insert(deliveries)
        .values({ messageId: message!.id, upstreamTriggerId: `workspace:${message!.id}` });
      return message!.id;
    };
    const a = await insert('parent', null);
    const b = await insert('child', a);
    const c = await insert('grandchild', b);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${web!.id}/messages`,
      headers: { cookie },
      payload: {
        clientMessageId: `chain-url-${randomUUID()}`,
        text: 'Same requirement https://github.com/Bouyer12/m4-merge-test/issues/1',
      },
    });
    expect(response.statusCode).toBe(202);
    const moved = await database
      .select({ id: messages.id, replyTo: messages.replyToMessageId })
      .from(messages)
      .where(inArray(messages.id, [a, b, c]));
    expect(moved).toHaveLength(3);
    expect(moved.find((row) => row.id === b)?.replyTo).toBe(a);
    expect(moved.find((row) => row.id === c)?.replyTo).toBe(b);
    for (const id of [a, b, c]) {
      const [row] = await database
        .select({ conversationId: messages.conversationId })
        .from(messages)
        .where(eq(messages.id, id))
        .limit(1);
      expect(row?.conversationId).toBe(githubConversationId);
    }
  });

  it('remaps replies when the merged parent already exists on the target', async () => {
    const key = `dup-${randomUUID()}`;
    const [targetParent] = await database
      .insert(messages)
      .values({
        conversationId: githubConversationId,
        direction: 'inbound',
        kind: 'user',
        clientMessageId: key,
        body: 'duplicate parent',
        source: 'web',
      })
      .returning();
    await database
      .insert(deliveries)
      .values({ messageId: targetParent!.id, upstreamTriggerId: `workspace:${targetParent!.id}` });
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
    const [sourceParent] = await database
      .insert(messages)
      .values({
        conversationId: web!.id,
        direction: 'inbound',
        kind: 'user',
        clientMessageId: key,
        body: 'duplicate parent',
        source: 'web',
      })
      .returning();
    await database
      .insert(deliveries)
      .values({ messageId: sourceParent!.id, upstreamTriggerId: `workspace:${sourceParent!.id}` });
    const [child] = await database
      .insert(messages)
      .values({
        conversationId: web!.id,
        direction: 'inbound',
        kind: 'user',
        clientMessageId: `child-${randomUUID()}`,
        body: 'reply to duplicate parent',
        replyToMessageId: sourceParent!.id,
        source: 'web',
      })
      .returning();
    await database
      .insert(deliveries)
      .values({ messageId: child!.id, upstreamTriggerId: `workspace:${child!.id}` });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${web!.id}/messages`,
      headers: { cookie },
      payload: {
        clientMessageId: `dup-url-${randomUUID()}`,
        text: 'Same requirement https://github.com/Bouyer12/m4-merge-test/issues/1',
      },
    });
    expect(response.statusCode).toBe(202);
    const [movedChild] = await database
      .select({ replyTo: messages.replyToMessageId })
      .from(messages)
      .where(eq(messages.id, child!.id))
      .limit(1);
    expect(movedChild?.replyTo).toBe(targetParent!.id);
    const [deadParent] = await database
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, sourceParent!.id))
      .limit(1);
    expect(deadParent).toBeUndefined();
  });

  it('refuses to merge while a source delivery is already in flight', async () => {
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
    const [message] = await database
      .insert(messages)
      .values({
        conversationId: web!.id,
        direction: 'inbound',
        kind: 'user',
        clientMessageId: `inflight-${randomUUID()}`,
        body: 'already claimed',
        source: 'web',
      })
      .returning();
    await database.insert(deliveries).values({
      messageId: message!.id,
      upstreamTriggerId: `workspace:${message!.id}`,
      state: 'delivering',
      leaseOwner: 'dispatcher-test',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attemptCount: 1,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${web!.id}/messages`,
      headers: { cookie },
      payload: {
        clientMessageId: `inflight-url-${randomUUID()}`,
        text: 'Same requirement https://github.com/Bouyer12/m4-merge-test/issues/1',
      },
    });
    expect(response.statusCode).toBe(409);
    const [task] = await database
      .select({ conversationId: taskLinks.conversationId })
      .from(taskLinks)
      .where(eq(taskLinks.conversationId, web!.id))
      .limit(1);
    expect(task?.conversationId).toBe(web!.id);
    const [still] = await database
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, message!.id))
      .limit(1);
    expect(still?.id).toBe(message!.id);
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
