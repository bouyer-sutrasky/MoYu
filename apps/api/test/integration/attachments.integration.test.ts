import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  attachmentUploadDataSchema,
  messageListDataSchema,
  type AttachmentSummary,
} from '@moyu/contracts';
import { artifacts, owners, repositories, sessions, taskLinks, type Database } from '@moyu/db';

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
  storageDir: string;
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const TEXT_BYTES = Buffer.from('hello attachment\nsecond line\n', 'utf8');
const HTML_BYTES = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8');

function multipart(
  file: { filename: string; contentType: string; bytes: Buffer },
  field = 'file',
): { payload: Buffer; contentType: string } {
  const boundary = `----moyu-test-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, file.bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function seedHarness(
  testDatabase: TestDatabase,
  storageDir: string,
  label = 'owner',
): Promise<Harness> {
  const database = testDatabase.db;
  const [owner] = await database.insert(owners).values({ displayName: 'M6 Owner' }).returning();
  if (!owner) throw new Error('owner insert returned no row');
  const [repository] = await database
    .insert(repositories)
    .values({
      ownerId: owner.id,
      fullName: `Bouyer12/m6-attachments-${label}`,
      defaultBranch: 'main',
      status: 'active',
    })
    .returning();
  if (!repository) throw new Error('repository insert returned no row');
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
    storageDir,
  };
}

function authCookie(harness: Harness) {
  return { cookies: { [harness.cookieName]: harness.token } };
}

async function createConversation(harness: Harness, repositoryId = harness.repositoryId) {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/conversations',
    ...authCookie(harness),
    payload: {
      repositoryId,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      clientRequestId: `attach-${randomUUID()}`,
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { conversation: { id: string } } }).data.conversation.id;
}

async function upload(
  harness: Harness,
  conversationId: string,
  file: { filename: string; contentType: string; bytes: Buffer },
) {
  const body = multipart(file);
  return harness.app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${conversationId}/attachments`,
    ...authCookie(harness),
    headers: { 'content-type': body.contentType },
    payload: body.payload,
  });
}

async function uploadedAttachment(
  harness: Harness,
  conversationId: string,
  file: { filename: string; contentType: string; bytes: Buffer },
): Promise<AttachmentSummary> {
  const response = await upload(harness, conversationId, file);
  expect(response.statusCode).toBe(201);
  return attachmentUploadDataSchema.parse((response.json() as { data: unknown }).data).attachment;
}

async function countAttachments(harness: Harness): Promise<number> {
  const rows = await harness.database
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.type, 'attachment'));
  return rows.length;
}

