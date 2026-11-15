import { createHash } from 'node:crypto';

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  historySearchDataSchema,
  historySearchQuerySchema,
  type HistorySearchItem,
} from '@moyu/contracts';
import { conversations, repositories, taskLinks, type Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import { toConversationSummary } from '../domain/serialize';
import { findOwnedRepository } from '../domain/repositories';
import { decodeCursorValue, encodeCursorValue } from '../lib/cursor';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';

export interface HistoryRouteDependencies {
  database: Database;
  authenticate: Authenticate;
}

const PAGE_DEFAULT = 30;
const KEYWORD_MAX = 200;
const SNIPPET_MAX = 240;

const conversationCursorTimestamp = sql<string>`to_char(${conversations.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Escapes LIKE metacharacters so a keyword is always matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeKeyword(value: string | undefined): string {
  return (value ?? '').trim().slice(0, KEYWORD_MAX);
}

function snippetOf(value: string | null): string | null {
  if (!value) return null;
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > SNIPPET_MAX ? `${single.slice(0, SNIPPET_MAX - 1)}…` : single;
}

/**
 * Owner-scoped history search over conversation titles and message bodies.
 *
 * Only conversations owned by the authenticated owner are joined; a repository
 * filter is additionally checked against the same owner. The cursor scope
 * includes every filter and the keyword, so a page boundary cannot be replayed
 * against another query and the same cursor neither repeats nor skips rows.
 */
export function registerHistoryRoutes(
  app: FastifyInstance,
  dependencies: HistoryRouteDependencies,
): void {
  const { database, authenticate } = dependencies;

  app.get('/api/v1/history/search', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const query = parseInput(historySearchQuerySchema, request.query);
    const limit = query.limit ?? PAGE_DEFAULT;
    const keyword = normalizeKeyword(query.q);
    const pattern = keyword.length > 0 ? `%${escapeLike(keyword)}%` : null;

    let repositoryId: string | null = null;
    if (query.repositoryId) {
      const repository = await findOwnedRepository(database, auth.owner.id, query.repositoryId);
      if (!repository) {
        throw ApiProblem.notFound('Repository not found');
      }
      repositoryId = repository.id;
    }

    const scope = `history:${createHash('sha256')
      .update(
        JSON.stringify({
          owner: auth.owner.id,
          repositoryId,
          state: query.state ?? null,
          keyword: keyword.toLowerCase(),
        }),
      )
      .digest('base64url')}`;

    const conditions: SQL[] = [
      eq(conversations.ownerId, auth.owner.id),
      isNull(conversations.mergedIntoConversationId),
      eq(repositories.ownerId, auth.owner.id),
    ];
    if (repositoryId) {
      conditions.push(eq(conversations.repositoryId, repositoryId));
    }
    if (query.state === 'none') {
      conditions.push(isNull(taskLinks.id));
    } else if (query.state) {
      conditions.push(eq(taskLinks.state, query.state));
    }
    if (pattern) {
      conditions.push(
        sql`(${conversations.title} ilike ${pattern} or exists (
          select 1 from messages m
           where m.conversation_id = ${conversations.id} and m.body ilike ${pattern}
        ))`,
      );
    }
    if (query.cursor) {
      const position = decodeCursorValue(query.cursor, { kind: 'conversation', scope });
      conditions.push(
        position.id === null
          ? sql`${conversations.updatedAt} < ${position.timestamp}::timestamptz`
          : sql`(${conversations.updatedAt} < ${position.timestamp}::timestamptz OR (${conversations.updatedAt} = ${position.timestamp}::timestamptz AND ${conversations.id} < ${position.id}::uuid))`,
      );
    }

    const snippetExpression = pattern
      ? sql<string | null>`(
          select m.body from messages m
           where m.conversation_id = ${conversations.id} and m.body ilike ${pattern}
           order by m.created_at desc, m.id desc
           limit 1
        )`
      : sql<string | null>`null::text`;
    const titleMatchExpression = pattern
      ? sql<boolean>`(${conversations.title} ilike ${pattern})`
      : sql<boolean>`false`;

    const rows = await database
      .select({
        conversation: conversations,
        task: taskLinks,
        repositoryId: repositories.id,
        repositoryName: repositories.fullName,
        snippet: snippetExpression,
        titleMatch: titleMatchExpression,
        cursorTimestamp: conversationCursorTimestamp,
      })
      .from(conversations)
      .innerJoin(repositories, eq(repositories.id, conversations.repositoryId))
      .leftJoin(taskLinks, eq(taskLinks.conversationId, conversations.id))
      .where(and(...conditions))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    const nextCursor =
      hasMore && oldest
        ? encodeCursorValue({
            kind: 'conversation',
            scope,
            timestamp: oldest.cursorTimestamp,
            id: oldest.conversation.id,
          })
        : null;

    const items: HistorySearchItem[] = page.map((row) => {
      const snippet = snippetOf(row.snippet);
      return {
        conversation: toConversationSummary(
          row.conversation,
          row.task ?? null,
          row.conversation.title,
        ),
        repository: { id: row.repositoryId, fullName: row.repositoryName },
        matched: !pattern ? 'recent' : row.titleMatch ? 'title' : 'message',
        snippet: row.titleMatch ? null : snippet,
      };
    });

    return sendData(reply, request, historySearchDataSchema.parse({ items, nextCursor, hasMore }));
  });
}
