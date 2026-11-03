import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInboundMessageWithDelivery } from '../../src/messages';
import { conversations, deliveries, messages, owners, repositories } from '../../src/schema';
import type { Database } from '../../src/client';
import { captureError, createTestDatabase, postgresErrorCode, type TestDatabase } from './helpers';

async function seedConversation(database: Database) {
  const [owner] = await database
    .insert(owners)
    .values({ displayName: `Owner ${randomUUID()}` })
    .returning();
  if (!owner) {
    throw new Error('owner insert returned no row');
  }

  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: `sutrasky/moyu-${randomUUID()}`,
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  if (!repository) {
    throw new Error('repository insert returned no row');
  }

  const [conversation] = await database
    .insert(conversations)
    .values({
      ownerId: owner.id,
      repositoryId: repository.id,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
    })
    .returning();
  if (!conversation) {
    throw new Error('conversation insert returned no row');
  }

  return conversation;
}

async function countMessages(
  database: Database,
  conversationId: string,
  clientMessageId: string,
): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.clientMessageId, clientMessageId),
      ),
    );

  return row?.count ?? 0;
}

async function countDeliveries(database: Database, messageId: string): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(deliveries)
    .where(eq(deliveries.messageId, messageId));

  return row?.count ?? 0;
}

function postgresConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { constraint?: unknown; cause?: { constraint?: unknown } };
  if (typeof candidate.constraint === 'string') {
    return candidate.constraint;
  }
  if (typeof candidate.cause === 'object' && candidate.cause !== null) {
    const cause = candidate.cause as { constraint?: unknown };
    if (typeof cause.constraint === 'string') {
      return cause.constraint;
    }
  }
  return undefined;
}

describe('message and delivery storage on real PostgreSQL', () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (testDatabase) {
      await testDatabase.drop();
    }
  });

  it('writes the message and its pending delivery atomically', async () => {
    const conversation = await seedConversation(testDatabase.db);
    const clientMessageId = `client-${randomUUID()}`;

    const { message, delivery } = await createInboundMessageWithDelivery(testDatabase.db, {
      conversationId: conversation.id,
      clientMessageId,
      body: 'M1 atomic message',
    });

    expect(message.conversationId).toBe(conversation.id);
    expect(message.direction).toBe('inbound');
    expect(message.clientMessageId).toBe(clientMessageId);
    expect(delivery.messageId).toBe(message.id);
    expect(delivery.state).toBe('pending');
    expect(await countMessages(testDatabase.db, conversation.id, clientMessageId)).toBe(1);
    expect(await countDeliveries(testDatabase.db, message.id)).toBe(1);
  });

  it('rolls back the message when the delivery insert fails in the transaction', async () => {
    const conversation = await seedConversation(testDatabase.db);
    const clientMessageId = `rollback-${randomUUID()}`;

    const error = await captureError(() =>
      testDatabase.db.transaction(async (transaction) => {
        await transaction.insert(messages).values({
          conversationId: conversation.id,
          direction: 'inbound',
          clientMessageId,
          body: 'must not survive a failed delivery insert',
        });
        // Foreign key violation on a message that does not exist.
        await transaction.insert(deliveries).values({ messageId: randomUUID() });
      }),
    );

    expect(postgresErrorCode(error)).toBe('23503');
    expect(await countMessages(testDatabase.db, conversation.id, clientMessageId)).toBe(0);
  });

  it('rejects a duplicate clientMessageId in the same conversation', async () => {
    const conversation = await seedConversation(testDatabase.db);
    const clientMessageId = `duplicate-${randomUUID()}`;

    const first = await createInboundMessageWithDelivery(testDatabase.db, {
      conversationId: conversation.id,
      clientMessageId,
      body: 'first submission',
    });

    const error = await captureError(() =>
      createInboundMessageWithDelivery(testDatabase.db, {
        conversationId: conversation.id,
        clientMessageId,
        body: 'second submission with the same id',
      }),
    );

    expect(postgresErrorCode(error)).toBe('23505');
    expect(postgresConstraint(error)).toBe('messages_conversation_client_message_uq');
    expect(await countMessages(testDatabase.db, conversation.id, clientMessageId)).toBe(1);
    expect(await countDeliveries(testDatabase.db, first.message.id)).toBe(1);
  });

  it('allows the same clientMessageId in a different conversation', async () => {
    const firstConversation = await seedConversation(testDatabase.db);
    const secondConversation = await seedConversation(testDatabase.db);
    const clientMessageId = `cross-conversation-${randomUUID()}`;

    await createInboundMessageWithDelivery(testDatabase.db, {
      conversationId: firstConversation.id,
      clientMessageId,
      body: 'first conversation',
    });
    const second = await createInboundMessageWithDelivery(testDatabase.db, {
      conversationId: secondConversation.id,
      clientMessageId,
      body: 'second conversation',
    });

    expect(second.message.clientMessageId).toBe(clientMessageId);
    expect(await countMessages(testDatabase.db, secondConversation.id, clientMessageId)).toBe(1);
  });
});
