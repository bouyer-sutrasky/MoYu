import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  attachmentRevokeDataSchema,
  attachmentUploadDataSchema,
  messageListDataSchema,
  type AttachmentSummary,
} from '@moyu/contracts';
import {
  artifacts,
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

  it('refuses HTML declared as image/png without writing a row or a file', async () => {
    const conversationId = await createConversation(harness);
    const filesBefore = readdirSync(harness.storageDir, { recursive: true }).length;
    const rowsBefore = await countAttachments(harness);
    const response = await upload(harness, conversationId, {
      filename: 'evil.png',
      contentType: 'image/png',
      bytes: HTML_BYTES,
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { message: string } }).error.message).toContain('HTML');
    expect(await countAttachments(harness)).toBe(rowsBefore);
    expect(readdirSync(harness.storageDir, { recursive: true }).length).toBe(filesBefore);
  });

  it('refuses ELF and shebang bytes declared as image/png', async () => {
    const conversationId = await createConversation(harness);
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]);
    const elfResponse = await upload(harness, conversationId, {
      filename: 'elf.png',
      contentType: 'image/png',
      bytes: elf,
    });
    expect(elfResponse.statusCode).toBe(422);
    const scriptResponse = await upload(harness, conversationId, {
      filename: 'script.png',
      contentType: 'image/png',
      bytes: Buffer.from('#!/bin/sh\necho pwned\n', 'utf8'),
    });
    expect(scriptResponse.statusCode).toBe(422);
  });

  it('records a real PNG declared as text/plain as image/png', async () => {
    const conversationId = await createConversation(harness);
    const attachment = await uploadedAttachment(harness, conversationId, {
      filename: 'note.txt',
      contentType: 'text/plain',
      bytes: PNG_BYTES,
    });
    expect(attachment.mimeType).toBe('image/png');
    expect(attachment.kind).toBe('image');
  });

  it('keeps valid images, text, source and explicit text/html uploads', async () => {
    const conversationId = await createConversation(harness);
    const png = await uploadedAttachment(harness, conversationId, {
      filename: 'ok.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(png.mimeType).toBe('image/png');
    expect(png.kind).toBe('image');
    for (const file of [
      { filename: 'notes.txt', contentType: 'text/plain', bytes: Buffer.from('plain\n') },
      { filename: 'readme.md', contentType: 'text/markdown', bytes: Buffer.from('# t\n') },
      { filename: 'data.json', contentType: 'application/json', bytes: Buffer.from('{}\n') },
      {
        filename: 'index.ts',
        contentType: 'text/plain',
        bytes: Buffer.from('export const x = 1;\n'),
      },
      { filename: 'page.html', contentType: 'text/html', bytes: HTML_BYTES },
    ]) {
      const attachment = await uploadedAttachment(harness, conversationId, file);
      expect(attachment.kind).toBe('text');
    }
  });

  it('accepts multi-byte text whose UTF-8 sequence crosses the sniff window', async () => {
    const conversationId = await createConversation(harness);
    const crossing = Buffer.from(`${'a'.repeat(511)}中${'b'.repeat(200)}`, 'utf8');
    expect(crossing.byteLength).toBe(714);
    const markdown = await uploadedAttachment(harness, conversationId, {
      filename: 'notes.md',
      contentType: 'text/markdown',
      bytes: crossing,
    });
    expect(markdown.mimeType).toBe('text/markdown');
    expect(markdown.kind).toBe('text');
    // Controls: an aligned 512-byte window and a short pure-Chinese file stay text.
    const aligned = await uploadedAttachment(harness, conversationId, {
      filename: 'aligned.md',
      contentType: 'text/markdown',
      bytes: Buffer.from(`${'a'.repeat(509)}中`, 'utf8'),
    });
    expect(aligned.kind).toBe('text');
    const short = await uploadedAttachment(harness, conversationId, {
      filename: 'short.md',
      contentType: 'text/markdown',
      bytes: Buffer.from('中文'.repeat(7), 'utf8'),
    });
    expect(short.kind).toBe('text');
    const png = await uploadedAttachment(harness, conversationId, {
      filename: 'control.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    expect(png.kind).toBe('image');
  });

  it('refuses an unclosed comment in the sniff window instead of calling it text', async () => {
    const conversationId = await createConversation(harness);
    for (const padding of [508, 600]) {
      const response = await upload(harness, conversationId, {
        filename: 'unclosed.svg',
        contentType: 'image/svg+xml',
        bytes: Buffer.from(`<!--${'x'.repeat(padding)}--><svg></svg>`, 'utf8'),
      });
      expect(response.statusCode).toBe(422);
    }
    const ordinary = await uploadedAttachment(harness, conversationId, {
      filename: 'notes.md',
      contentType: 'text/markdown',
      bytes: Buffer.from('# note\n<!-- a complete comment -->\ntext\n', 'utf8'),
    });
    expect(ordinary.kind).toBe('text');
  });

  it('only trims an incomplete trailing character when the window is full', async () => {
    const conversationId = await createConversation(harness);
    const short = await upload(harness, conversationId, {
      filename: 'short.txt',
      contentType: 'text/plain',
      bytes: Buffer.concat([Buffer.from('abc', 'utf8'), Buffer.from([0xe4])]),
    });
    expect(short.statusCode).toBe(422);
    // Controls: a split at the 512-byte boundary is still text.
    for (const [filename, bytes] of [
      ['crossing.md', Buffer.from(`${'a'.repeat(511)}中${'b'.repeat(200)}`, 'utf8')],
      ['late.md', Buffer.from(`${'a'.repeat(510)}中${'b'.repeat(200)}`, 'utf8')],
      ['bom.md', Buffer.from(`\ufeff${'中文'.repeat(200)}`, 'utf8')],
    ] as const) {
      const attachment = await uploadedAttachment(harness, conversationId, {
        filename,
        contentType: 'text/markdown',
        bytes,
      });
      expect(attachment.kind).toBe('text');
    }
  });

  it('treats a consumed HTML doctype as HTML, not as free text', async () => {
    const conversationId = await createConversation(harness);
    const asText = await upload(harness, conversationId, {
      filename: 'page.txt',
      contentType: 'text/plain',
      bytes: Buffer.from('<!DOCTYPE html><p>hi</p>', 'utf8'),
    });
    expect(asText.statusCode).toBe(422);
    const asHtml = await uploadedAttachment(harness, conversationId, {
      filename: 'page.html',
      contentType: 'text/html',
      bytes: Buffer.from('<!DOCTYPE html><p>hi</p>', 'utf8'),
    });
    expect(asHtml.kind).toBe('text');
    const svgDoctype = await upload(harness, conversationId, {
      filename: 'vector.svg',
      contentType: 'image/svg+xml',
      bytes: Buffer.from('<!DOCTYPE svg><svg></svg>', 'utf8'),
    });
    expect(svgDoctype.statusCode).toBe(422);
    const plain = await uploadedAttachment(harness, conversationId, {
      filename: 'plain.txt',
      contentType: 'text/plain',
      bytes: Buffer.from('plain text\n', 'utf8'),
    });
    expect(plain.kind).toBe('text');
  });

  it('refuses SVG behind leading comments or a doctype, but keeps mid-text mentions', async () => {
    const conversationId = await createConversation(harness);
    const commented = await upload(harness, conversationId, {
      filename: 'commented.svg',
      contentType: 'image/svg+xml',
      bytes: Buffer.from(
        '<!-- harmless -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'utf8',
      ),
    });
    expect(commented.statusCode).toBe(422);
    const withDoctype = await upload(harness, conversationId, {
      filename: 'doctype.svg',
      contentType: 'image/svg+xml',
      bytes: Buffer.from(
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg><script>alert(1)</script></svg>',
        'utf8',
      ),
    });
    expect(withDoctype.statusCode).toBe(422);
    const inline = await uploadedAttachment(harness, conversationId, {
      filename: 'notes.md',
      contentType: 'text/markdown',
      bytes: Buffer.from('This document mentions <svg> and </svg> in prose.\n', 'utf8'),
    });
    expect(inline.kind).toBe('text');
  });

  it('refuses SVG bytes even when declared image/svg+xml', async () => {
    const conversationId = await createConversation(harness);
    const response = await upload(harness, conversationId, {
      filename: 'vector.svg',
      contentType: 'image/svg+xml',
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
    });
    expect(response.statusCode).toBe(422);
  });

  it('revokes an attachment softly and idempotently, and blocks its download', async () => {
    const conversationId = await createConversation(harness);
    const attachment = await uploadedAttachment(harness, conversationId, {
      filename: 'revoke.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const revoke = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachment.id}/revoke`,
      ...authCookie(harness),
    });
    expect(revoke.statusCode).toBe(200);
    const revoked = attachmentRevokeDataSchema.parse(
      (revoke.json() as { data: unknown }).data,
    ).attachment;
    expect(revoked.revokedAt).not.toBeNull();
    const [row] = await harness.database
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attachment.id));
    expect(row?.revokedAt).not.toBeNull();
    // The bytes stay on disk; only the state changes.
    expect(row?.storageKey).not.toBeNull();
    const download = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachment.id}`,
      ...authCookie(harness),
    });
    expect(download.statusCode).toBe(404);
    const again = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachment.id}/revoke`,
      ...authCookie(harness),
    });
    expect(again.statusCode).toBe(200);
    const second = attachmentRevokeDataSchema.parse(
      (again.json() as { data: unknown }).data,
    ).attachment;
    expect(second.revokedAt).toBe(revoked.revokedAt);
    const drafts = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/attachments`,
      ...authCookie(harness),
    });
    expect(drafts.statusCode).toBe(200);
    const listed = (
      drafts.json() as { data: { attachments: { id: string; revokedAt: string | null }[] } }
    ).data.attachments.find((item) => item.id === attachment.id);
    expect(listed?.revokedAt).toBe(revoked.revokedAt);
  });

  it('refuses to send a revoked attachment without creating a message or delivery', async () => {
    const conversationId = await createConversation(harness);
    const attachment = await uploadedAttachment(harness, conversationId, {
      filename: 'revoked.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachment.id}/revoke`,
      ...authCookie(harness),
    });
    const countMessages = async () =>
      (
        await harness.database
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
      ).length;
    const countDeliveries = async () =>
      (
        await harness.database
          .select({ id: deliveries.id })
          .from(deliveries)
          .innerJoin(messages, eq(deliveries.messageId, messages.id))
          .where(eq(messages.conversationId, conversationId))
      ).length;
    const messagesBefore = await countMessages();
    const deliveriesBefore = await countDeliveries();
    const sent = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      ...authCookie(harness),
      payload: {
        clientMessageId: `revoked-${randomUUID()}`,
        text: 'should not be stored',
        attachmentIds: [attachment.id],
      },
    });
    expect(sent.statusCode).toBe(422);
    expect(await countMessages()).toBe(messagesBefore);
    expect(await countDeliveries()).toBe(deliveriesBefore);
  });

  it('keeps an unrevoked attachment downloadable and sendable', async () => {
    const conversationId = await createConversation(harness);
    const attachment = await uploadedAttachment(harness, conversationId, {
      filename: 'live.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const download = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachment.id}`,
      ...authCookie(harness),
    });
    expect(download.statusCode).toBe(200);
    const sent = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      ...authCookie(harness),
      payload: {
        clientMessageId: `live-${randomUUID()}`,
        text: 'with a live attachment',
        attachmentIds: [attachment.id],
      },
    });
    expect(sent.statusCode).toBe(202);
  });

  it('answers 404 for another owner and 401 without a session, leaving the row unchanged', async () => {
    const conversationId = await createConversation(harness);
    const attachment = await uploadedAttachment(harness, conversationId, {
      filename: 'foreign.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const foreign = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachment.id}/revoke`,
      cookies: { [secondHarness.cookieName]: secondHarness.token },
    });
    expect(foreign.statusCode).toBe(404);
    const anonymous = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachment.id}/revoke`,
    });
    expect(anonymous.statusCode).toBe(401);
    const [row] = await harness.database
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, attachment.id));
    expect(row?.revokedAt).toBeNull();
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
