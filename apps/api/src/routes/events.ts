import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  workspaceEventSchema,
  workspaceEventTypeSchema,
  type WorkspaceEvent,
} from '@moyu/contracts';
import { events, type Event, type Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { SessionService } from '../auth/sessions';
import type { AppEventBus } from '../events/bus';
import { ApiProblem } from '../lib/errors';

export interface EventRouteDependencies {
  database: Database;
  sessions: SessionService;
  events: AppEventBus;
  authenticate: Authenticate;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const REPLAY_LIMIT = 500;

function toWorkspaceEvent(row: Event): WorkspaceEvent | null {
  const type = workspaceEventTypeSchema.safeParse(row.type);
  if (!type.success) {
    return null;
  }
  const candidate = {
    id: row.id,
    seq: row.seq.toString(),
    type: type.data,
    repositoryId: row.repositoryId ?? undefined,
    conversationId: row.conversationId ?? undefined,
    taskId: row.taskId ?? undefined,
    occurredAt: row.occurredAt.toISOString(),
    data: row.payload,
  };
  const parsed = workspaceEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parseCursor(value: string | undefined): bigint {
  if (!value) {
    return 0n;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw ApiProblem.invalid('after must be a decimal event sequence');
  }
  return BigInt(value);
}

/**
 * Single shared owner event stream. Durable rows are replayed first, then live
 * in-process events are appended. Revoking the session closes this stream
 * immediately and the client must re-authenticate before reconnecting.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  dependencies: EventRouteDependencies,
): void {
  const { database, sessions, events: bus, authenticate } = dependencies;
  const streams = new Set<() => void>();

  app.addHook('onClose', async () => {
    for (const close of [...streams]) {
      close();
    }
  });

  app.get('/api/v1/events', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }

    const query = request.query as { after?: string };
    const headerCursor = request.headers['last-event-id'];
    const cursor = parseCursor(
      typeof headerCursor === 'string' ? headerCursor : (query.after ?? undefined),
    );

    const history = await database
      .select()
      .from(events)
      .where(sql`${events.seq} > ${cursor.toString()}`)
      .orderBy(events.seq)
      .limit(REPLAY_LIMIT);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    let lastSeq = cursor;
    let closed = false;
    const timers: { heartbeat?: NodeJS.Timeout } = {};
    let unsubscribeWorkspace = () => {};
    let unsubscribeRevocation = () => {};

    const writeEvent = (event: WorkspaceEvent) => {
      lastSeq = BigInt(event.seq);
      reply.raw.write(
        `id: ${event.seq}\nevent: workspaceEvent\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };

    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (timers.heartbeat) {
        clearInterval(timers.heartbeat);
      }
      unsubscribeRevocation();
      unsubscribeWorkspace();
      streams.delete(close);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    for (const row of history) {
      const event = toWorkspaceEvent(row);
      if (event) {
        writeEvent(event);
      }
    }

    unsubscribeWorkspace = bus.onWorkspaceEvent((event) => {
      if (closed || BigInt(event.seq) <= lastSeq) {
        return;
      }
      writeEvent(event);
    });

    unsubscribeRevocation = bus.onSessionRevoked(auth.session.id, () => {
      if (closed) {
        return;
      }
      reply.raw.write('event: session.revoked\ndata: {}\n\n');
      close();
    });

    timers.heartbeat = setInterval(() => {
      void (async () => {
        try {
          const active = await sessions.isActive(auth.session.id);
          if (!active) {
            close();
            return;
          }
          if (!closed) {
            reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
          }
        } catch {
          close();
        }
      })();
    }, HEARTBEAT_INTERVAL_MS);
    timers.heartbeat.unref?.();

    streams.add(close);
    request.raw.on('close', close);
    request.raw.on('error', close);
  });
}
