import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';

import {
  attachmentKindFor,
  attachmentLimits,
  attachmentSummarySchema,
  type AttachmentSummary,
} from '@moyu/contracts';
import {
  artifacts,
  conversations,
  repositories,
  taskLinks,
  type Artifact,
  type Database,
  type DatabaseTransaction,
} from '@moyu/db';

import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';

export interface StoredUpload {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

/** Removes anything outside the allowed character set and bounds the length. */
export function safeUploadFilename(value: string): string {
  const base = path.basename(value.replaceAll('\\', '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff ]/g, '_').trim();
  const bounded = cleaned.slice(0, attachmentLimits.maxFilenameLength);
  return bounded.length > 0 ? bounded : 'attachment';
}

/** The relative storage key for one attachment; never derived from a user path. */
export function attachmentStorageKey(conversationId: string): string {
  return path.posix.join('attachments', conversationId, randomUUID());
}

function storageRoot(config: ApiConfig): string {
  if (!config.artifactStorageDir) {
    throw ApiProblem.unavailable('Attachment storage is not configured');
  }
  return path.resolve(config.artifactStorageDir);
}

/** Resolves a storage key inside the configured root and refuses anything outside it. */
export function resolveStoragePath(config: ApiConfig, storageKey: string): string {
  const root = storageRoot(config);
  const candidate = path.resolve(root, storageKey);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw ApiProblem.notFound('Attachment not found');
  }
  return candidate;
}

/**
 * Verifies a resolved file is a regular file inside the configured root after
 * symlink resolution, and returns its real path and size.
 */
export async function verifiedStorageFile(
  config: ApiConfig,
  storageKey: string,
): Promise<{ path: string; size: number }> {
  const candidate = resolveStoragePath(config, storageKey);
  try {
    const root = await realpath(storageRoot(config));
    const real = await realpath(candidate);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      throw ApiProblem.notFound('Attachment not found');
    }
    const details = await stat(real);
    if (!details.isFile()) {
      throw ApiProblem.notFound('Attachment not found');
    }
    return { path: real, size: details.size };
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw ApiProblem.notFound('Attachment not found');
  }
}

/**
 * Writes the uploaded bytes under the configured root and returns the digest.
 * The write is atomic: the temporary name is renamed only once complete, so a
 * partial upload can never be downloaded.
 */
export async function storeUpload(
  config: ApiConfig,
  storageKey: string,
  bytes: Buffer,
): Promise<StoredUpload> {
  const target = resolveStoragePath(config, storageKey);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    storageKey,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  };
}

export async function removeStoredUpload(config: ApiConfig, storageKey: string): Promise<void> {
  await rm(resolveStoragePath(config, storageKey), { force: true }).catch(() => undefined);
}

/**
 * Streams one stored attachment back as a download. The owner-facing route and
 * the machine download route share this implementation, so the bytes always
 * come from the verified storage root, are always served as an attachment
 * (never inline) and are never cached.
 */
