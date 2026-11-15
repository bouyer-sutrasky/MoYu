import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attachmentUploadDataSchema } from '@moyu/contracts';
import {
  artifacts,
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

const REPOSITORY = 'Bouyer12/p1bp-merge-test';
const ISSUE_URL = `https://github.com/${REPOSITORY}/issues/1`;
const TEXT_BYTES = Buffer.from('P1-B prime attachment bytes\nsecond line\n', 'utf8');

let database: Database;
let app: FastifyInstance;
let testDatabase: TestDatabase;
let storageDir: string;
let cookieName: string;
let cookie: string;
let repositoryId: string;
let githubConversationId: string;
let githubTaskId: string;
let otherOwnerCookie: string;
let otherConversationId: string;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function multipart(file: { filename: string; contentType: string; bytes: Buffer }): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = `----moyu-p1bp-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, file.bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function uploadAttachment(
  asCookie: string,
  conversationId: string,
  filename = 'p1bp.txt',
): Promise<string> {
  const body = multipart({ filename, contentType: 'text/plain', bytes: TEXT_BYTES });
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${conversationId}/attachments`,
    headers: { cookie: asCookie, 'content-type': body.contentType },
    payload: body.payload,
  });
  expect(response.statusCode).toBe(201);
  return attachmentUploadDataSchema.parse((response.json() as { data: unknown }).data).attachment
    .id;
}

/** A fresh Web conversation with a pending-admission task, like the Web first entry. */
async function createWebConversation(): Promise<string> {
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
      title: null,
    })
    .returning();
  await database.insert(taskLinks).values({
    conversationId: web!.id,
    repositoryId,
    state: 'pending_admission',
    baseBranch: 'main',
    executionMode: 'execute',
  });
  return web!.id;
}