describe('M6 attachment upload and download', () => {
  let testDatabase: TestDatabase;
  let harness: Harness;
  let secondHarness: Harness;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    harness = await seedHarness(
      testDatabase,
      mkdtempSync(join(tmpdir(), 'moyu-artifacts-')),
      'first',
    );
    // A second owner proves the read and write paths never cross owners. Both
    // apps share the database but authenticate as different owners.
    secondHarness = await seedHarness(testDatabase, harness.storageDir, 'second');
  }, 60_000);

  afterAll(async () => {
    await harness?.app.close();
    await secondHarness?.app.close();
    await testDatabase?.drop();
    rmSync(harness.storageDir, { recursive: true, force: true });
  });

  it('stores a real multipart upload and serves the identical bytes back', async () => {
    const conversationId = await createConversation(harness);
    const png = await uploadedAttachment(harness, conversationId, {
      filename: 'screenshot.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(png).toMatchObject({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: PNG_BYTES.byteLength,
      sha256: createHash('sha256').update(PNG_BYTES).digest('hex'),
      messageId: null,
    });
    expect(png.downloadUrl).toBe(`/api/v1/attachments/${png.id}`);

    const download = await harness.app.inject({
      method: 'GET',
      url: png.downloadUrl,
      ...authCookie(harness),
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PNG_BYTES)).toBe(true);
    expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(png.sha256);
    expect(download.headers['content-type']).toBe('image/png');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['x-content-type-options']).toBe('nosniff');

    const [row] = await harness.database.select().from(artifacts).where(eq(artifacts.id, png.id));
    expect(row?.sizeBytes).toBe(PNG_BYTES.byteLength);
    expect(row?.sha256).toBe(png.sha256);
  });

  it('round-trips a text attachment byte for byte', async () => {
    const conversationId = await createConversation(harness);
    const text = await uploadedAttachment(harness, conversationId, {
      filename: 'run.log',
      contentType: 'text/plain',
      bytes: TEXT_BYTES,
    });
    expect(text.kind).toBe('text');
    const download = await harness.app.inject({
      method: 'GET',
      url: text.downloadUrl,
      ...authCookie(harness),
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(TEXT_BYTES)).toBe(true);
  });

  it('never serves an uploaded HTML file inline', async () => {
    const conversationId = await createConversation(harness);
    const html = await uploadedAttachment(harness, conversationId, {
      filename: 'payload.html',
      contentType: 'text/html',
      bytes: HTML_BYTES,
    });
    const download = await harness.app.inject({
      method: 'GET',
      url: html.downloadUrl,
      ...authCookie(harness),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(String(download.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(String(download.headers['content-disposition'])).toContain('payload.html');
    expect(download.headers['content-security-policy']).toContain('sandbox');
  });

  it('refuses an oversized file with 413 and stores nothing', async () => {
    const conversationId = await createConversation(harness);
    const before = await countAttachments(harness);
    const filesBefore = readdirSync(harness.storageDir, { recursive: true }).length;
    const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x41);
    const response = await upload(harness, conversationId, {
      filename: 'huge.txt',
      contentType: 'text/plain',
      bytes: tooLarge,
    });
    expect(response.statusCode).toBe(413);
    expect((response.json() as { error: { code: string } }).error.code).toBe('payload_too_large');
    expect(await countAttachments(harness)).toBe(before);
    expect(readdirSync(harness.storageDir, { recursive: true }).length).toBe(filesBefore);
  });

  it('refuses a disallowed content type with 422 and stores nothing', async () => {
    const conversationId = await createConversation(harness);
    const before = await countAttachments(harness);
    const response = await upload(harness, conversationId, {
      filename: 'setup.exe',
      contentType: 'application/x-msdownload',
      bytes: Buffer.from('MZ', 'utf8'),
    });
    expect(response.statusCode).toBe(422);
    expect(await countAttachments(harness)).toBe(before);
  });

  it('requires an authenticated session', async () => {
    const conversationId = await createConversation(harness);
    const body = multipart({
      filename: 'a.txt',
      contentType: 'text/plain',
      bytes: TEXT_BYTES,
    });
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/attachments`,
      headers: { 'content-type': body.contentType },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses an upload into another owner conversation and a foreign download', async () => {
    const foreignConversation = await createConversation(secondHarness);
    const before = await countAttachments(harness);
    const response = await upload(harness, foreignConversation, {
      filename: 'intrusion.txt',
      contentType: 'text/plain',
      bytes: TEXT_BYTES,
    });
    expect(response.statusCode).toBe(404);
    expect(await countAttachments(harness)).toBe(before);

    const own = await uploadedAttachment(harness, await createConversation(harness), {
      filename: 'private.txt',
      contentType: 'text/plain',
      bytes: TEXT_BYTES,
    });
    const foreignRead = await secondHarness.app.inject({
      method: 'GET',
      url: own.downloadUrl,
      ...authCookie(secondHarness),
    });
    expect(foreignRead.statusCode).toBe(404);
  });

  it('binds attachments to the sent message and lists them with it', async () => {
    const conversationId = await createConversation(harness);
    const png = await uploadedAttachment(harness, conversationId, {
      filename: 'shot.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const text = await uploadedAttachment(harness, conversationId, {
      filename: 'notes.txt',
      contentType: 'text/plain',
      bytes: TEXT_BYTES,
    });
    const clientMessageId = `with-attachments-${randomUUID()}`;
    const sent = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      ...authCookie(harness),
      payload: { clientMessageId, text: '请看截图和日志', attachmentIds: [png.id, text.id] },
    });
    expect(sent.statusCode).toBe(202);
    const message = (
      sent.json() as { data: { message: { id: string; attachments: AttachmentSummary[] } } }
    ).data.message;
    expect(message.attachments.map((item) => item.id)).toEqual([png.id, text.id]);

    const [row] = await harness.database.select().from(artifacts).where(eq(artifacts.id, png.id));
    expect(row?.messageId).toBe(message.id);

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      ...authCookie(harness),
    });
    const page = messageListDataSchema.parse((listed.json() as { data: unknown }).data);
    const reloaded = page.messages.find((item) => item.id === message.id);
    expect(reloaded?.attachments.map((item) => item.filename)).toEqual(['shot.png', 'notes.txt']);

    // The same idempotency key returns the original message, with its files.
    const replay = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      ...authCookie(harness),
      payload: { clientMessageId, text: '请看截图和日志', attachmentIds: [png.id, text.id] },
    });
    expect(replay.statusCode).toBe(200);
    expect(
      (replay.json() as { data: { message: { attachments: AttachmentSummary[] } } }).data.message
        .attachments,
    ).toHaveLength(2);
  });

  it('refuses attachment ids from another conversation and already-sent attachments', async () => {
    const first = await createConversation(harness);
    const second = await createConversation(harness);
    const foreign = await uploadedAttachment(harness, second, {
      filename: 'other.txt',
      contentType: 'text/plain',
      bytes: TEXT_BYTES,
    });
    const crossSend = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${first}/messages`,
      ...authCookie(harness),
      payload: {
        clientMessageId: `cross-${randomUUID()}`,
        text: '带有别的会话附件',
        attachmentIds: [foreign.id],
      },
    });
    expect(crossSend.statusCode).toBe(422);

    const send = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${first}/messages`,
      ...authCookie(harness),
      payload: {
        clientMessageId: `own-${randomUUID()}`,
        text: '第一次',
        attachmentIds: [foreign.id],
      },
    });
    expect(send.statusCode).toBe(422);

    const [row] = await harness.database
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, foreign.id), eq(artifacts.type, 'attachment')));
    expect(row?.messageId).toBeNull();
  });

  it('refuses an empty file', async () => {
    const conversationId = await createConversation(harness);
    const response = await upload(harness, conversationId, {
      filename: 'empty.txt',
      contentType: 'text/plain',
      bytes: Buffer.alloc(0),
    });
    expect(response.statusCode).toBe(422);
  });

  it('does not accept a new attachment once the task has ended', async () => {
    const conversationId = await createConversation(harness);
    await harness.database
      .update(taskLinks)
      .set({ state: 'completed' })
      .where(eq(taskLinks.conversationId, conversationId));
    const response = await upload(harness, conversationId, {
      filename: 'late.txt',
      contentType: 'text/plain',
      bytes: TEXT_BYTES,
    });
    expect(response.statusCode).toBe(409);
  });
});