export async function sendStoredAttachment(
  reply: FastifyReply,
  config: ApiConfig,
  artifact: Artifact,
  options: { contentType: string; headers?: Record<string, string> },
): Promise<FastifyReply> {
  if (!artifact.storageKey) {
    throw ApiProblem.notFound('Attachment not found');
  }
  const file = await verifiedStorageFile(config, artifact.storageKey);
  const metadata = (artifact.metadata ?? {}) as AttachmentMetadata;
  const filename = safeUploadFilename(
    typeof metadata.filename === 'string' ? metadata.filename : path.basename(file.path),
  );
  reply
    .header('content-type', options.contentType)
    .header('content-length', String(file.size))
    // RFC 5987 filename so a non-ASCII name survives, with a safe ASCII fallback.
    .header(
      'content-disposition',
      `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .header('content-security-policy', "default-src 'none'; sandbox");
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    reply.header(name, value);
  }
  return reply.send(createReadStream(file.path));
}

interface AttachmentMetadata {
  filename?: unknown;
  kind?: unknown;
}

/** Projects one stored attachment artifact into the shared attachment shape. */
export function toAttachmentSummary(artifact: Artifact): AttachmentSummary {
  const metadata = (artifact.metadata ?? {}) as AttachmentMetadata;
  const filename =
    typeof metadata.filename === 'string' && metadata.filename.length > 0
      ? metadata.filename
      : 'attachment';
  const mimeType = artifact.mimeType ?? 'application/octet-stream';
  return attachmentSummarySchema.parse({
    id: artifact.id,
    conversationId: artifact.conversationId ?? '',
    taskId: artifact.taskId,
    messageId: artifact.messageId,
    filename,
    mimeType,
    sizeBytes: artifact.sizeBytes ?? 0,
    sha256: artifact.sha256 ?? '',
    kind: typeof metadata.kind === 'string' ? metadata.kind : attachmentKindFor(mimeType),
    createdAt: artifact.createdAt.toISOString(),
    downloadUrl: `/api/v1/attachments/${artifact.id}`,
  });
}

/** Attachments of the given messages, in upload order, grouped by message id. */
export async function attachmentsByMessage(
  database: Database,
  messageIds: string[],
): Promise<Map<string, AttachmentSummary[]>> {
  const result = new Map<string, AttachmentSummary[]>();
  if (messageIds.length === 0) return result;
  const rows = await database
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.type, 'attachment'), inArray(artifacts.messageId, messageIds)))
    .orderBy(artifacts.createdAt, artifacts.id);
  for (const row of rows) {
    const messageId = row.messageId;
    if (!messageId) continue;
    const list = result.get(messageId) ?? [];
    list.push(toAttachmentSummary(row));
    result.set(messageId, list);
  }
  return result;
}

/**
 * Binds uploaded attachments to the message that sends them. Validation and the
 * update happen in one statement inside the message transaction, so a foreign
 * id, another owner's id or an already-sent attachment refuses the whole
 * message instead of leaving a half-linked one. The database is the authority:
 * every refusal looks the same to the caller (422).
 */
export async function attachToMessage(
  database: Database | DatabaseTransaction,
  conversationId: string,
  messageId: string,
  attachmentIds: string[],
): Promise<Artifact[]> {
  if (attachmentIds.length === 0) return [];
  const unique = [...new Set(attachmentIds)];
  if (unique.length > attachmentLimits.maxFilesPerMessage) {
    throw ApiProblem.invalid(`最多一次发送 ${attachmentLimits.maxFilesPerMessage} 个附件`);
  }
  const rows = await database
    .select()
    .from(artifacts)
    .where(
      and(
        inArray(artifacts.id, unique),
        eq(artifacts.type, 'attachment'),
        eq(artifacts.conversationId, conversationId),
        isNull(artifacts.messageId),
      ),
    )
    .orderBy(artifacts.createdAt, artifacts.id);
  if (rows.length !== unique.length) {
    throw ApiProblem.invalid('attachmentIds 必须是本会话尚未发送的附件');
  }
  const total = rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
  if (total > attachmentLimits.maxTotalBytesPerMessage) {
    throw ApiProblem.invalid(
      `附件总大小不能超过 ${Math.floor(attachmentLimits.maxTotalBytesPerMessage / (1024 * 1024))} MiB`,
    );
  }
  const updated = await database
    .update(artifacts)
    .set({ messageId })
    .where(
      and(
        inArray(artifacts.id, unique),
        eq(artifacts.type, 'attachment'),
        eq(artifacts.conversationId, conversationId),
        isNull(artifacts.messageId),
      ),
    )
    .returning();
  if (updated.length !== unique.length) {
    throw ApiProblem.invalid('attachmentIds 必须是本会话尚未发送的附件');
  }
  return updated;
}

/** Loads a conversation only when the authenticated owner owns its repository. */
export async function ownedConversation(
  database: Database,
  ownerId: string,
  conversationId: string,
): Promise<{ id: string; repositoryId: string; taskId: string | null }> {
  const [row] = await database
    .select({
      id: conversations.id,
      repositoryId: conversations.repositoryId,
      taskId: taskLinks.id,
    })
    .from(conversations)
    .innerJoin(repositories, eq(repositories.id, conversations.repositoryId))
    .leftJoin(taskLinks, eq(taskLinks.conversationId, conversations.id))
    .where(and(eq(conversations.id, conversationId), eq(repositories.ownerId, ownerId)))
    .limit(1);
  if (!row) {
    throw ApiProblem.notFound('Conversation not found');
  }
  return { id: row.id, repositoryId: row.repositoryId, taskId: row.taskId ?? null };
}
