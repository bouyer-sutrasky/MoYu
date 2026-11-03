import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { type WorkspaceEvent } from '@moyu/contracts';
import { events, type Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { SessionService } from '../auth/sessions';
import type { AppEventBus } from '../events/bus';
import { eventToWorkspaceEvent } from '../events/format';
import { ApiProblem } from '../lib/errors';

export interface EventRouteDependencies {
  database: Database;
  sessions: SessionService;
  events: AppEventBus;
  authenticate: Authenticate;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;
const REPLAY_LIMIT = 500;

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
 * Single shared owner event stream. Durable rows are replayed first, then new
 * rows are polled from PostgreSQL. Polling (rather than only the in-process bus)
 * is what makes dispatcher-written events reach open connections and what lets a
 * reconnecting client fill the gap with `Last-Event-ID`.
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

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    let lastWritten = cursor;
    let closed = false;
    let flushing = false;
    let flushAgain = false;
    let unsubscribeWorkspace = () => {};
    let unsubscribeRevocation = () => {};
    // Assigned after `close` is defined; the closures read the assigned timers.
    // eslint-disable-next-line prefer-const
    let pollTimer: NodeJS.Timeout | undefined;
    // eslint-disable-next-line prefer-const
    let heartbeat: NodeJS.Timeout | undefined;

    const writeEvent = (event: WorkspaceEvent) => {
      const seq = BigInt(event.seq);
      if (seq <= lastWritten) {
        return;
      }
      lastWritten = seq;
      reply.raw.write(
        `id: ${event.seq}\nevent: workspaceEvent\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };

    const flush = async (): Promise<void> => {
      if (closed) {
        return;
      }
      if (flushing) {
        flushAgain = true;
        return;
      }
      flushing = true;
      try {
        for (;;) {
          flushAgain = false;
          const rows = await database
            .select()
            .from(events)
            .where(sql`${events.seq} > ${lastWritten.toString()}`)
            .orderBy(events.seq)
            .limit(REPLAY_LIMIT);
          if (closed) {
            return;
          }
          for (const row of rows) {
            const event = eventToWorkspaceEvent(row);
            if (event) {
              writeEvent(event);
            }
          }
          if (closed || (rows.length < REPLAY_LIMIT && !flushAgain)) {
            return;
          }
        }
      } catch {
        // A transient database error must not kill an otherwise healthy stream;
        // the interval retries and the client's Last-Event-ID still covers a gap.
      } finally {
        flushing = false;
        if (flushAgain && !closed) {
          void flush();
        }
      }
    };

    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      unsubscribeRevocation();
      unsubscribeWorkspace();
      streams.delete(close);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    await flush();

    // The bus only wakes the stream; the durable table is read in sequence
    // order. Writing the notified event directly could skip a row whose larger
    // sequence committed first in the producer, leaving a permanent gap.
    unsubscribeWorkspace = bus.onWorkspaceEvent(() => {
      void flush();
    });

    pollTimer = setInterval(() => {
      void flush();
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();

    unsubscribeRevocation = bus.onSessionRevoked(auth.session.id, () => {
      if (closed) {
        return;
      }
      reply.raw.write('event: session.revoked\ndata: {}\n\n');
      close();
    });

    heartbeat = setInterval(() => {
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
    heartbeat.unref?.();

    streams.add(close);
    request.raw.on('close', close);
    request.raw.on('error', close);
  });
}
