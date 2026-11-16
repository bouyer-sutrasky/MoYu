import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BridgeEvent } from '@moyu/runtime-client';
import { RuntimeBridgeClient } from '@moyu/runtime-client';

import type { DispatcherLogger } from '../../src/logger';
import type { RepositoryBinding } from '../../src/runtime';
import { recoverIgnoredLeases, syncOnce } from '../../src/sync';
import { createTestDatabase, type TestDatabase } from './helpers';

interface FakeBridge {
  url: string;
  events: BridgeEvent[];
  server: Server;
  close: () => Promise<void>;
}

async function startFakeBridge(events: BridgeEvent[]): Promise<FakeBridge> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/bridge/v1/events') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const page = events.filter((event) => event.seq > after).slice(0, limit);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ events: page, next: page.at(-1)?.seq ?? after, hasMore: false }));
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

describe('ignored admission releases the execution lease on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let bridge: FakeBridge;
  let client: RuntimeBridgeClient;
  let logger: ReturnType<typeof silentLogger>;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    bridge = await startFakeBridge([]);
    client = new RuntimeBridgeClient({ baseUrl: bridge.url, token: 'bridge-token' });
    logger = silentLogger();
  });

  afterEach(async () => {
    await bridge?.close();
    await testDatabase?.drop();
  });

  it('closes the task, releases only its lease, and frees the repository slot', async () => {
    const owner = await testDatabase.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('ignored decision owner') returning id`,
    );
    const ownerId = owner.rows[0]!.id;
    const repository = await testDatabase.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name) values ($1, 'Bouyer12/ignored-lease') returning id`,
      [ownerId],
    );
    const repositoryId = repository.rows[0]!.id;
    const conversation = await testDatabase.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, source)
       values ($1, $2, 'work', 'discuss', 'main', 'web') returning id`,
      [ownerId, repositoryId],
    );
    const conversationId = conversation.rows[0]!.id;
    const message = await testDatabase.pool.query<{ id: string }>(
      `insert into messages (conversation_id, direction, kind, body, source)
       values ($1, 'inbound', 'user', 'not ticket work', 'web') returning id`,
      [conversationId],
    );
    const messageId = message.rows[0]!.id;
    const task = await testDatabase.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, state, base_branch, execution_mode)
       values ($1, $2, 'pending_admission', 'main', 'discuss') returning id`,
      [conversationId, repositoryId],
    );
    const taskId = task.rows[0]!.id;
    const lease = await testDatabase.pool.query<{ id: string }>(
      `insert into runtime_leases (repository_id, holder_id, expires_at)
       values ($1, $2, now() + interval '1 hour') returning id`,
      [repositoryId, `task:${taskId}`],
    );
    await testDatabase.pool.query(
      `update task_links set runtime_lease_id = $2 where id = $1`,
      [taskId, lease.rows[0]!.id],
    );

    bridge.events.push({
      seq: 1,
      id: 'ignored-decision-1',
      type: 'decision.ignored',
      at: new Date().toISOString(),
      data: {
        decisionId: 'decision-ignore-1',
        conversationId,
        messageId,
        messageIds: [messageId],
        threadKey: `workspace:${conversationId}`,
        reason: [{ code: 'said', values: { text: 'no ticket work' } }],
        at: new Date().toISOString(),
      },
    });

    const binding: RepositoryBinding = {
      id: repositoryId,
      fullName: 'Bouyer12/ignored-lease',
      defaultBranch: 'main',
      bridgeUrl: bridge.url,
      bridgeCredentialRef: null,
    };
    expect(await syncOnce(testDatabase.pool, binding, client, logger)).toBe(true);

    const updatedTask = await testDatabase.pool.query<{
      state: string;
      runtime_lease_id: string | null;
    }>('select state, runtime_lease_id from task_links where id = $1', [taskId]);
    expect(updatedTask.rows[0]).toEqual({
      state: 'not_accepted',
      runtime_lease_id: null,
    });
    const released = await testDatabase.pool.query<{
      state: string;
      recovery_reason: string;
    }>('select state, recovery_reason from runtime_leases where id = $1', [lease.rows[0]!.id]);
    expect(released.rows[0]).toEqual({
      state: 'released',
      recovery_reason: 'ignored_decision',
    });

    // The partial unique index permits a new holder only after the ignored
    // holder has actually released the slot.
    const nextLease = await testDatabase.pool.query<{ id: string }>(
      `insert into runtime_leases (repository_id, holder_id, expires_at)
       values ($1, 'task:next', now() + interval '1 hour') returning id`,
      [repositoryId],
    );
    expect(nextLease.rows[0]?.id).toBeTruthy();
    expect(await syncOnce(testDatabase.pool, binding, client, logger)).toBe(false);
  }, 30_000);

  it('recovers an active lease left behind by an older ignored admission', async () => {
    const owner = await testDatabase.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('ignored recovery owner') returning id`,
    );
    const ownerId = owner.rows[0]!.id;
    const repository = await testDatabase.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name) values ($1, 'Bouyer12/ignored-recovery') returning id`,
      [ownerId],
    );
    const repositoryId = repository.rows[0]!.id;
    const conversation = await testDatabase.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, source)
       values ($1, $2, 'work', 'discuss', 'main', 'web') returning id`,
      [ownerId, repositoryId],
    );
    const task = await testDatabase.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, state, base_branch)
       values ($1, $2, 'not_accepted', 'main') returning id`,
      [conversation.rows[0]!.id, repositoryId],
    );
    const lease = await testDatabase.pool.query<{ id: string }>(
      `insert into runtime_leases (repository_id, holder_id, expires_at)
       values ($1, $2, now() + interval '1 hour') returning id`,
      [repositoryId, `task:${task.rows[0]!.id}`],
    );
    await testDatabase.pool.query(`update task_links set runtime_lease_id = $2 where id = $1`, [
      task.rows[0]!.id,
      lease.rows[0]!.id,
    ]);

    expect(await recoverIgnoredLeases(testDatabase.pool, repositoryId, logger)).toBe(1);
    const leaseState = await testDatabase.pool.query<{ state: string; recovery_reason: string }>(
      'select state, recovery_reason from runtime_leases where id = $1',
      [lease.rows[0]!.id],
    );
    expect(leaseState.rows[0]).toEqual({
      state: 'released',
      recovery_reason: 'ignored_decision_recovery',
    });
    const taskState = await testDatabase.pool.query<{ runtime_lease_id: string | null }>(
      'select runtime_lease_id from task_links where id = $1',
      [task.rows[0]!.id],
    );
    expect(taskState.rows[0]?.runtime_lease_id).toBeNull();
  }, 30_000);
});
