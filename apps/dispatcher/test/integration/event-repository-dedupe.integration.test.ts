import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BridgeEvent } from '@moyu/runtime-client';
import { RuntimeBridgeClient } from '@moyu/runtime-client';

import type { DispatcherLogger } from '../../src/logger';
import type { RepositoryBinding } from '../../src/runtime';
import { syncOnce } from '../../src/sync';
import { createTestDatabase, type TestDatabase } from './helpers';

interface FakeBridge {
  url: string;
  events: BridgeEvent[];
  server: Server;
  close: () => Promise<void>;
}

/** A real HTTP Bridge stand-in that serves the supplied event log by cursor. */
async function startFakeBridge(events: BridgeEvent[]): Promise<FakeBridge> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/bridge/v1/events') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const page = events.filter((event) => event.seq > after).slice(0, limit);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          events: page,
          next: page.at(-1)?.seq ?? after,
          hasMore: false,
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'route not found' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake bridge did not listen');
  return {
    url: `http://127.0.0.1:${address.port}`,
    events,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function silentLogger(): DispatcherLogger & { records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const write = (level: string) => (fields: Record<string, unknown>, message: string) => {
    records.push({ level, ...fields, message });
  };
  return { records, info: write('info'), warn: write('warn'), error: write('error') };
}

describe('repository-scoped Bridge event dedupe on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let ownerId: string;
  let repositoryAId: string;
  let repositoryBId: string;
  let bridgeA: FakeBridge;
  let bridgeB: FakeBridge;
  let clientA: RuntimeBridgeClient;
  let clientB: RuntimeBridgeClient;
  let logger: ReturnType<typeof silentLogger>;

  const binding = (id: string, fullName: string, bridge: FakeBridge): RepositoryBinding => ({
    id,
    fullName,
    defaultBranch: 'main',
    bridgeUrl: bridge.url,
    bridgeCredentialRef: null,
  });

  async function seedTask(repositoryId: string, ticketId: string): Promise<string> {
    const conversation = await testDatabase.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, source)
       values ($1, $2, 'work', 'execute', 'main', 'web') returning id`,
      [ownerId, repositoryId],
    );
    const task = await testDatabase.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, state, base_branch, upstream_ticket_id)
       values ($1, $2, 'running', 'main', $3) returning id`,
      [conversation.rows[0]!.id, repositoryId, ticketId],
    );
    return task.rows[0]!.id;
  }

  async function questionOf(taskId: string): Promise<string | null> {
    const result = await testDatabase.pool.query<{ question: string | null }>(
      'select question from task_links where id = $1',
      [taskId],
    );
    return result.rows[0]?.question ?? null;
  }

  async function cursorOf(repositoryId: string): Promise<string> {
    const result = await testDatabase.pool.query<{ cursor: string }>(
      'select cursor from runtime_cursors where repository_id = $1',
      [repositoryId],
    );
    return result.rows[0]?.cursor ?? '<missing>';
  }

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    const owner = await testDatabase.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('event dedupe owner') returning id`,
    );
    ownerId = owner.rows[0]!.id;
    const repoA = await testDatabase.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name) values ($1, 'Bouyer12/event-dedupe-a') returning id`,
      [ownerId],
    );
    const repoB = await testDatabase.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name) values ($1, 'Bouyer12/event-dedupe-b') returning id`,
      [ownerId],
    );
    repositoryAId = repoA.rows[0]!.id;
    repositoryBId = repoB.rows[0]!.id;
    bridgeA = await startFakeBridge([]);
    bridgeB = await startFakeBridge([]);
    clientA = new RuntimeBridgeClient({ baseUrl: bridgeA.url, token: 'bridge-token-a' });
    clientB = new RuntimeBridgeClient({ baseUrl: bridgeB.url, token: 'bridge-token-b' });
    logger = silentLogger();
  });

  afterEach(async () => {
    await bridgeA?.close();
    await bridgeB?.close();
    await testDatabase?.drop();
  });

  it('projects one shared provider event id once in each repository and not twice in one', async () => {
    const taskA = await seedTask(repositoryAId, 'ticket-a');
    const taskB = await seedTask(repositoryBId, 'ticket-b');
    const at = new Date().toISOString();
    bridgeA.events.push({
      seq: 1,
      id: 'shared-provider-event',
      type: 'ticket.question',
      at,
      data: { ticketId: 'ticket-a', question: 'question for repository A' },
    });
    bridgeB.events.push({
      seq: 1,
      id: 'shared-provider-event',
      type: 'ticket.question',
      at,
      data: { ticketId: 'ticket-b', question: 'question for repository B' },
    });

    expect(
      await syncOnce(
        testDatabase.pool,
        binding(repositoryAId, 'Bouyer12/event-dedupe-a', bridgeA),
        clientA,
        logger,
      ),
    ).toBe(true);
    expect(
      await syncOnce(
        testDatabase.pool,
        binding(repositoryBId, 'Bouyer12/event-dedupe-b', bridgeB),
        clientB,
        logger,
      ),
    ).toBe(true);

    expect(await questionOf(taskA)).toBe('question for repository A');
    expect(await questionOf(taskB)).toBe('question for repository B');
    const rows = await testDatabase.pool.query<{ repository_id: string; count: number }>(
      `select repository_id, count(*)::int as count
         from events
        where source = 'bridge' and source_event_id = 'shared-provider-event'
        group by repository_id order by repository_id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => Number(row.count))).toEqual([1, 1]);

    // A replay of the same page in repository A must not create a second event
    // or re-apply the question projection.
    await testDatabase.pool.query(
      'update runtime_cursors set cursor = 0 where repository_id = $1',
      [repositoryAId],
    );
    await syncOnce(
      testDatabase.pool,
      binding(repositoryAId, 'Bouyer12/event-dedupe-a', bridgeA),
      clientA,
      logger,
    );
    expect(await questionOf(taskA)).toBe('question for repository A');
    const afterReplay = await testDatabase.pool.query<{ count: number }>(
      `select count(*)::int as count from events
        where repository_id = $1 and source_event_id = 'shared-provider-event'`,
      [repositoryAId],
    );
    expect(Number(afterReplay.rows[0]?.count)).toBe(1);
    expect(await cursorOf(repositoryAId)).toBe('1');
  }, 30_000);

  it('rolls back the projection and cursor together when the cursor write fails, then retries once', async () => {
    const taskA = await seedTask(repositoryAId, 'ticket-cursor');
    const at = new Date().toISOString();
    bridgeA.events.push({
      seq: 1,
      id: 'cursor-first',
      type: 'ticket.question',
      at,
      data: { ticketId: 'ticket-cursor', question: 'first question' },
    });
    await syncOnce(
      testDatabase.pool,
      binding(repositoryAId, 'Bouyer12/event-dedupe-a', bridgeA),
      clientA,
      logger,
    );
    expect(await questionOf(taskA)).toBe('first question');
    expect(await cursorOf(repositoryAId)).toBe('1');

    bridgeA.events.push({
      seq: 2,
      id: 'cursor-second',
      type: 'ticket.question',
      at,
      data: { ticketId: 'ticket-cursor', question: 'second question must roll back' },
    });
    await testDatabase.pool.query(`
      create function moyu_test_fail_cursor() returns trigger language plpgsql as $$
      begin
        raise exception 'injected cursor update failure';
      end $$;
      create trigger moyu_test_fail_cursor before update on runtime_cursors
        for each row execute function moyu_test_fail_cursor();
    `);
    try {
      await expect(
        syncOnce(
          testDatabase.pool,
          binding(repositoryAId, 'Bouyer12/event-dedupe-a', bridgeA),
          clientA,
          logger,
        ),
      ).rejects.toThrow(/injected cursor update failure/);
    } finally {
      await testDatabase.pool.query(
        'drop trigger if exists moyu_test_fail_cursor on runtime_cursors; drop function if exists moyu_test_fail_cursor();',
      );
    }

    expect(await questionOf(taskA)).toBe('first question');
    expect(await cursorOf(repositoryAId)).toBe('1');
    const eventsWhileFailed = await testDatabase.pool.query<{ count: number }>(
      `select count(*)::int as count from events where repository_id = $1`,
      [repositoryAId],
    );
    expect(Number(eventsWhileFailed.rows[0]?.count)).toBe(1);

    await syncOnce(
      testDatabase.pool,
      binding(repositoryAId, 'Bouyer12/event-dedupe-a', bridgeA),
      clientA,
      logger,
    );
    expect(await questionOf(taskA)).toBe('second question must roll back');
    expect(await cursorOf(repositoryAId)).toBe('2');
    const eventsAfterRetry = await testDatabase.pool.query<{ count: number }>(
      `select count(*)::int as count from events where repository_id = $1`,
      [repositoryAId],
    );
    expect(Number(eventsAfterRetry.rows[0]?.count)).toBe(2);
  }, 30_000);

  it('treats an unrelated unique violation as an error instead of a duplicate', async () => {
    const taskA = await seedTask(repositoryAId, 'ticket-unexpected');
    bridgeA.events.push({
      seq: 1,
      id: 'unexpected-unique',
      type: 'ticket.question',
      at: new Date().toISOString(),
      data: { ticketId: 'ticket-unexpected', question: 'must not be committed' },
    });
    await testDatabase.pool.query(`
      create function moyu_test_unexpected_unique() returns trigger language plpgsql as $$
      begin
        raise exception 'injected unknown unique violation'
          using errcode = '23505', constraint = 'unexpected_projection_uq';
      end $$;
      create trigger moyu_test_unexpected_unique before insert on events
        for each row execute function moyu_test_unexpected_unique();
    `);
    try {
      await expect(
        syncOnce(
          testDatabase.pool,
          binding(repositoryAId, 'Bouyer12/event-dedupe-a', bridgeA),
          clientA,
          logger,
        ),
      ).rejects.toThrow(/injected unknown unique violation/);
    } finally {
      await testDatabase.pool.query(
        'drop trigger if exists moyu_test_unexpected_unique on events; drop function if exists moyu_test_unexpected_unique();',
      );
    }

    expect(await questionOf(taskA)).toBeNull();
    expect(await cursorOf(repositoryAId)).toBe('0');
    const events = await testDatabase.pool.query<{ count: number }>(
      'select count(*)::int as count from events',
    );
    expect(Number(events.rows[0]?.count)).toBe(0);

    await syncOnce(
      testDatabase.pool,
      binding(repositoryAId, 'Bouyer12/event-dedupe-a', bridgeA),
      clientA,
      logger,
    );
    expect(await questionOf(taskA)).toBe('must not be committed');
    expect(await cursorOf(repositoryAId)).toBe('1');
  }, 30_000);
});
