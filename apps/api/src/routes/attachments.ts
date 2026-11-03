import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { artifacts, repositories, type Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';
import { parseInput } from '../lib/http';
import { uuidSchema } from '@moyu/contracts';

export interface AttachmentRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'attachment';
}

function safeMimeType(value: string | null): string {
  if (!value || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value)) {
    return 'application/octet-stream';
  }
  if (value === 'text/html' || value === 'image/svg+xml') {
    return 'application/octet-stream';
  }
  return value;
}

/**
 * Authenticated attachment download. M2 only needs the protected read path so
 * session revocation can be proven against a real resource; upload and UI
 * attachment handling belong to later stages.
 */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  dependencies: AttachmentRouteDependencies,
): void {
  const { config, database, authenticate } = dependencies;

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

    const root = path.resolve(config.artifactStorageDir);
    const candidate = path.resolve(root, row.artifact.storageKey);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw ApiProblem.notFound('Attachment not found');
    }

    let size: number;
    let realCandidate: string;
    try {
      const realRoot = await realpath(root);
      realCandidate = await realpath(candidate);
      if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
        throw ApiProblem.notFound('Attachment not found');
      }
      const details = await stat(realCandidate);
      if (!details.isFile()) {
        throw ApiProblem.notFound('Attachment not found');
      }
      size = details.size;
    } catch (error) {
      if (error instanceof ApiProblem) {
        throw error;
      }
      throw ApiProblem.notFound('Attachment not found');
    }

    const filename = safeFilename(path.basename(candidate));
    reply
      .header('content-type', safeMimeType(row.artifact.mimeType))
      .header('content-length', String(size))
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');
    return reply.send(createReadStream(realCandidate));
  });
}
