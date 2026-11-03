import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appendEvent, events, owners, sessions, type Database, type Event } from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig, type ApiConfig } from '../../src/config';
import { createAppEventBus, type AppEventBus } from '../../src/events/bus';
import { eventToWorkspaceEvent } from '../../src/events/format';
import { createTestDatabase, type TestDatabase } from './helpers';

interface SseFrame {
  id: string;
  data: { seq: string };
}

interface SseReader {
  read: (wanted: number, timeoutMs?: number) => Promise<SseFrame[]>;
}

/**
 * A streaming SSE reader that can be used in several phases. The existing
 * `readFrames` helper aborts its response after the first phase, which is not
 * suitable for keeping one historical replay open while a later event is
 * persisted.
 */
function createSseReader(response: Response, controller: AbortController): SseReader {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('SSE response has no body');
  }
  let buffer = '';
  const decoder = new TextDecoder();

  return {
    async read(wanted, timeoutMs = 15_000) {
      const frames: SseFrame[] = [];
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${wanted} SSE frames`));
        }, timeoutMs);
      });
      try {
        while (frames.length < wanted) {
          const { value, done } = await Promise.race([reader.read(), timeout]);
          if (done) {
            throw new Error(`SSE stream ended after ${frames.length} of ${wanted} frames`);
          }
          buffer += decoder.decode(value, { stream: true });
          for (let index = buffer.indexOf('\n\n'); index >= 0; index = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const idLine = block.split('\n').find((line) => line.startsWith('id: '));
            const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
            if (idLine && dataLine) {
              frames.push({ id: idLine.slice(4), data: JSON.parse(dataLine.slice(6)) });
            }
          }
        }
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      return frames;
    },
  };
}

/**
 * The route's replay loop is asynchronous, so a test cannot reliably insert the
 * 502nd row "during" the first page without controlling the database access.
 * This proxy gates only the second `events` SELECT: the route can replay the
 * first 500 rows, then stops before reading the next page until the test has
 * persisted and notified event 502. All other database access is untouched and
 * PostgreSQL remains the real backend.
 */
function createReplayBoundaryDatabase(database: Database): {
  database: Database;
  pageBoundary: Promise<void>;
  releaseNextPage: () => void;
} {
  let eventQueryCount = 0;
  let release: (() => void) | undefined;
  let markBlocked: (() => void) | undefined;
  const pageBoundary = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const wrapQuery = <T extends object>(builder: T, isEventQuery: boolean): T =>
    new Proxy(builder, {
      get(target, property, receiver) {
        if (property === 'then' && isEventQuery) {
          const then = Reflect.get(target, property, receiver) as (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise<unknown>;
          return (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => {
            eventQueryCount += 1;
            // Replay limit is 500, so query two starts the page after the
            // 500th event. Hold it while the test writes event 502.
            if (eventQueryCount === 2) {
              markBlocked?.();
              return released.then(() => then.call(target, onFulfilled, onRejected));
            }
            return then.call(target, onFulfilled, onRejected);
          };
        }

        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          const result = (value as (...inner: unknown[]) => unknown).apply(target, args);
          if (property === 'from') {
            return wrapQuery(result as object, args[0] === events);
          }
          if (isEventQuery && result && typeof result === 'object' && 'then' in result) {
            return wrapQuery(result as object, true);
          }
          return result;
        };
      },
    });

  const select = database.select.bind(database) as unknown as (...args: unknown[]) => object;
  const proxied = new Proxy(database as object, {
    get(target, property, receiver) {
      if (property === 'select') {
        return (...args: unknown[]) => wrapQuery(select(...args), false);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...inner: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as Database;

  return {
    database: proxied,
    pageBoundary,
    releaseNextPage: () => release?.(),
  };
}

async function waitForReplayPageBoundary(pageBoundary: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pageBoundary,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('SSE replay did not request a second page after 500 events')),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function appendProgress(database: Database, text: string): Promise<Event> {
  const event = await database.transaction(async (transaction) =>
    appendEvent(transaction, {
      type: 'task.progress',
      source: 'sse-boundary-test',
      payload: { ticketId: 'ticket-sse-boundary', text, at: new Date().toISOString() },
    }),
  );
  if (!event) {
    throw new Error('event insert returned no row');
  }
  return event;
}

describe('SSE replay across the 500-event page boundary on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let database: Database;
  let app: FastifyInstance;
  let config: ApiConfig;
  let eventBus: AppEventBus;
  let token: string;
  let baseUrl: string;
  let boundary: ReturnType<typeof createReplayBoundaryDatabase>;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    const [owner] = await database
      .insert(owners)
      .values({ displayName: 'SSE Boundary Owner' })
      .returning();
    if (!owner) {
      throw new Error('owner insert returned no row');
    }
    token = randomToken(32);
    await database.insert(sessions).values({
      ownerId: owner.id,
      tokenHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: testDatabase.url,
      WEBAUTHN_ORIGIN: 'http://127.0.0.1:3200',
      WEBAUTHN_RP_ID: '127.0.0.1',
      BRIDGE_CALLBACK_TOKEN: 'sse-boundary-callback-token-0123456789',
    });
    eventBus = createAppEventBus();
    boundary = createReplayBoundaryDatabase(database);
    app = buildApp({ config, database: boundary.database, eventBus });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('API did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (testDatabase) {
      await testDatabase.drop();
    }
  });

  it('replays 501 persisted events, persists 502 at the page boundary, and resumes from the database cursor', async () => {
    const cookie = `${sessionCookieName(config)}=${token}`;
    const historical: Event[] = [];
    for (let index = 0; index < 501; index += 1) {
      historical.push(await appendProgress(database, `historical-${index + 1}`));
    }

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = createSseReader(response, controller);

    // Read exactly one page. The route cannot issue its second SELECT until the
    // test releases the gate below.
    const firstPage = await reader.read(500);
    expect(firstPage.map((frame) => frame.id)).toEqual(
      historical.slice(0, 500).map((event) => event.seq.toString()),
    );
    await waitForReplayPageBoundary(boundary.pageBoundary);

    // The 502nd row is committed while the server-side replay is suspended at
    // the page boundary. The bus notification is fired here as the acceptance
    // asks; the durable loop must still place 501 before 502.
    const live = await appendProgress(database, 'live-502');
    const liveEvent = eventToWorkspaceEvent(live);
    if (!liveEvent) {
      throw new Error('the 502nd event is not contract-valid');
    }
    eventBus.publishWorkspaceEvent(liveEvent);
    boundary.releaseNextPage();

    const tail = await reader.read(2);
    expect(tail.map((frame) => frame.id)).toEqual([
      historical[500]?.seq.toString(),
      live.seq.toString(),
    ]);

    const persisted = await database.select({ seq: events.seq }).from(events).orderBy(events.seq);
    const expectedIds = persisted.map((row) => row.seq.toString());
    expect(expectedIds).toHaveLength(502);

    const receivedFrames = [...firstPage, ...tail];
    const receivedIds = receivedFrames.map((frame) => frame.id);
    expect(receivedIds).toEqual(expectedIds);
    expect(receivedFrames.map((frame) => frame.data.seq)).toEqual(expectedIds);
    expect(new Set(receivedIds).size).toBe(502);

    // The acceptance's focus: events 500, 501 and 502 all arrive, in order,
    // exactly once. Index 499 is the 500th persisted row.
    expect(receivedIds).toContain(expectedIds[499]);
    expect(receivedIds).toContain(expectedIds[500]);
    expect(receivedIds).toContain(expectedIds[501]);

    controller.abort();

    // Reconnect with the real database-assigned ID of the 500th event.
    const resumedController = new AbortController();
    const resumedResponse = await fetch(`${baseUrl}/api/v1/events`, {
      headers: {
        cookie,
        accept: 'text/event-stream',
        'last-event-id': expectedIds[499],
      },
      signal: resumedController.signal,
    });
    expect(resumedResponse.status).toBe(200);
    const resumedReader = createSseReader(resumedResponse, resumedController);
    const resumed = await resumedReader.read(2);
    expect(resumed.map((frame) => frame.id)).toEqual(expectedIds.slice(500));
    expect(resumed.map((frame) => frame.data.seq)).toEqual(expectedIds.slice(500));
    resumedController.abort();
  }, 60_000);
});
