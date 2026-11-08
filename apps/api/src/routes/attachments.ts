import { createReadStream } from 'node:fs';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  attachmentLimits,
  attachmentListDataSchema,
  attachmentMimeFromFilename,
  attachmentUploadDataSchema,
  ATTACHMENT_ALLOWED_TYPES,
  attachmentKindFor,
  uuidSchema,
} from '@moyu/contracts';
import { artifacts, repositories, taskLinks, type Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import {
  attachmentStorageKey,
  ownedConversation,
  removeStoredUpload,
  safeUploadFilename,
  storeUpload,
  toAttachmentSummary,
  verifiedStorageFile,
} from '../domain/attachments';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';

export interface AttachmentRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
}

function safeMimeType(value: string | null): string {
  if (!value || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value)) {
    return 'application/octet-stream';
  }
  // HTML and SVG can execute script if a browser ever renders them inline, so
  // the served type is replaced by a download-only type.
  if (value === 'text/html' || value === 'image/svg+xml') {
    return 'application/octet-stream';
  }
  return value;
}

/** States in which a conversation no longer accepts new work, so an upload is meaningless. */
const TERMINAL_TASK_STATES = new Set(['completed', 'closed_unmerged', 'not_accepted']);

/**
 * Authenticated attachment upload and download. The upload path stores the
 * bytes under a server-generated key and records one `attachment` artifact; the
 * download path proves ownership of the repository and then streams the file as
 * an attachment (never inline).
 */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  dependencies: AttachmentRouteDependencies,
): void {
  const { config, database, authenticate } = dependencies;

  app.post(
    '/api/v1/conversations/:id/attachments',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const conversationId = parseInput(uuidSchema, params.id);
      const conversation = await ownedConversation(database, auth.owner.id, conversationId);
      if (conversation.taskId) {
        const [task] = await database
          .select({ state: taskLinks.state })
          .from(taskLinks)
          .where(eq(taskLinks.id, conversation.taskId))
          .limit(1);
        if (task && TERMINAL_TASK_STATES.has(task.state)) {
          throw ApiProblem.conflict(
            'This conversation has ended; it no longer accepts attachments',
          );
        }
      }
      if (!config.artifactStorageDir) {
        throw ApiProblem.unavailable('Attachment storage is not configured');
      }

      const upload = await request.file({
        limits: { fileSize: attachmentLimits.maxFileBytes, files: 1 },
      });
      if (!upload) {
        throw ApiProblem.invalid('multipart 请求必须包含一个文件字段（file）');
      }
      const filename = safeUploadFilename(upload.filename ?? '');
      const declared = (upload.mimetype ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
      // Only declared types on the allowlist are accepted; an unknown type falls
      // back to the filename extension, and an unknown extension is refused.
      const mimeType = (ATTACHMENT_ALLOWED_TYPES as readonly string[]).includes(declared)
        ? declared
        : (attachmentMimeFromFilename(filename) ?? '');
      if (!mimeType) {
        throw ApiProblem.invalid(
          '不支持的文件类型；只接受图片（PNG/JPEG/WebP/GIF）与文本类文件（txt/log/md/json/yaml/csv/源码等）',
        );
      }

      let bytes: Buffer;
      try {
        bytes = await upload.toBuffer();
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'FST_REQ_FILE_TOO_LARGE') {
          throw ApiProblem.payloadTooLarge(
            `单个附件不能超过 ${Math.floor(attachmentLimits.maxFileBytes / (1024 * 1024))} MiB`,
          );
        }
        throw error;
      }
      if (bytes.byteLength === 0) {
        throw ApiProblem.invalid('附件不能是空文件');
      }

      const storageKey = attachmentStorageKey(conversationId);
      const stored = await storeUpload(config, storageKey, bytes);
      try {
        const [row] = await database
          .insert(artifacts)
          .values({
            repositoryId: conversation.repositoryId,
            conversationId,
            taskId: conversation.taskId,
            type: 'attachment',
            storageKey: stored.storageKey,
            mimeType,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            metadata: { filename, kind: attachmentKindFor(mimeType) },
          })
          .returning();
        if (!row) {
          throw new Error('attachment insert returned no row');
        }
        return sendData(
          reply,
          request,
          attachmentUploadDataSchema.parse({ attachment: toAttachmentSummary(row) }),
          201,
        );
      } catch (error) {
        // A row that was never written must not leave an orphan file behind.
        await removeStoredUpload(config, stored.storageKey);
        throw error;
      }
    },
  );

  app.get('/api/v1/attachments/:id', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    const params = request.params as { id?: string };
    const attachmentId = parseInput(uuidSchema, params.id);

    const [row] = await database
      .select({ artifact: artifacts })
      .from(artifacts)
      .innerJoin(repositories, eq(artifacts.repositoryId, repositories.id))
      .where(
        and(
          eq(artifacts.id, attachmentId),
          eq(artifacts.type, 'attachment'),
          eq(repositories.ownerId, auth.owner.id),
        ),
      )
      .limit(1);

    if (!row || !row.artifact.storageKey) {
      throw ApiProblem.notFound('Attachment not found');
    }
    if (!config.artifactStorageDir) {
      throw ApiProblem.unavailable('Attachment storage is not configured');
    }

    const file = await verifiedStorageFile(config, row.artifact.storageKey);
    const metadata = (row.artifact.metadata ?? {}) as { filename?: unknown };
    const filename = safeUploadFilename(
      typeof metadata.filename === 'string' ? metadata.filename : path.basename(file.path),
    );
    reply
      .header('content-type', safeMimeType(row.artifact.mimeType))
      .header('content-length', String(file.size))
      // RFC 5987 filename so a non-ASCII name survives, with a safe ASCII fallback.
      .header(
        'content-disposition',
        `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; sandbox");
    return reply.send(createReadStream(file.path));
  });

  /** Draft attachments of a conversation that were uploaded but not yet sent. */
  app.get(
    '/api/v1/conversations/:id/attachments',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const conversationId = parseInput(uuidSchema, params.id);
      await ownedConversation(database, auth.owner.id, conversationId);
      const rows = await database
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.conversationId, conversationId), eq(artifacts.type, 'attachment')))
        .orderBy(artifacts.createdAt, artifacts.id);
      return sendData(
        reply,
        request,
        attachmentListDataSchema.parse({
          attachments: rows
            .filter((row) => row.messageId === null)
            .map((row) => toAttachmentSummary(row)),
        }),
      );
    },
  );
}
