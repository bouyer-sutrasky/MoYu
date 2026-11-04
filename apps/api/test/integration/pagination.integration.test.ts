import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conversationListDataSchema,
  messageListDataSchema,
  type ConversationListData,
  type ConversationSummary,
  type Message,
  type MessageListData,
} from '@moyu/contracts';
import { conversations, messages, owners, repositories, sessions, type Database } from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig } from '../../src/config';
import { encodeCursor } from '../../src/lib/cursor';
import { createTestDatabase, type TestDatabase } from './helpers';

const MESSAGE_COUNT = 120;
const MESSAGE_GROUP = 6;
const CONVERSATION_A_COUNT = 105;
const CONVERSATION_GROUP = 5;
const CONVERSATION_B_COUNT = 12;

interface Harness {
  app: FastifyInstance;
  database: Database;
  cookie: string;
  ownerId: string;
  messageConversationId: string;
  messageRepositoryId: string;
  repositoryAId: string;
  repositoryBId: string;
}

function envelope(payload: unknown): unknown {
  return (payload as { data?: unknown }).data;
}

function messageTimestamp(index: number): Date {
  return new Date(
    Date.parse('2026-01-01T00:00:00.000Z') + Math.floor(index / MESSAGE_GROUP) * 60_000,
  );
}

function messageId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function conversationTimestamp(index: number): Date {
  return new Date(
    Date.parse('2026-02-01T00:00:00.000Z') - Math.floor(index / CONVERSATION_GROUP) * 60_000,
  );
}

