import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conversationDetailDataSchema,
  createMessageDataSchema,
  messageListDataSchema,
  modelListDataSchema,
  runtimeEventDataSchema,
} from '@moyu/contracts';
import {
  conversations,
  deliveries,
  events,
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
  cookieName: string;
  config: ApiConfig;
  ownerId: string;
  repositoryId: string;
}

async function seedHarness(testDatabase: TestDatabase): Promise<Harness> {
  const database = testDatabase.db;
  const [owner] = await database.insert(owners).values({ displayName: 'M3 Owner' }).returning();
  if (!owner) {
    throw new Error('owner insert returned no row');
  }
  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: 'Bouyer12/m3-loop-test',
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
    WEBAUTHN_ORIGIN: 'http://127.0.0.1:3200',
    WEBAUTHN_RP_ID: '127.0.0.1',
    BRIDGE_CALLBACK_TOKEN: 'm3-test-callback-token-0123456789',
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

async function createConversation(harness: Harness, clientRequestId = `req-${randomUUID()}`) {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/conversations',
    ...authCookie(harness),
    payload: {
      repositoryId: harness.repositoryId,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      model: {
        provider: 'commandcode',
        model: 'deepseek/deepseek-v4.1-flash',
        reasoningEffort: 'high',
      },
      clientRequestId,
    },
  });
  expect(response.statusCode).toBe(201);
  return conversationDetailDataSchema.parse(envelope(response.json())).conversation;
}

