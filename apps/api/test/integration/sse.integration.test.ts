import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appendEvent, owners, sessions, type Database } from '@moyu/db';

import { buildApp } from '../../src/app';
import { hashSecret, randomToken } from '../../src/auth/crypto';
import { sessionCookieName } from '../../src/auth/cookies';
import { loadConfig, type ApiConfig } from '../../src/config';
import { createAppEventBus, type AppEventBus } from '../../src/events/bus';
import { eventToWorkspaceEvent } from '../../src/events/format';
import { createTestDatabase, type TestDatabase } from './helpers';

interface SseFrame {
  id: string;
  data: unknown;
}

const decoder = new TextDecoder();

/** Reads SSE frames from an open response until `wanted` arrive or the timeout aborts. */
async function readFrames(
  response: Response,
  wanted: number,
  controller: AbortController,
  timeoutMs = 5000,
): Promise<SseFrame[]> {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames: SseFrame[] = [];
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('SSE response has no body');
  }
  let buffer = '';
  try {
    while (frames.length < wanted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value);
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
  } catch (error) {
    if ((error as { name?: string }).name !== 'AbortError') {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return frames;
}

describe('durable SSE stream on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let database: Database;
  let app: FastifyInstance;
  let config: ApiConfig;
  let eventBus: AppEventBus;
  let token: string;
  let baseUrl: string;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    database = testDatabase.db;
    const [owner] = await database.insert(owners).values({ displayName: 'SSE Owner' }).returning();
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
      BRIDGE_CALLBACK_TOKEN: 'sse-test-callback-token-0123456789',
    });
    eventBus = createAppEventBus();
    app = buildApp({ config, database, eventBus });
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

  async function insertEvent(text: string) {
    return database.transaction(async (transaction) =>
      appendEvent(transaction, {
        type: 'task.progress',
        source: 'test',
        payload: { ticketId: 'ticket-sse', text, at: new Date().toISOString() },
      }),
    );
  }

  it('fills rows in sequence order when only a later event wakes the stream', async () => {
    const first = await insertEvent('first');
    if (!first) {
      throw new Error('first event insert returned no row');
    }
    const cookie = `${sessionCookieName(config)}=${token}`;
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/events`, {
      headers: {
        cookie,
        accept: 'text/event-stream',
        'last-event-id': String(first.seq),
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    // Let the initial replay finish and the bus subscription attach.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await insertEvent('second');
    const third = await insertEvent('third');
    if (!second || !third) {
      throw new Error('later event insert returned no row');
    }
    const later = eventToWorkspaceEvent(third);
    if (!later) {
      throw new Error('third event is not contract-valid');
    }
    // The regression: the wakeup names only the later row. A direct write of
    // `third` would skip `second` forever; the route must read the table instead.
    eventBus.publishWorkspaceEvent(later);

    const frames = await readFrames(response, 2, controller);
    const ids = frames.map((frame) => Number(frame.id));
    expect(ids).toEqual([Number(second.seq), Number(third.seq)]);
    expect(new Set(ids).size).toBe(ids.length);

    // A real Last-Event-ID reconnect after the second row yields only the third,
    // exactly once.
    const resumedController = new AbortController();
    const resumedResponse = await fetch(`${baseUrl}/api/v1/events`, {
      headers: {
        cookie,
        accept: 'text/event-stream',
        'last-event-id': String(second.seq),
      },
      signal: resumedController.signal,
    });
    const resumed = await readFrames(resumedResponse, 1, resumedController);
    expect(resumed.map((frame) => Number(frame.id))).toEqual([Number(third.seq)]);
  }, 20_000);
});