function conversationId(prefix: string, index: number): string {
  const first = `${prefix}${'0'.repeat(7)}`.slice(0, 8);
  return `${first}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

async function seedMessages(database: Database, conversationIdValue: string): Promise<void> {
  const rows = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    id: messageId(index),
    conversationId: conversationIdValue,
    direction: 'inbound' as const,
    kind: 'user',
    body: `message ${index}`,
    createdAt: messageTimestamp(index),
  }));
  // Insert newest first so row order cannot be mistaken for the API ordering.
  await database.insert(messages).values(rows.reverse());
}

async function seedConversations(
  database: Database,
  ownerId: string,
  repositoryId: string,
  prefix: string,
  count: number,
): Promise<void> {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: conversationId(prefix, index),
    ownerId,
    repositoryId,
    mode: 'work' as const,
    executionMode: 'execute' as const,
    source: 'web' as const,
    baseBranch: 'main',
    title: `conversation ${prefix}-${index}`,
    updatedAt: conversationTimestamp(index),
  }));
  await database.insert(conversations).values(rows.reverse());
}

function messageSortKey(message: Message): string {
  return `${message.createdAt}|${message.id}`;
}

function conversationSortKey(conversation: ConversationSummary): string {
  return `${conversation.updatedAt}|${conversation.id}`;
}

function assertAscendingMessages(rows: Message[]): void {
  for (let index = 1; index < rows.length; index += 1) {
    expect(messageSortKey(rows[index - 1]!) < messageSortKey(rows[index]!)).toBe(true);
  }
}

function assertDescendingConversations(rows: ConversationSummary[]): void {
  for (let index = 1; index < rows.length; index += 1) {
    expect(conversationSortKey(rows[index - 1]!) > conversationSortKey(rows[index]!)).toBe(true);
  }
}

describe('keyset pagination on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    const database = testDatabase.db;
    const [owner] = await database
      .insert(owners)
      .values({ displayName: 'Pagination Owner' })
      .returning();
    if (!owner) throw new Error('owner insert returned no row');

    const [repositoryMessage] = await database
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: 'Bouyer12/pagination-messages',
        defaultBranch: 'main',
        status: 'active',
      })
      .returning();
    const [repositoryA] = await database
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: 'Bouyer12/pagination-a',
        defaultBranch: 'main',
        status: 'active',
      })
      .returning();
    const [repositoryB] = await database
      .insert(repositories)
      .values({
        ownerId: owner.id,
        fullName: 'Bouyer12/pagination-b',
        defaultBranch: 'main',
        status: 'active',
      })
      .returning();
    if (!repositoryMessage || !repositoryA || !repositoryB) {
      throw new Error('repository insert returned no row');
    }

    const [conversation] = await database
      .insert(conversations)
      .values({
        ownerId: owner.id,
        repositoryId: repositoryMessage.id,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
        title: 'Pagination messages',
      })
      .returning();
    if (!conversation) throw new Error('conversation insert returned no row');

    await seedMessages(database, conversation.id);
    await seedConversations(database, owner.id, repositoryA.id, 'a', CONVERSATION_A_COUNT);
    await seedConversations(database, owner.id, repositoryB.id, 'b', CONVERSATION_B_COUNT);

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
      ownerId: owner.id,
      messageConversationId: conversation.id,
      messageRepositoryId: repositoryMessage.id,
      repositoryAId: repositoryA.id,
      repositoryBId: repositoryB.id,
    };
  }, 60_000);

  afterAll(async () => {
    await harness?.app.close();
    await testDatabase?.drop();
  });

  async function getMessages(query: string) {
    return harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${harness.messageConversationId}/messages${query}`,
      headers: { cookie: harness.cookie },
    });
  }

  async function pageMessages(query: string): Promise<MessageListData> {
    const response = await getMessages(query);
    expect(response.statusCode).toBe(200);
    return messageListDataSchema.parse(envelope(response.json()));
  }

  it('pages the full message history through opaque before cursors with timestamp ties', async () => {
    const expected = Array.from({ length: MESSAGE_COUNT }, (_, index) => messageId(index));
    const collected: Message[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const suffix = cursor ? `?limit=7&before=${encodeURIComponent(cursor)}` : '?limit=7';
      const page = await pageMessages(suffix);
      assertAscendingMessages(page.messages);
      expect(page.hasNewer).toBe(false);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      if (cursor) {
        expect(page.messages.length).toBeGreaterThan(0);
      }
      collected.unshift(...page.messages);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(30);
    } while (cursor);

    expect(pages).toBe(Math.ceil(MESSAGE_COUNT / 7));
    expect(collected.map((message) => message.id)).toEqual(expected);
    expect(new Set(collected.map((message) => message.id)).size).toBe(MESSAGE_COUNT);
  });

  it('keeps ties intact, so every message at a shared timestamp is returned exactly once', async () => {
    const expected = Array.from({ length: MESSAGE_COUNT }, (_, index) => messageId(index));
    // 120 messages in groups of 6. A page of 7 crosses a group boundary, and the
    // returned cursor must point at the last row of the older group.
    const first = await pageMessages('?limit=7');
    expect(first.messages.map((message) => message.id)).toEqual(expected.slice(113));

    const older = await pageMessages(
      `?limit=7&before=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    expect(older.messages.map((message) => message.id)).toEqual(expected.slice(106, 113));

    const tied = await pageMessages(
      `?limit=3&before=${encodeURIComponent(older.nextCursor ?? '')}`,
    );
    expect(tied.messages.map((message) => message.id)).toEqual(expected.slice(103, 106));
    expect(tied.hasMore).toBe(true);
  });

  it('accepts a legacy ISO timestamp as a before cursor', async () => {
    const boundary = messageTimestamp(30);
    const expected = Array.from({ length: 30 }, (_, index) => messageId(index));
    const collected: Message[] = [];
    let cursor: string | null = null;

    do {
      const query = cursor
        ? `?limit=7&before=${encodeURIComponent(cursor)}`
        : `?limit=7&before=${encodeURIComponent(boundary.toISOString())}`;
      const page = await pageMessages(query);
      assertAscendingMessages(page.messages);
      collected.unshift(...page.messages);
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected.map((message) => message.id)).toEqual(expected);
  });

  it('preserves tie groups whose PostgreSQL timestamp has microseconds', async () => {
    const [conversation] = await harness.database
      .insert(conversations)
      .values({
        ownerId: harness.ownerId,
        repositoryId: harness.messageRepositoryId,
        mode: 'work',
        executionMode: 'execute',
        baseBranch: 'main',
        title: 'Microsecond ties',
      })
      .returning();
    if (!conversation) throw new Error('conversation insert returned no row');

    const expected: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const id = messageId(1000 + index);
      expected.push(id);
      const group = Math.floor(index / 3);
      const timestamp = `2026-03-01T00:00:${String(group).padStart(2, '0')}.123456Z`;
      await harness.database.execute(
        sql`insert into messages (id, conversation_id, direction, kind, body, created_at)
            values (${id}, ${conversation.id}, 'inbound', 'user', ${`micro ${index}`}, ${timestamp}::timestamptz)`,
      );
    }

    const collected: Message[] = [];
    let cursor: string | null = null;
    do {
      const query = cursor ? `?limit=2&before=${encodeURIComponent(cursor)}` : '?limit=2';
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversation.id}/messages${query}`,
        headers: { cookie: harness.cookie },
      });
      expect(response.statusCode).toBe(200);
      const page = messageListDataSchema.parse(envelope(response.json()));
      assertAscendingMessages(page.messages);
      collected.unshift(...page.messages);
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected.map((message) => message.id)).toEqual(expected);
  });

  it('rejects malformed, mutually exclusive and foreign cursors', async () => {
    const malformed = await getMessages('?before=not-a-cursor');
    expect(malformed.statusCode).toBe(422);

    const both = await getMessages(
      '?limit=2&before=2026-01-01T00:00:00.000Z&after=2026-01-01T00:00:00.000Z',
    );
    expect(both.statusCode).toBe(422);

    const foreign = encodeCursor({
      kind: 'message',
      scope: randomUUID(),
      timestamp: messageTimestamp(10),
      id: messageId(10),
    });
    const foreignResponse = await getMessages(`?before=${encodeURIComponent(foreign)}`);
    expect(foreignResponse.statusCode).toBe(422);

    const wrongKind = encodeCursor({
      kind: 'conversation',
      scope: harness.messageConversationId,
      timestamp: messageTimestamp(10),
      id: messageId(10),
    });
    const wrongKindResponse = await getMessages(`?before=${encodeURIComponent(wrongKind)}`);
    expect(wrongKindResponse.statusCode).toBe(422);
  });

  it('merges newer messages in ascending pages using after and newerCursor', async () => {
    const latest = await pageMessages('?limit=7');
    const anchor = latest.newerCursor;
    expect(anchor).toBeTruthy();

    const newerRows = Array.from({ length: 9 }, (_, offset) => {
      const index = MESSAGE_COUNT + offset;
      const timestamp =
        offset < 3
          ? messageTimestamp(MESSAGE_COUNT - 1)
          : new Date(
              Date.parse('2026-01-01T00:00:00.000Z') + (20 + Math.floor((offset - 3) / 3)) * 60_000,
            );
      return {
        id: messageId(index),
        conversationId: harness.messageConversationId,
        direction: 'inbound' as const,
        kind: 'user',
        body: `new message ${index}`,
        createdAt: timestamp,
      };
    });
    await harness.database.insert(messages).values(newerRows);

    const expected = newerRows
      .map((row) => ({ id: row.id, createdAt: row.createdAt.toISOString() }))
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id.localeCompare(right.id)
          : left.createdAt.localeCompare(right.createdAt),
      )
      .map((row) => row.id);

    const collected: Message[] = [];
    let cursor: string | null = anchor;
    let pages = 0;
    while (cursor) {
      const page = await pageMessages(`?limit=2&after=${encodeURIComponent(cursor)}`);
      assertAscendingMessages(page.messages);
      expect(page.nextCursor).toBeNull();
      expect(page.hasMore).toBe(false);
      collected.push(...page.messages);
      cursor = page.newerCursor;
      pages += 1;
      if (!page.hasNewer) {
        break;
      }
      expect(cursor).toBeTruthy();
      expect(pages).toBeLessThanOrEqual(10);
    }

    expect(collected.map((message) => message.id)).toEqual(expected);
    expect(new Set(collected.map((message) => message.id)).size).toBe(expected.length);
    expect(pages).toBeGreaterThan(1);
  });

  it('respects an id tie-break when after starts in the middle of a timestamp group', async () => {
    const expected = Array.from({ length: MESSAGE_COUNT + 9 }, (_, index) => {
      const row = {
        id: messageId(index),
        createdAt: (index < MESSAGE_COUNT
          ? messageTimestamp(index)
          : index < MESSAGE_COUNT + 3
            ? messageTimestamp(MESSAGE_COUNT - 1)
            : new Date(
                Date.parse('2026-01-01T00:00:00.000Z') +
                  (20 + Math.floor((index - MESSAGE_COUNT - 3) / 3)) * 60_000,
              )
        ).toISOString(),
      };
      return row;
    })
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id.localeCompare(right.id)
          : left.createdAt.localeCompare(right.createdAt),
      )
      .map((row) => row.id);

    const anchorIndex = expected.indexOf(messageId(70));
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    const anchorMessage = await harness.database
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, messageId(70)))
      .limit(1);
    expect(anchorMessage).toHaveLength(1);
    const anchor = encodeCursor({
      kind: 'message',
      scope: harness.messageConversationId,
      timestamp: anchorMessage[0]!.createdAt,
      id: anchorMessage[0]!.id,
    });
    const expectedAfter = expected.slice(anchorIndex + 1);

    const collected: Message[] = [];
    let cursor: string | null = anchor;
    while (cursor) {
      const page = await pageMessages(`?limit=3&after=${encodeURIComponent(cursor)}`);
      assertAscendingMessages(page.messages);
      collected.push(...page.messages);
      cursor = page.hasNewer ? page.newerCursor : null;
    }

    expect(collected.map((message) => message.id)).toEqual(expectedAfter);
  });

  async function getConversations(query: string) {
    return harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations${query}`,
      headers: { cookie: harness.cookie },
    });
  }

  async function pageConversations(query: string): Promise<ConversationListData> {
    const response = await getConversations(query);
    expect(response.statusCode).toBe(200);
    return conversationListDataSchema.parse(envelope(response.json()));
  }

  it('pages the owner conversation list with nextCursor and no duplicates', async () => {
    const expected = Array.from({ length: CONVERSATION_A_COUNT }, (_, index) => ({
      id: conversationId('a', index),
      updatedAt: conversationTimestamp(index),
    }))
      .sort((left, right) =>
        left.updatedAt.getTime() === right.updatedAt.getTime()
          ? right.id.localeCompare(left.id)
          : right.updatedAt.getTime() - left.updatedAt.getTime(),
      )
      .map((row) => row.id);

    const collected: ConversationSummary[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix = cursor
        ? `?repositoryId=${harness.repositoryAId}&limit=7&cursor=${encodeURIComponent(cursor)}`
        : `?repositoryId=${harness.repositoryAId}&limit=7`;
      const page = await pageConversations(suffix);
      assertDescendingConversations(page.conversations);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      collected.push(...page.conversations);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(30);
    } while (cursor);

    expect(pages).toBe(Math.ceil(CONVERSATION_A_COUNT / 7));
    expect(collected.map((conversation) => conversation.id)).toEqual(expected);
    expect(new Set(collected.map((conversation) => conversation.id)).size).toBe(
      CONVERSATION_A_COUNT,
    );
  });

  it('never applies a cursor from another repository and keeps repositories isolated', async () => {
    const firstA = await pageConversations(`?repositoryId=${harness.repositoryAId}&limit=7`);
    expect(firstA.nextCursor).toBeTruthy();

    const crossRepository = await getConversations(
      `?repositoryId=${harness.repositoryBId}&limit=7&cursor=${encodeURIComponent(firstA.nextCursor ?? '')}`,
    );
    expect(crossRepository.statusCode).toBe(422);

    const firstB = await pageConversations(`?repositoryId=${harness.repositoryBId}&limit=7`);
    const crossBack = await getConversations(
      `?repositoryId=${harness.repositoryAId}&limit=7&cursor=${encodeURIComponent(firstB.nextCursor ?? '')}`,
    );
    expect(crossBack.statusCode).toBe(422);

    const collectedB: ConversationSummary[] = [];
    let cursor: string | null = null;
    do {
      const suffix = cursor
        ? `?repositoryId=${harness.repositoryBId}&limit=7&cursor=${encodeURIComponent(cursor)}`
        : `?repositoryId=${harness.repositoryBId}&limit=7`;
      const page = await pageConversations(suffix);
      assertDescendingConversations(page.conversations);
      expect(
        page.conversations.every(
          (conversation) => conversation.repositoryId === harness.repositoryBId,
        ),
      ).toBe(true);
      collectedB.push(...page.conversations);
      cursor = page.nextCursor;
    } while (cursor);

    expect(collectedB).toHaveLength(CONVERSATION_B_COUNT);
    const allA = Array.from({ length: CONVERSATION_A_COUNT }, (_, index) =>
      conversationId('a', index),
    );
    expect(collectedB.some((conversation) => allA.includes(conversation.id))).toBe(false);

    const everyOwnerRepository = await pageConversations('?limit=100');
    expect(
      everyOwnerRepository.conversations.some((row) => row.repositoryId === harness.repositoryAId),
    ).toBe(true);
    expect(
      everyOwnerRepository.conversations.some((row) => row.repositoryId === harness.repositoryBId),
    ).toBe(true);

    const ownerCursor = everyOwnerRepository.nextCursor;
    if (ownerCursor) {
      const ownerScoped = await getConversations(
        `?repositoryId=${harness.repositoryAId}&limit=10&cursor=${encodeURIComponent(ownerCursor)}`,
      );
      expect(ownerScoped.statusCode).toBe(422);
    }
  });
});