describe('work loop API on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    harness = await seedHarness(testDatabase);
  }, 60_000);

  afterAll(async () => {
    if (harness) {
      await harness.app.close();
    }
    if (testDatabase) {
      await testDatabase.drop();
    }
  });

  it('creates a conversation and its pending task once per clientRequestId', async () => {
    const clientRequestId = `create-${randomUUID()}`;
    const conversation = await createConversation(harness, clientRequestId);

    expect(conversation.task?.state).toBe('pending_admission');
    expect(conversation.model?.provider).toBe('commandcode');
    expect(conversation.baseBranch).toBe('main');
    expect(conversation.baseCommit).toBeNull();

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      ...authCookie(harness),
      payload: {
        repositoryId: harness.repositoryId,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
        model: {
          provider: 'commandcode',
          model: 'deepseek/deepseek-v4.1-flash',
          reasoningEffort: 'high',
        },
        clientRequestId,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(conversationDetailDataSchema.parse(envelope(replay.json())).conversation.id).toBe(
      conversation.id,
    );

    const conflicting = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      ...authCookie(harness),
      payload: {
        repositoryId: harness.repositoryId,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'other-branch',
        clientRequestId,
      },
    });
    expect(conflicting.statusCode).toBe(409);
    const [count] = await harness.database
      .select({ count: sql<number>`count(*)::int` })
      .from(conversations)
      .where(eq(conversations.clientRequestId, clientRequestId));
    expect(count?.count).toBe(1);
  });

  it('rejects the M4 discussion mode instead of pretending it works', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      ...authCookie(harness),
      payload: {
        repositoryId: harness.repositoryId,
        mode: 'work',
        executionMode: 'discuss',
        baseBranch: 'main',
        clientRequestId: `discuss-${randomUUID()}`,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('writes a message and its delivery in one transaction and deduplicates retries', async () => {
    const conversation = await createConversation(harness);
    const clientMessageId = `msg-${randomUUID()}`;

    const first = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.id}/messages`,
      ...authCookie(harness),
      payload: { clientMessageId, text: 'Run the M3 loop' },
    });
    expect(first.statusCode).toBe(202);
    const parsed = createMessageDataSchema.parse(envelope(first.json()));
    expect(parsed.duplicate).toBe(false);
    expect(parsed.message.delivery?.state).toBe('stored');

    const replay = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.id}/messages`,
      ...authCookie(harness),
      payload: { clientMessageId, text: 'Run the M3 loop' },
    });
    expect(replay.statusCode).toBe(200);
    const replayed = createMessageDataSchema.parse(envelope(replay.json()));
    expect(replayed.duplicate).toBe(true);
    expect(replayed.message.id).toBe(parsed.message.id);

    const conflicting = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.id}/messages`,
      ...authCookie(harness),
      payload: { clientMessageId, text: 'A different payload' },
    });
    expect(conflicting.statusCode).toBe(409);

    const [rowCount] = await harness.database
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.clientMessageId, clientMessageId),
        ),
      );
    expect(rowCount?.count).toBe(1);
    const [deliveryCount] = await harness.database
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveries)
      .where(eq(deliveries.messageId, parsed.message.id));
    expect(deliveryCount?.count).toBe(1);
  });

  it('rejects a cross-conversation reply without writing a message or delivery', async () => {
    const conversationA = await createConversation(harness);
    const conversationB = await createConversation(harness);
    const targetClientMessageId = `target-${randomUUID()}`;

    const target = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationA.id}/messages`,
      ...authCookie(harness),
      payload: { clientMessageId: targetClientMessageId, text: 'Message in conversation A' },
    });
    expect(target.statusCode).toBe(202);
    const targetMessage = createMessageDataSchema.parse(envelope(target.json())).message;

    const crossClientMessageId = `cross-${randomUUID()}`;
    const cross = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationB.id}/messages`,
      ...authCookie(harness),
      payload: {
        clientMessageId: crossClientMessageId,
        text: 'Conversation B replying to conversation A',
        replyToMessageId: targetMessage.id,
      },
    });
    expect(cross.statusCode).toBe(422);
    expect(cross.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect((cross.json() as { error: { message: string } }).error.message).toContain(
      'same conversation',
    );

    const [crossMessageCount] = await harness.database
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationB.id),
          eq(messages.clientMessageId, crossClientMessageId),
        ),
      );
    expect(crossMessageCount?.count).toBe(0);
    const [crossDeliveryCount] = await harness.database
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .where(
        and(
          eq(messages.conversationId, conversationB.id),
          eq(messages.clientMessageId, crossClientMessageId),
        ),
      );
    expect(crossDeliveryCount?.count).toBe(0);

    const sameConversation = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationA.id}/messages`,
      ...authCookie(harness),
      payload: {
        clientMessageId: `same-${randomUUID()}`,
        text: 'Same-conversation reply',
        replyToMessageId: targetMessage.id,
      },
    });
    expect(sameConversation.statusCode).toBe(202);
    const reply = createMessageDataSchema.parse(envelope(sameConversation.json())).message;
    expect(reply.replyToMessageId).toBe(targetMessage.id);
    expect(reply.delivery?.state).toBe('stored');
  });

  it('collapses concurrent submissions of the same clientMessageId into one message', async () => {
    const conversation = await createConversation(harness);
    const clientMessageId = `concurrent-${randomUUID()}`;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.app.inject({
          method: 'POST',
          url: `/api/v1/conversations/${conversation.id}/messages`,
          ...authCookie(harness),
          payload: { clientMessageId, text: 'Same message, eight times' },
        }),
      ),
    );
    const statuses = attempts.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 202)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(7);
    const ids = new Set(
      attempts.map(
        (response) => createMessageDataSchema.parse(envelope(response.json())).message.id,
      ),
    );
    expect(ids.size).toBe(1);

    const [messageCount] = await harness.database
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.clientMessageId, clientMessageId),
        ),
      );
    expect(messageCount?.count).toBe(1);

    const [deliveryCount] = await harness.database
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveries)
      .innerJoin(messages, eq(messages.id, deliveries.messageId))
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.clientMessageId, clientMessageId),
        ),
      );
    expect(deliveryCount?.count).toBe(1);
  });

  it('pages messages with a stable cursor', async () => {
    const conversation = await createConversation(harness);
    for (let index = 0; index < 3; index += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversation.id}/messages`,
        ...authCookie(harness),
        payload: { clientMessageId: `page-${index}-${randomUUID()}`, text: `message ${index}` },
      });
      expect(response.statusCode).toBe(202);
    }
    const latest = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversation.id}/messages?limit=2`,
      ...authCookie(harness),
    });
    expect(latest.statusCode).toBe(200);
    const page = messageListDataSchema.parse(envelope(latest.json()));
    expect(page.messages.map((message) => message.body)).toEqual(['message 1', 'message 2']);
    expect(page.nextCursor).toBeTruthy();

    const older = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversation.id}/messages?limit=2&before=${encodeURIComponent(page.nextCursor ?? '')}`,
      ...authCookie(harness),
    });
    expect(older.statusCode).toBe(200);
    expect(messageListDataSchema.parse(envelope(older.json())).messages.map((m) => m.body)).toEqual(
      ['message 0'],
    );
  });

  it('accepts a Bridge channel callback exactly once and records a question', async () => {
    const conversation = await createConversation(harness);
    const [task] = await harness.database
      .select()
      .from(taskLinks)
      .where(eq(taskLinks.conversationId, conversation.id));
    if (!task) {
      throw new Error('task link missing');
    }
    await harness.database
      .update(taskLinks)
      .set({ upstreamTicketId: 'ticket-123', state: 'waiting_input' })
      .where(eq(taskLinks.id, task.id));

    const payload = {
      sourceEventId: `attention-reply:${randomUUID()}`,
      type: 'channel.message',
      conversationId: conversation.id,
      ticketId: 'ticket-123',
      triggerId: null,
      messageKind: 'question',
      text: 'Which branch should I target?',
      at: new Date().toISOString(),
    };
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      headers: { authorization: `Bearer ${harness.config.bridgeCallbackToken}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const created = runtimeEventDataSchema.parse(envelope(first.json()));
    expect(created.duplicate).toBe(false);
    expect(created.task?.question).toBe('Which branch should I target?');

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      headers: { authorization: `Bearer ${harness.config.bridgeCallbackToken}` },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(runtimeEventDataSchema.parse(envelope(replay.json())).duplicate).toBe(true);

    const outbound = await harness.database
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.sourceEventId, payload.sourceEventId),
        ),
      );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.kind).toBe('question');

    const questionEvents = await harness.database
      .select()
      .from(events)
      .where(and(eq(events.conversationId, conversation.id), eq(events.type, 'task.question')));
    expect(questionEvents).toHaveLength(1);
  });

  it('links a Ticket from the first Channel callback before the dispatcher projects it', async () => {
    const conversation = await createConversation(harness);
    const payload = {
      sourceEventId: `ack:${randomUUID()}`,
      type: 'channel.message',
      conversationId: conversation.id,
      ticketId: 'ticket-early',
      triggerId: null,
      messageKind: 'acknowledgement',
      text: 'On it: fixing the README typo.',
      at: new Date().toISOString(),
    };
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      headers: { authorization: `Bearer ${harness.config.bridgeCallbackToken}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const created = runtimeEventDataSchema.parse(envelope(first.json()));
    expect(created.task?.upstreamTicketId).toBe('ticket-early');
    expect(created.task?.state).toBe('queued');

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      headers: { authorization: `Bearer ${harness.config.bridgeCallbackToken}` },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(runtimeEventDataSchema.parse(envelope(replay.json())).duplicate).toBe(true);

    const rows = await harness.database
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.sourceEventId, payload.sourceEventId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it('refuses a Channel callback for a different Ticket on the same conversation', async () => {
    const conversation = await createConversation(harness);
    await harness.database
      .update(taskLinks)
      .set({ upstreamTicketId: 'ticket-right' })
      .where(eq(taskLinks.conversationId, conversation.id));
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      headers: { authorization: `Bearer ${harness.config.bridgeCallbackToken}` },
      payload: {
        sourceEventId: `ack:${randomUUID()}`,
        type: 'channel.message',
        conversationId: conversation.id,
        ticketId: 'ticket-wrong',
        triggerId: null,
        messageKind: 'acknowledgement',
        text: 'Wrong ticket.',
        at: new Date().toISOString(),
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects machine callbacks without the machine token', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/v1/runtime-events',
      payload: { type: 'channel.message' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 503 for the model catalog when no Bridge is bound', async () => {
    const conversation = await createConversation(harness);
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/repositories/${conversation.repositoryId}/models`,
      ...authCookie(harness),
    });
    expect(response.statusCode).toBe(503);
    expect(modelListDataSchema.safeParse(response.json()).success).toBe(false);
  });
});
