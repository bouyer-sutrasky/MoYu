import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  attachmentUploadDataSchema,
  createMessageDataSchema,
  type AttachmentSummary,
} from '@moyu/contracts';
import { artifacts, owners, repositories, sessions, type Database } from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig, type ApiConfig } from '../../src/config';
import { createTestDatabase, type TestDatabase } from './helpers';

interface Harness {
  app: FastifyInstance;
  database: Database;
  cookieName: string;
  token: string;
  config: ApiConfig;
  ownerId: string;
  repositoryAId: string;
  repositoryBId: string;
  storageDir: string;
}

const CALLBACK_A = 'm6-test-callback-token-a-0123456789';
const CALLBACK_B = 'm6-test-callback-token-b-0123456789';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const TEXT_BYTES = Buffer.from('L113-TEXT-9K2P\nread me on demand\n', 'utf8');

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function multipart(
  filename: string,
  contentType: string,
  bytes: Buffer,
): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = `----moyu-internal-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function seedHarness(testDatabase: TestDatabase, storageDir: string): Promise<Harness> {
  const database = testDatabase.db;
  const [owner] = await database.insert(owners).values({ displayName: 'M6 Owner' }).returning();
  if (!owner) throw new Error('owner insert returned no row');
  const [repositoryA] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: 'Bouyer12/m6-runtime-attachments-a',
      defaultBranch: 'main',
      status: 'active',
      bridgeCallbackTokenHash: sha256Hex(CALLBACK_A),
    })
    .returning();
  const [repositoryB] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: 'Bouyer12/m6-runtime-attachments-b',
      defaultBranch: 'main',
      status: 'active',
      bridgeCallbackTokenHash: sha256Hex(CALLBACK_B),
    })
    .returning();
  if (!repositoryA || !repositoryB) throw new Error('repository insert failed');
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
    ARTIFACT_STORAGE_DIR: storageDir,
    WEBAUTHN_ORIGIN: 'http://127.0.0.1:3240',
    WEBAUTHN_RP_ID: '127.0.0.1',
  });
  const app = buildApp({ config, database });
  await app.ready();
  return {
    app,
    database,
    cookieName: sessionCookieName(config),
    token,
    config,
    ownerId: owner.id,
    repositoryAId: repositoryA.id,
    repositoryBId: repositoryB.id,
    storageDir,
  };
}

function authCookie(harness: Harness) {
  return { cookies: { [harness.cookieName]: harness.token } };
}

async function createConversation(harness: Harness, repositoryId = harness.repositoryAId) {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/conversations',
    ...authCookie(harness),
    payload: {
      repositoryId,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      clientRequestId: `runtime-attach-${randomUUID()}`,
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { conversation: { id: string } } }).data.conversation.id;
}

async function upload(
  harness: Harness,
  conversationId: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Promise<AttachmentSummary> {
  const body = multipart(filename, contentType, bytes);
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${conversationId}/attachments`,
    ...authCookie(harness),
    headers: { 'content-type': body.contentType },
    payload: body.payload,
  });
  expect(response.statusCode).toBe(201);
  return attachmentUploadDataSchema.parse((response.json() as { data: unknown }).data).attachment;
}

