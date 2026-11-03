import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../../src/client';
import { migrateDatabase } from '../../src/migrate';
import { conversations, messages, owners, repositories, taskLinks } from '../../src/schema';
import {
  captureError,
  createTestDatabase,
  createTestDatabaseUpTo,
  postgresErrorCode,
  type TestDatabase,
} from './helpers';

const CHECKS_FOLDER = fileURLToPath(new URL('../../sql/checks/', import.meta.url));

interface SeededData {
  repositoryAId: string;
  repositoryBId: string;
  conversationAId: string;
  conversationBId: string;
  messageAId: string;
  validReplyId: string;
  nullReplyId: string;
}

async function seedConversations(database: Database): Promise<SeededData> {
  const [owner] = await database
    .insert(owners)
    .values({ displayName: `Integrity Owner ${randomUUID()}` })
    .returning();
  if (!owner) {
    throw new Error('owner insert returned no row');
  }

  const [repositoryA] = await database
    .insert(repositories)
    .values({ ownerId: owner.id, fullName: `sutrasky/repo-a-${randomUUID()}`, status: 'active' })
    .returning();
  const [repositoryB] = await database
    .insert(repositories)
    .values({ ownerId: owner.id, fullName: `sutrasky/repo-b-${randomUUID()}`, status: 'active' })
    .returning();
  if (!repositoryA || !repositoryB) {
    throw new Error('repository insert returned no row');
  }

  const [conversationA] = await database
    .insert(conversations)
    .values({
      ownerId: owner.id,
      repositoryId: repositoryA.id,
      baseBranch: 'main',
    })
    .returning();
  const [conversationB] = await database
    .insert(conversations)
    .values({
      ownerId: owner.id,
      repositoryId: repositoryB.id,
      baseBranch: 'main',
    })
    .returning();
  if (!conversationA || !conversationB) {
    throw new Error('conversation insert returned no row');
  }

  const messageAId = await insertMessage(database, {
    conversationId: conversationA.id,
    body: 'message in conversation A',
  });
  const validReplyId = await insertMessage(database, {
    conversationId: conversationA.id,
    body: 'same-conversation reply',
    replyToMessageId: messageAId,
  });
  const nullReplyId = await insertMessage(database, {
    conversationId: conversationA.id,
    body: 'message without a reply target',
  });
  await database.insert(taskLinks).values({
    conversationId: conversationA.id,
    repositoryId: repositoryA.id,
    state: 'pending_admission',
    baseBranch: 'main',
  });

  return {
    repositoryAId: repositoryA.id,
    repositoryBId: repositoryB.id,
    conversationAId: conversationA.id,
    conversationBId: conversationB.id,
    messageAId,
    validReplyId,
    nullReplyId,
  };
}

async function insertMessage(
  database: Database,
  input: { conversationId: string; body: string; replyToMessageId?: string | null },
): Promise<string> {
  const [message] = await database
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      direction: 'inbound',
      clientMessageId: `client-${randomUUID()}`,
      body: input.body,
      replyToMessageId: input.replyToMessageId ?? null,
      source: 'web',
    })
    .returning({ id: messages.id });
  if (!message) {
    throw new Error('message insert returned no row');
  }
  return message.id;
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

async function runCheck(
  database: TestDatabase,
  file: string,
): Promise<{ violationCount: number; violations: Record<string, unknown>[] }> {
  const text = await readFile(path.join(CHECKS_FOLDER, file), 'utf8');
  const raw = (await database.pool.query(text)) as unknown as QueryResult[] | QueryResult;
  const results = Array.isArray(raw) ? raw : [raw];
  const row = results.find((result) => result.rows.length > 0)?.rows[0];
  if (!row) {
    throw new Error(`${file} returned no result row`);
  }
  return {
    violationCount: Number(row.violation_count),
    violations: row.violations as Record<string, unknown>[],
  };
}