async function send(
  conversationId: string,
  payload: { clientMessageId: string; text: string; attachmentIds?: string[] },
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${conversationId}/messages`,
    headers: { cookie },
    payload,
  });
}

async function messageCount(conversationIds: string[]): Promise<number> {
  const rows = await database
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.conversationId, conversationIds));
  return rows.length;
}

/** Only this test's attachments, so earlier tests in the shared target do not leak in. */
async function attachmentRowsByIds(ids: string[]) {
  return database
    .select({
      id: artifacts.id,
      conversationId: artifacts.conversationId,
      messageId: artifacts.messageId,
      sha256: artifacts.sha256,
    })
    .from(artifacts)
    .where(and(eq(artifacts.type, 'attachment'), inArray(artifacts.id, ids)))
    .orderBy(artifacts.createdAt, artifacts.id);
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  database = testDatabase.db;
  storageDir = mkdtempSync(join(tmpdir(), 'moyu-p1bp-'));
  const [owner] = await database.insert(owners).values({ displayName: 'P1BP Owner' }).returning();
  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner!.id,
      fullName: REPOSITORY,
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  repositoryId = repository!.id;
  const [otherOwner] = await database
    .insert(owners)
    .values({ displayName: 'P1BP Other Owner' })
    .returning();
  const [otherRepository] = await database
    .insert(repositories)
    .values({
      ownerId: otherOwner!.id,
      fullName: 'Bouyer12/p1bp-other',
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  const [otherConversation] = await database
    .insert(conversations)
    .values({
      ownerId: otherOwner!.id,
      repositoryId: otherRepository!.id,
      mode: 'work',
      executionMode: 'execute',
      source: 'web',
      baseBranch: 'main',
    })
    .returning();
  otherConversationId = otherConversation!.id;

  const token = randomToken(32);
  const otherToken = randomToken(32);
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: testDatabase.url,
    ARTIFACT_STORAGE_DIR: storageDir,
    WEBAUTHN_ORIGIN: 'http://127.0.0.1:3210',
    WEBAUTHN_RP_ID: '127.0.0.1',
  });
  cookieName = sessionCookieName(config);
  await database.insert(sessions).values([
    {
      ownerId: owner!.id,
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    {
      ownerId: otherOwner!.id,
      tokenHash: hashSecret(otherToken),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  ]);
  cookie = `${cookieName}=${token}`;
  otherOwnerCookie = `${cookieName}=${otherToken}`;

  const [github] = await database
    .insert(conversations)
    .values({
      ownerId: owner!.id,
      repositoryId,
      mode: 'work',
      executionMode: 'execute',
      source: 'github',
      externalKey: 'github:1',
      externalUrl: ISSUE_URL,
      baseBranch: 'main',
      title: 'Imported Issue',
    })
    .returning();
  githubConversationId = github!.id;
  const [githubTask] = await database
    .insert(taskLinks)
    .values({
      conversationId: githubConversationId,
      repositoryId,
      upstreamTicketId: 'github-ticket-1',
      state: 'running',
      baseBranch: 'main',
      executionMode: 'execute',
    })
    .returning();
  githubTaskId = githubTask!.id;

  app = buildApp({ config, database });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await testDatabase?.drop();
  rmSync(storageDir, { recursive: true, force: true });
});

describe('P1-B prime: an attachment-bearing first Web message merges into the imported Issue', () => {
  it('moves the attachment into the target conversation in the same transaction', async () => {
    const webConversationId = await createWebConversation();
    const attachmentId = await uploadAttachment(cookie, webConversationId);

    const response = await send(webConversationId, {
      clientMessageId: `p1bp-merge-${randomUUID()}`,
      text: `Same requirement: ${ISSUE_URL}`,
      attachmentIds: [attachmentId],
    });
    console.log('merge response:', response.statusCode, JSON.stringify(response.json()));
    expect(response.statusCode).toBe(202);
    const body = response.json() as {
      data: { message: { id: string; conversationId: string } };
    };
    expect(body.data.message.conversationId).toBe(githubConversationId);

    const [row] = await database
      .select({
        conversationId: artifacts.conversationId,
        messageId: artifacts.messageId,
        sha256: artifacts.sha256,
      })
      .from(artifacts)
      .where(eq(artifacts.id, attachmentId));
    expect(row?.conversationId).toBe(githubConversationId);
    expect(row?.messageId).toBe(body.data.message.id);
    expect(row?.sha256).toBe(sha256(TEXT_BYTES));

    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { cookie },
    });
    console.log(
      'download:',
      download.statusCode,
      'sha256=',
      sha256(download.rawPayload),
      'expected=',
      sha256(TEXT_BYTES),
    );
    expect(download.statusCode).toBe(200);
    expect(sha256(download.rawPayload)).toBe(sha256(TEXT_BYTES));

    const [source] = await database
      .select({ mergedInto: conversations.mergedIntoConversationId })
      .from(conversations)
      .where(eq(conversations.id, webConversationId));
    expect(source?.mergedInto).toBe(githubConversationId);
    expect(githubTaskId).toBeTruthy();
  });

  it('still refuses an attachment that belongs to another owner', async () => {
    const foreignAttachmentId = await uploadAttachment(
      otherOwnerCookie,
      otherConversationId,
      'foreign.txt',
    );
    const webConversationId = await createWebConversation();
    const messagesBefore = await messageCount([webConversationId, githubConversationId]);

    const response = await send(webConversationId, {
      clientMessageId: `p1bp-foreign-${randomUUID()}`,
      text: `Same requirement: ${ISSUE_URL}`,
      attachmentIds: [foreignAttachmentId],
    });
    console.log('foreign response:', response.statusCode, JSON.stringify(response.json()));
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { message: string } }).error.message).toContain(
      'attachmentIds 必须是本会话尚未发送的附件',
    );

    const [source] = await database
      .select({ mergedInto: conversations.mergedIntoConversationId })
      .from(conversations)
      .where(eq(conversations.id, webConversationId));
    expect(source?.mergedInto).toBeNull();
    expect(await messageCount([webConversationId, githubConversationId])).toBe(messagesBefore);
    const [foreign] = await database
      .select({ conversationId: artifacts.conversationId, messageId: artifacts.messageId })
      .from(artifacts)
      .where(eq(artifacts.id, foreignAttachmentId));
    expect(foreign?.conversationId).toBe(otherConversationId);
    expect(foreign?.messageId).toBeNull();
  });

  it('rolls the whole merge back when one attachment cannot be sent', async () => {
    const webConversationId = await createWebConversation();
    const boundAttachmentId = await uploadAttachment(cookie, webConversationId, 'bound.txt');
    const draftAttachmentId = await uploadAttachment(cookie, webConversationId, 'draft.txt');
    // Bind the first attachment to an ordinary message on the source conversation.
    const ordinary = await send(webConversationId, {
      clientMessageId: `p1bp-ordinary-${randomUUID()}`,
      text: 'Ordinary source message',
      attachmentIds: [boundAttachmentId],
    });
    expect(ordinary.statusCode).toBe(202);

    const ids = [boundAttachmentId, draftAttachmentId];
    const before = {
      messages: await messageCount([webConversationId, githubConversationId]),
      attachments: await attachmentRowsByIds(ids),
    };
    console.log(
      'rollback before:',
      JSON.stringify({ messages: before.messages, attachments: before.attachments }),
    );
    const response = await send(webConversationId, {
      clientMessageId: `p1bp-rollback-${randomUUID()}`,
      text: `Same requirement: ${ISSUE_URL}`,
      attachmentIds: [boundAttachmentId, draftAttachmentId],
    });
    expect(response.statusCode).toBe(422);
    console.log('rollback response:', response.statusCode, JSON.stringify(response.json()));

    const after = {
      messages: await messageCount([webConversationId, githubConversationId]),
      attachments: await attachmentRowsByIds(ids),
    };
    console.log(
      'rollback after:',
      JSON.stringify({ messages: after.messages, attachments: after.attachments }),
    );
    expect(after.messages).toBe(before.messages);
    expect(after.attachments).toEqual(before.attachments);
    expect(after.attachments.map((row) => row.conversationId)).toEqual([
      webConversationId,
      webConversationId,
    ]);
    const [source] = await database
      .select({ mergedInto: conversations.mergedIntoConversationId })
      .from(conversations)
      .where(eq(conversations.id, webConversationId));
    expect(source?.mergedInto).toBeNull();
    expect(after.attachments.find((row) => row.id === draftAttachmentId)?.messageId).toBeNull();
  });

  it('replays the same clientMessageId without moving the attachment twice', async () => {
    const webConversationId = await createWebConversation();
    const attachmentId = await uploadAttachment(cookie, webConversationId, 'retry.txt');
    const payload = {
      clientMessageId: `p1bp-retry-${randomUUID()}`,
      text: `Same requirement: ${ISSUE_URL}`,
      attachmentIds: [attachmentId],
    };
    const first = await send(webConversationId, payload);
    console.log('merge response:', first.statusCode, JSON.stringify(first.json()));
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as { data: { message: { id: string } } };
    const attachmentsAfterFirst = await attachmentRowsByIds([attachmentId]);

    const retry = await send(webConversationId, payload);
    console.log('retry response:', retry.statusCode, JSON.stringify(retry.json()));
    expect(retry.statusCode).toBe(200);
    const retryBody = retry.json() as {
      data: { duplicate: boolean; message: { id: string; conversationId: string } };
    };
    expect(retryBody.data.duplicate).toBe(true);
    expect(retryBody.data.message.id).toBe(firstBody.data.message.id);
    expect(retryBody.data.message.conversationId).toBe(githubConversationId);

    const attachmentsAfterRetry = await attachmentRowsByIds([attachmentId]);
    expect(attachmentsAfterRetry).toEqual(attachmentsAfterFirst);
    expect(attachmentsAfterRetry).toHaveLength(1);
    expect(attachmentsAfterRetry[0]?.conversationId).toBe(githubConversationId);
    expect(attachmentsAfterRetry[0]?.messageId).toBe(firstBody.data.message.id);
    const rows = await database
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, githubConversationId),
          eq(messages.clientMessageId, payload.clientMessageId),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