async function sendMessage(
  harness: Harness,
  conversationId: string,
  text: string,
  attachmentIds?: string[],
): Promise<{ id: string; attachments: AttachmentSummary[] }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${conversationId}/messages`,
    ...authCookie(harness),
    payload: {
      clientMessageId: `runtime-attach-${randomUUID()}`,
      text,
      ...(attachmentIds === undefined ? {} : { attachmentIds }),
    },
  });
  expect([200, 202]).toContain(response.statusCode);
  const message = createMessageDataSchema.parse(
    (response.json() as { data: unknown }).data,
  ).message;
  return { id: message.id, attachments: message.attachments };
}

function internalDownload(
  harness: Harness,
  messageId: string,
  attachmentId: string,
  token?: string,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return harness.app.inject({
    method: 'GET',
    url: `/api/internal/v1/messages/${messageId}/attachments/${attachmentId}`,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

describe('M6-A L113 internal attachment download on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;
  let conversationId: string;
  let messageWithPng: { id: string; attachments: AttachmentSummary[] };
  let messageWithText: { id: string; attachments: AttachmentSummary[] };
  let messageWithoutAttachments: string;
  let draftAttachmentId: string;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    harness = await seedHarness(testDatabase, mkdtempSync(join(tmpdir(), 'moyu-runtime-attach-')));

    conversationId = await createConversation(harness);
    const png = await upload(harness, conversationId, 'l113-shot.png', 'image/png', PNG_BYTES);
    const text = await upload(harness, conversationId, 'l113-notes.txt', 'text/plain', TEXT_BYTES);
    messageWithPng = await sendMessage(harness, conversationId, 'look at the screenshot', [png.id]);
    messageWithText = await sendMessage(harness, conversationId, 'read the notes', [text.id]);
    messageWithoutAttachments = (await sendMessage(harness, conversationId, 'no files here')).id;
    // Uploaded but never sent: a draft the owner has not committed to a message.
    draftAttachmentId = (
      await upload(harness, conversationId, 'draft.txt', 'text/plain', TEXT_BYTES)
    ).id;
  }, 60_000);

  afterAll(async () => {
    await harness?.app.close();
    await testDatabase?.drop();
    if (harness?.storageDir) rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('streams the stored bytes of a sent attachment with its digest', async () => {
    const attachment = messageWithPng.attachments[0]!;
    const response = await internalDownload(harness, messageWithPng.id, attachment.id, CALLBACK_A);

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(PNG_BYTES)).toBe(true);
    expect(sha256Hex(response.rawPayload)).toBe(attachment.sha256);
    expect(response.headers['x-moyu-sha256']).toBe(attachment.sha256);
    // Always a download, never an inline image or HTML response.
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-length']).toBe(String(PNG_BYTES.byteLength));
    expect(String(response.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(String(response.headers['content-disposition'])).toContain('l113-shot.png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(String(response.headers['content-security-policy'])).toContain('sandbox');

    const [row] = await harness.database
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attachment.id));
    expect(row?.sha256).toBe(attachment.sha256);
    expect(row?.messageId).toBe(messageWithPng.id);
  });

  it('serves a text attachment byte for byte', async () => {
    const attachment = messageWithText.attachments[0]!;
    const response = await internalDownload(harness, messageWithText.id, attachment.id, CALLBACK_A);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(TEXT_BYTES)).toBe(true);
    expect(response.headers['x-moyu-sha256']).toBe(attachment.sha256);
  });

  it('refuses a request without a machine token or with an unknown one', async () => {
    const attachment = messageWithPng.attachments[0]!;
    const missing = await internalDownload(harness, messageWithPng.id, attachment.id);
    expect(missing.statusCode).toBe(401);

    const unknown = await internalDownload(
      harness,
      messageWithPng.id,
      attachment.id,
      'not-a-real-callback-token-0123456789',
    );
    expect(unknown.statusCode).toBe(401);
  });

  it('refuses a machine token minted for another repository', async () => {
    // A token bound to repository B can never read repository A's attachment.
    // The platform cannot tell which repository a wrong token belongs to, so
    // the answer is the same 401 as an unknown token (as on runtime-events).
    const attachment = messageWithPng.attachments[0]!;
    const response = await internalDownload(harness, messageWithPng.id, attachment.id, CALLBACK_B);
    expect(response.statusCode).toBe(401);
  });

  it('requires the attachment to belong to the message in the path', async () => {
    const attachment = messageWithPng.attachments[0]!;
    const wrongMessage = await internalDownload(
      harness,
      messageWithoutAttachments,
      attachment.id,
      CALLBACK_A,
    );
    expect(wrongMessage.statusCode).toBe(404);

    const unknownAttachment = await internalDownload(
      harness,
      messageWithPng.id,
      randomUUID(),
      CALLBACK_A,
    );
    expect(unknownAttachment.statusCode).toBe(404);

    const unknownMessage = await internalDownload(harness, randomUUID(), attachment.id, CALLBACK_A);
    expect(unknownMessage.statusCode).toBe(404);
  });

  it('refuses an unsent draft attachment with 409', async () => {
    const response = await internalDownload(
      harness,
      messageWithPng.id,
      draftAttachmentId,
      CALLBACK_A,
    );
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('conflict');
  });

  it('does not serve a non-attachment artifact', async () => {
    const [log] = await harness.database
      .insert(artifacts)
      .values({
        repositoryId: harness.repositoryAId,
        conversationId,
        messageId: messageWithPng.id,
        type: 'log',
        metadata: { filename: 'worker.log' },
      })
      .returning();
    const response = await internalDownload(harness, messageWithPng.id, log!.id, CALLBACK_A);
    expect(response.statusCode).toBe(404);
  });
});