describe('message reply and task link integrity on real PostgreSQL', () => {
  describe('on the 0003 schema with existing data', () => {
    let testDatabase: TestDatabase;
    let seeded: SeededData;
    let crossConversationReplyId: string;
    let crossRepositoryTaskLinkId: string;

    beforeAll(async () => {
      testDatabase = await createTestDatabaseUpTo(3);
      seeded = await seedConversations(testDatabase.db);

      // Reproduce the two defects on the latest pre-fix migration.
      crossConversationReplyId = await insertMessage(testDatabase.db, {
        conversationId: seeded.conversationBId,
        body: 'conversation B replies to conversation A',
        replyToMessageId: seeded.messageAId,
      });
      const [crossRepositoryTask] = await testDatabase.db
        .insert(taskLinks)
        .values({
          conversationId: seeded.conversationBId,
          repositoryId: seeded.repositoryAId,
          state: 'pending_admission',
          baseBranch: 'main',
        })
        .returning({ id: taskLinks.id });
      if (!crossRepositoryTask) {
        throw new Error('task link insert returned no row');
      }
      crossRepositoryTaskLinkId = crossRepositoryTask.id;
    }, 60_000);

    afterAll(async () => {
      if (testDatabase) {
        await testDatabase.drop();
      }
    });

    it('accepts both invalid writes before the fix', async () => {
      const [reply] = await testDatabase.db
        .select({ conversationId: messages.conversationId })
        .from(messages)
        .where(eq(messages.id, crossConversationReplyId));
      expect(reply?.conversationId).toBe(seeded.conversationBId);

      const [task] = await testDatabase.db
        .select({ repositoryId: taskLinks.repositoryId })
        .from(taskLinks)
        .where(eq(taskLinks.id, crossRepositoryTaskLinkId));
      expect(task?.repositoryId).toBe(seeded.repositoryAId);
    });

    it('reports each defect with its record ids through the read-only checks', async () => {
      const replies = await runCheck(testDatabase, 'cross-conversation-replies.sql');
      expect(replies.violationCount).toBe(1);
      expect(replies.violations).toEqual([
        {
          message_id: crossConversationReplyId,
          message_conversation_id: seeded.conversationBId,
          reply_to_message_id: seeded.messageAId,
          reply_to_conversation_id: seeded.conversationAId,
        },
      ]);

      const taskLinksReport = await runCheck(testDatabase, 'cross-repository-task-links.sql');
      expect(taskLinksReport.violationCount).toBe(1);
      expect(taskLinksReport.violations).toEqual([
        {
          task_link_id: crossRepositoryTaskLinkId,
          conversation_id: seeded.conversationBId,
          task_repository_id: seeded.repositoryAId,
          conversation_repository_id: seeded.repositoryBId,
          upstream_ticket_id: null,
          state: 'pending_admission',
        },
      ]);
    });

    it('refuses to validate the new constraints until the stored defects are remediated', async () => {
      const error = await captureError(() => migrateDatabase(testDatabase.db));

      expect(postgresErrorCode(error)).toBe('23503');
      expect([
        'messages_reply_same_conversation_fk',
        'task_links_conversation_repository_fk',
      ]).toContain(postgresConstraint(error));
      const [applied] = await testDatabase.pool
        .query(
          "select count(*)::int as count from pg_indexes where indexname = 'messages_id_conversation_uq'",
        )
        .then((result) => result.rows);
      expect(applied?.count).toBe(0);

      // Isolated test database only: remove the reviewed defects, then upgrade.
      await testDatabase.db.delete(messages).where(eq(messages.id, crossConversationReplyId));
      await testDatabase.db.delete(taskLinks).where(eq(taskLinks.id, crossRepositoryTaskLinkId));
      await migrateDatabase(testDatabase.db);
    }, 60_000);

    it('keeps valid rows and enforces both invariants after the upgrade', async () => {
      const [existing] = await testDatabase.db
        .select({ replyToMessageId: messages.replyToMessageId })
        .from(messages)
        .where(eq(messages.id, seeded.validReplyId));
      expect(existing?.replyToMessageId).toBe(seeded.messageAId);
      const [nullReply] = await testDatabase.db
        .select({ replyToMessageId: messages.replyToMessageId })
        .from(messages)
        .where(eq(messages.id, seeded.nullReplyId));
      expect(nullReply?.replyToMessageId).toBeNull();
      const [task] = await testDatabase.db
        .select({ repositoryId: taskLinks.repositoryId })
        .from(taskLinks)
        .where(eq(taskLinks.conversationId, seeded.conversationAId));
      expect(task?.repositoryId).toBe(seeded.repositoryAId);

      const crossConversationError = await captureError(() =>
        insertMessage(testDatabase.db, {
          conversationId: seeded.conversationBId,
          body: 'still a cross-conversation reply',
          replyToMessageId: seeded.messageAId,
        }),
      );
      expect(postgresErrorCode(crossConversationError)).toBe('23503');
      expect(postgresConstraint(crossConversationError)).toBe(
        'messages_reply_same_conversation_fk',
      );

      const crossRepositoryError = await captureError(() =>
        testDatabase.db.insert(taskLinks).values({
          conversationId: seeded.conversationBId,
          repositoryId: seeded.repositoryAId,
          state: 'pending_admission',
          baseBranch: 'main',
        }),
      );
      expect(postgresErrorCode(crossRepositoryError)).toBe('23503');
      expect(postgresConstraint(crossRepositoryError)).toBe(
        'task_links_conversation_repository_fk',
      );
    });

    it('still allows same-conversation replies, empty reply references and consistent links', async () => {
      await expect(
        insertMessage(testDatabase.db, {
          conversationId: seeded.conversationAId,
          body: 'another same-conversation reply',
          replyToMessageId: seeded.validReplyId,
        }),
      ).resolves.toBeTruthy();
      await expect(
        insertMessage(testDatabase.db, {
          conversationId: seeded.conversationBId,
          body: 'no reply target in conversation B',
        }),
      ).resolves.toBeTruthy();
      await expect(
        testDatabase.db.insert(taskLinks).values({
          conversationId: seeded.conversationBId,
          repositoryId: seeded.repositoryBId,
          state: 'pending_admission',
          baseBranch: 'main',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects moving a reply or task link across conversations or repositories', async () => {
      const replyId = await insertMessage(testDatabase.db, {
        conversationId: seeded.conversationAId,
        body: 'reply that must stay in conversation A',
        replyToMessageId: seeded.validReplyId,
      });
      const messageMoveError = await captureError(() =>
        testDatabase.db
          .update(messages)
          .set({ conversationId: seeded.conversationBId })
          .where(eq(messages.id, replyId)),
      );
      expect(postgresErrorCode(messageMoveError)).toBe('23503');
      expect(postgresConstraint(messageMoveError)).toBe('messages_reply_same_conversation_fk');

      const [task] = await testDatabase.db
        .select({ id: taskLinks.id })
        .from(taskLinks)
        .where(eq(taskLinks.conversationId, seeded.conversationBId));
      if (!task) {
        throw new Error('conversation B task link is missing');
      }
      const taskMoveError = await captureError(() =>
        testDatabase.db
          .update(taskLinks)
          .set({ repositoryId: seeded.repositoryAId })
          .where(eq(taskLinks.id, task.id)),
      );
      expect(postgresErrorCode(taskMoveError)).toBe('23503');
      expect(postgresConstraint(taskMoveError)).toBe('task_links_conversation_repository_fk');
    });

    it('keeps ON DELETE SET NULL for a deleted reply target', async () => {
      await testDatabase.db.delete(messages).where(eq(messages.id, seeded.messageAId));
      const [reply] = await testDatabase.db
        .select({ replyToMessageId: messages.replyToMessageId })
        .from(messages)
        .where(eq(messages.id, seeded.validReplyId));
      expect(reply?.replyToMessageId).toBeNull();
    });

    it('reports no defects through the read-only checks after the fix', async () => {
      const replies = await runCheck(testDatabase, 'cross-conversation-replies.sql');
      expect(replies.violationCount).toBe(0);
      expect(replies.violations).toEqual([]);
      const taskLinksReport = await runCheck(testDatabase, 'cross-repository-task-links.sql');
      expect(taskLinksReport.violationCount).toBe(0);
      expect(taskLinksReport.violations).toEqual([]);
    });
  });

  describe('on a fresh 0004 database', () => {
    let testDatabase: TestDatabase;

    beforeAll(async () => {
      testDatabase = await createTestDatabase();
    }, 60_000);

    afterAll(async () => {
      if (testDatabase) {
        await testDatabase.drop();
      }
    });

    it('creates the composite keys and keeps the reply delete action scoped to the reply column', async () => {
      const rows = await testDatabase.pool
        .query(
          `select conname, confdeltype, confdelsetcols
             from pg_constraint
            where conname in ('messages_reply_same_conversation_fk', 'task_links_conversation_repository_fk')
            order by conname`,
        )
        .then((result) => result.rows);

      expect(rows).toHaveLength(2);
      const messageConstraint = rows.find(
        (row) => row.conname === 'messages_reply_same_conversation_fk',
      );
      expect(messageConstraint?.confdeltype).toBe('n');
      expect(messageConstraint?.confdelsetcols).toHaveLength(1);
      const taskConstraint = rows.find(
        (row) => row.conname === 'task_links_conversation_repository_fk',
      );
      expect(taskConstraint?.confdeltype).toBe('c');
    });
  });
});
