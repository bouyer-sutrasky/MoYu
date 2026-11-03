import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BridgeEvent, BridgeTriggerInput } from '@moyu/runtime-client';
import { RuntimeBridgeClient } from '@moyu/runtime-client';

import { loadDispatcherConfig, type DispatcherConfig } from '../../src/config';
import { deliverOnce } from '../../src/delivery';
import { createConsoleLogger } from '../../src/logger';
import { resolveRepository, type RepositoryBinding } from '../../src/runtime';
import { syncOnce } from '../../src/sync';
import { createTestDatabase, type TestDatabase } from './helpers';

interface FakeBridge {
  url: string;
  triggerCalls: BridgeTriggerInput[];
  events: BridgeEvent[];
  failNextTrigger: boolean;
  slowNextTrigger: boolean;
  server: Server;
  close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function startFakeBridge(events: BridgeEvent[]): Promise<FakeBridge> {
  const state = {
    triggerCalls: [] as BridgeTriggerInput[],
    events,
    failNextTrigger: false,
    slowNextTrigger: false,
  };
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== 'Bearer m3-test-bridge-token-0123456789') {
      send(401, { error: { code: 'unauthorized', message: 'machine token required' } });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/bridge/v1/triggers') {
      const body = (await readBody(request)) as BridgeTriggerInput;
      state.triggerCalls.push(body);
      if (state.failNextTrigger) {
        state.failNextTrigger = false;
        send(503, { error: { code: 'runtime_unavailable', message: 'retry', retryable: true } });
        return;
      }
      if (state.slowNextTrigger) {
        state.slowNextTrigger = false;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      send(200, {
        result: state.triggerCalls.length > 1 ? 'duplicate' : 'stored',
        triggerId: body.triggerId,
        baseCommit: 'a'.repeat(40),
        ticketId: state.triggerCalls.length > 1 ? 'ticket-1' : null,
      });
      return;
    }
    if (url.pathname === '/bridge/v1/events') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const page = state.events.filter((event) => event.seq > after).slice(0, limit);
      send(200, {
        events: page,
        next: page.at(-1)?.seq ?? after,
        hasMore: state.events.some((event) => event.seq > (page.at(-1)?.seq ?? after)),
      });
      return;
    }
    send(404, { error: { code: 'not_found', message: 'route not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake Bridge failed to listen');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    get triggerCalls() {
      return state.triggerCalls;
    },
    set failNextTrigger(value: boolean) {
      state.failNextTrigger = value;
    },
    get events() {
      return state.events;
    },
    set slowNextTrigger(value: boolean) {
      state.slowNextTrigger = value;
    },
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  } as FakeBridge;
}

describe('dispatcher delivery and Bridge event catch-up on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let fakeBridge: FakeBridge;
  let repository: RepositoryBinding;
  let config: DispatcherConfig;
  let client: RuntimeBridgeClient;
  let conversationId: string;
  let messageId: string;
  let ownerId: string;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    const now = new Date('2026-11-03T12:00:00.000Z');
    const owner = await testDatabase.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('M3 Dispatcher Owner') returning id`,
    );
    ownerId = owner.rows[0]!.id;
    conversationId = '';
    // The repository row needs the Bridge URL, so create it after the server listens.
    fakeBridge = await startFakeBridge([
      {
        seq: 1,
        id: 'ticket-linked:ticket-1',
        type: 'ticket.linked',
        at: now.toISOString(),
        data: {
          triggerId: 'workspace:placeholder',
          ticketId: 'ticket-1',
          conversationId: 'placeholder',
          messageId: 'placeholder',
          state: 'queued',
          title: 'M3 loop',
          base: {
            branch: 'main',
            commit: 'a'.repeat(40),
            model: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
          },
        },
      },
      {
        seq: 2,
        id: 'message-read:trigger-1',
        type: 'message.read',
        at: now.toISOString(),
        data: {
          triggerId: 'workspace:placeholder',
          messageId: 'placeholder',
          at: now.toISOString(),
        },
      },
      {
        seq: 3,
        id: 'progress-1',
        type: 'task.progress',
        at: now.toISOString(),
        data: { ticketId: 'ticket-1', text: 'Reading the repository', at: now.toISOString() },
      },
      {
        seq: 4,
        id: 'artifact-ticket-1',
        type: 'artifact.created',
        at: now.toISOString(),
        data: {
          ticketId: 'ticket-1',
          type: 'pull_request',
          url: 'https://github.com/Bouyer12/m3-loop-test/pull/7',
          number: 7,
          title: 'M3 loop',
        },
      },
      {
        seq: 5,
        id: 'ticket-ended:ticket-1',
        type: 'ticket.ended',
        at: now.toISOString(),
        data: { ticketId: 'ticket-1', by: 'executor', outcome: 'completed' },
      },
    ]);

    const repositoryRow = await testDatabase.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name, default_branch, status, bridge_url, bridge_credential_ref)
       values ($1, 'Bouyer12/m3-loop-test', 'main', 'active', $2, 'MOYU_BRIDGE_TOKEN')
       returning id`,
      [ownerId, fakeBridge.url],
    );
    const repositoryId = repositoryRow.rows[0]!.id;
    void ownerId;
    const conversationRow = await testDatabase.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, model_id, model_reasoning_effort, title)
       values ($1, $2, 'work', 'execute', 'main', 'commandcode/deepseek/deepseek-v4.1-flash', 'high', 'M3 loop')
       returning id`,
      [ownerId, repositoryId],
    );
    conversationId = conversationRow.rows[0]!.id;
    const messageRow = await testDatabase.pool.query<{ id: string }>(
      `insert into messages (conversation_id, direction, kind, client_message_id, body)
       values ($1, 'inbound', 'user', 'client-1', 'Run the M3 loop') returning id`,
      [conversationId],
    );
    messageId = messageRow.rows[0]!.id;
    await testDatabase.pool.query(
      `insert into deliveries (message_id, upstream_trigger_id) values ($1, $2)`,
      [messageId, `workspace:${messageId}`],
    );
    await testDatabase.pool.query(
      `insert into task_links (conversation_id, repository_id, state, base_branch, model_id, model_reasoning_effort)
       values ($1, $2, 'pending_admission', 'main', 'commandcode/deepseek/deepseek-v4.1-flash', 'high')`,
      [conversationId, repositoryId],
    );

    config = loadDispatcherConfig({
      NODE_ENV: 'test',
      DATABASE_URL: testDatabase.url,
      BRIDGE_REPOSITORY: 'Bouyer12/m3-loop-test',
      BRIDGE_TOKEN: 'm3-test-bridge-token-0123456789',
      DELIVERY_RETRY_CAP_MS: '1000',
    });
    const resolved = await resolveRepository(testDatabase.pool, config);
    if (!resolved) {
      throw new Error('repository binding missing');
    }
    repository = resolved;
    client = new RuntimeBridgeClient({
      baseUrl: fakeBridge.url,
      token: 'm3-test-bridge-token-0123456789',
    });
  }, 60_000);

  afterAll(async () => {
    if (fakeBridge) {
      await fakeBridge.close();
    }
    if (testDatabase) {
      await testDatabase.drop();
    }
  });

  it('retries a transient delivery with the same trigger id', async () => {
    fakeBridge.failNextTrigger = true;
    const first = await deliverOnce(
      testDatabase.pool,
      config,
      repository,
      client,
      createConsoleLogger('test'),
    );
    expect(first).toBe(true);
    const afterFirst = await testDatabase.pool.query(
      `select state, attempt_count, last_error from deliveries where message_id = $1`,
      [messageId],
    );
    expect(afterFirst.rows[0]).toMatchObject({ state: 'pending', attempt_count: 1 });
    expect(afterFirst.rows[0]?.last_error).toBeTruthy();

    await testDatabase.pool.query(
      `update deliveries set next_attempt_at = now() where message_id = $1`,
      [messageId],
    );
    const second = await deliverOnce(
      testDatabase.pool,
      config,
      repository,
      client,
      createConsoleLogger('test'),
    );
    expect(second).toBe(true);

    const afterSecond = await testDatabase.pool.query(
      `select state, attempt_count, delivered_at, upstream_trigger_id from deliveries where message_id = $1`,
      [messageId],
    );
    expect(afterSecond.rows[0]?.state).toBe('delivered');
    expect(afterSecond.rows[0]?.attempt_count).toBe(2);
    expect(afterSecond.rows[0]?.delivered_at).toBeTruthy();

    expect(fakeBridge.triggerCalls).toHaveLength(2);
    expect(new Set(fakeBridge.triggerCalls.map((call) => call.triggerId))).toEqual(
      new Set([`workspace:${messageId}`]),
    );
    const conversation = await testDatabase.pool.query(
      `select base_commit from conversations where id = $1`,
      [conversationId],
    );
    expect(conversation.rows[0]?.base_commit).toBe('a'.repeat(40));
    expect(fakeBridge.triggerCalls[0]?.executionSpec.model).toMatchObject({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      reasoningEffort: 'high',
    });
  });

  it('projects Bridge events once, advances the cursor and survives a repeat sync', async () => {
    // The fake events reference placeholders; make them point at this fixture.
    for (const event of fakeBridge.events) {
      event.data = {
        ...event.data,
        conversationId:
          event.data.conversationId === 'placeholder' ? conversationId : event.data.conversationId,
        messageId: event.data.messageId === 'placeholder' ? messageId : event.data.messageId,
        triggerId:
          event.data.triggerId === 'workspace:placeholder'
            ? `workspace:${messageId}`
            : event.data.triggerId,
      };
    }
    const logger = createConsoleLogger('test');
    expect(await syncOnce(testDatabase.pool, repository, client, logger)).toBe(true);
    expect(await syncOnce(testDatabase.pool, repository, client, logger)).toBe(false);

    const task = await testDatabase.pool.query(
      `select state, upstream_ticket_id, base_commit, pr_url, pr_number, question from task_links where conversation_id = $1`,
      [conversationId],
    );
    expect(task.rows[0]).toMatchObject({
      state: 'completed',
      upstream_ticket_id: 'ticket-1',
      pr_number: 7,
    });
    expect(task.rows[0]?.pr_url).toContain('/pull/7');

    const read = await testDatabase.pool.query(
      `select read_at from deliveries where message_id = $1`,
      [messageId],
    );
    expect(read.rows[0]?.read_at).toBeTruthy();

    const platformEvents = await testDatabase.pool.query<{ type: string; source_event_id: string }>(
      `select type, source_event_id from events where source = 'bridge' order by seq`,
    );
    expect(platformEvents.rows.map((row) => row.type)).toEqual([
      'task.linked',
      'message.delivery_changed',
      'task.progress',
      'artifact.created',
      'task.state_changed',
    ]);
    expect(platformEvents.rows.map((row) => row.source_event_id)).toEqual([
      'ticket-linked:ticket-1',
      'message-read:trigger-1',
      'progress-1',
      'artifact-ticket-1',
      'ticket-ended:ticket-1',
    ]);

    const cursor = await testDatabase.pool.query(
      `select cursor from runtime_cursors where repository_id = $1`,
      [repository.id],
    );
    expect(String(cursor.rows[0]?.cursor)).toBe('5');

    const artifacts = await testDatabase.pool.query(
      `select type, metadata from artifacts where task_id = (select id from task_links where conversation_id = $1)`,
      [conversationId],
    );
    expect(artifacts.rows).toHaveLength(1);
    expect(artifacts.rows[0]?.type).toBe('pull_request');
  });
});
