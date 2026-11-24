import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BridgeEvent } from '@moyu/runtime-client';
import { RuntimeBridgeClient } from '@moyu/runtime-client';

import { acquireExecutionLease, type ExecutionLease } from '../../src/leases';
import type { DispatcherLogger } from '../../src/logger';
import type { RepositoryBinding } from '../../src/runtime';
import { applyEvent, recoverIgnoredLeases, syncOnce } from '../../src/sync';
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
      response.end(
        JSON.stringify({ events: page, next: page.at(-1)?.seq ?? after, hasMore: false }),
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

interface Fixture {
  ownerId: string;
  repositoryId: string;
  binding: RepositoryBinding;
}

function ignoredEventForMessages(
  conversationId: string,
  messageIds: string[],
  id: string,
  reason?: Array<{ code: string; values?: Record<string, unknown> }>,
): BridgeEvent {
  return {
    seq: 1,
    id,
    type: 'decision.ignored',
    at: '2026-11-20T00:00:00.000Z',
    data: {
      decisionId: `decision-${id}`,
      triggerIds: messageIds.map((messageId) => `workspace:${messageId}`),
      conversationId,
      messageId: messageIds[0],
      messageIds,
      threadKey: `workspace:${conversationId}`,
      reason: reason ?? [{ code: 'said', values: { text: 'not ticket work' } }],
      at: '2026-11-20T00:00:00.000Z',
    },
  };
}

function ignoredEvent(
  conversationId: string,
  messageId: string,
  id: string,
  reason?: Array<{ code: string; values?: Record<string, unknown> }>,
): BridgeEvent {
  return ignoredEventForMessages(conversationId, [messageId], id, reason);
}

describe('ignored admission settles its execution generation on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let bridge: FakeBridge;
  let client: RuntimeBridgeClient;
  let logger: ReturnType<typeof silentLogger>;
  let suffix = 0;

  beforeEach(async () => {
    testDatabase = await createTestDatabase();
    bridge = await startFakeBridge([]);
    client = new RuntimeBridgeClient({ baseUrl: bridge.url, token: 'bridge-token' });
    logger = silentLogger();
    suffix += 1;
  });

  afterEach(async () => {
    await bridge?.close();
    await testDatabase?.drop();
  });

  async function seedRepository(): Promise<Fixture> {
    const owner = await testDatabase.pool.query<{ id: string }>(
      `insert into owners (display_name) values ($1) returning id`,
      [`ignored lease owner ${process.pid}-${suffix}`],
    );
    const ownerId = owner.rows[0]!.id;
    const fullName = `Bouyer12/ignored-lease-${process.pid}-${suffix}`;
    const repository = await testDatabase.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name) values ($1, $2) returning id`,
      [ownerId, fullName],
    );
    const repositoryId = repository.rows[0]!.id;
    return {
      ownerId,
      repositoryId,
      binding: {
        id: repositoryId,
        fullName,
        defaultBranch: 'main',
        bridgeUrl: bridge.url,
        bridgeCredentialRef: null,
      },
    };
  }

  async function seedConversation(fixture: Fixture): Promise<string> {
    const conversation = await testDatabase.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, source)
       values ($1, $2, 'work', 'discuss', 'main', 'web') returning id`,
      [fixture.ownerId, fixture.repositoryId],
    );
    return conversation.rows[0]!.id;
  }

  async function seedMessage(conversationId: string, body: string): Promise<string> {
    const message = await testDatabase.pool.query<{ id: string }>(
      `insert into messages (conversation_id, direction, kind, body, source)
       values ($1, 'inbound', 'user', $2, 'web') returning id`,
      [conversationId, body],
    );
    return message.rows[0]!.id;
  }

  async function seedTask(
    fixture: Fixture,
    conversationId: string,
    options: { state?: string; ticketId?: string | null } = {},
  ): Promise<string> {
    const task = await testDatabase.pool.query<{ id: string }>(
      `insert into task_links
         (conversation_id, repository_id, state, base_branch, upstream_ticket_id)
       values ($1, $2, $3, 'main', $4) returning id`,
      [
        conversationId,
        fixture.repositoryId,
        options.state ?? 'pending_admission',
        options.ticketId ?? null,
      ],
    );
    return task.rows[0]!.id;
  }

  async function acquireLease(fixture: Fixture, taskId: string): Promise<ExecutionLease> {
    const account = await acquireExecutionLease(
      testDatabase.pool,
      fixture.repositoryId,
      { taskId, reason: 'ignored admission fixture' },
      3_600_000,
    );
    if (!account.lease) throw new Error(`lease unavailable: ${account.refused}`);
    return account.lease;
  }

  async function bindDeliveryEvidence(
    messageId: string,
    leaseId: string | null,
    fencingToken: string | null,
    state: 'pending' | 'delivering' | 'delivered' = 'delivered',
  ): Promise<void> {
    await testDatabase.pool.query(
      `insert into deliveries
         (message_id, state, delivered_at, handed_to_worker_at, runtime_lease_id, fencing_token)
       values ($1, $2, now(), now(), $3, $4::bigint)
       on conflict (message_id) do update
         set state = excluded.state, runtime_lease_id = excluded.runtime_lease_id,
             fencing_token = excluded.fencing_token, delivered_at = excluded.delivered_at,
             handed_to_worker_at = excluded.handed_to_worker_at`,
      [messageId, state, leaseId, fencingToken],
    );
  }

  async function bindDelivery(
    messageId: string,
    lease: ExecutionLease,
    state: 'pending' | 'delivering' | 'delivered' = 'delivered',
  ): Promise<void> {
    await bindDeliveryEvidence(messageId, lease.id, lease.fencingToken, state);
  }

  async function reserve(
    fixture: Fixture,
    taskId: string,
    lease: ExecutionLease,
    state: 'reserved' | 'claimed',
  ): Promise<void> {
    await testDatabase.pool.query(
      `insert into execution_reservations
         (repository_id, task_id, ticket_id, assignment_id, lease_id, fencing_token, request_key, state)
       values ($1, $2, 'ticket-unstarted', $3, $4, $5, $6, $7)`,
      [
        fixture.repositoryId,
        taskId,
        'a'.repeat(32),
        lease.id,
        lease.fencingToken,
        `admit:${taskId}:${lease.fencingToken}`,
        state,
      ],
    );
  }

  async function readTask(taskId: string) {
    const result = await testDatabase.pool.query(
      `select state, runtime_lease_id as "runtimeLeaseId", stop_evidence as "stopEvidence"
         from task_links where id = $1`,
      [taskId],
    );
    return result.rows[0] as Record<string, unknown>;
  }

  async function readLease(leaseId: string) {
    const result = await testDatabase.pool.query(
      `select state, recovery_state as "recoveryState", recovery_reason as "recoveryReason",
              waiting_for as "waitingFor", stop_proof as "stopProof"
         from runtime_leases where id = $1`,
      [leaseId],
    );
    return result.rows[0] as Record<string, unknown>;
  }

  async function releaseEventCount(leaseId: string): Promise<number> {
    const result = await testDatabase.pool.query<{ count: number }>(
      `select count(*)::int as count from runtime_lease_events
        where lease_id = $1 and type = 'released'`,
      [leaseId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function evidenceFailureDetails(leaseId: string): Promise<Record<string, unknown>[]> {
    const result = await testDatabase.pool.query<{ detail: Record<string, unknown> }>(
      `select detail from runtime_lease_events
        where lease_id = $1 and type = 'ignored_evidence_rejected'
        order by created_at`,
      [leaseId],
    );
    return result.rows.map((row) => row.detail);
  }

  async function reservationState(leaseId: string): Promise<string | null> {
    const result = await testDatabase.pool.query<{ state: string }>(
      `select state from execution_reservations where lease_id = $1`,
      [leaseId],
    );
    return result.rows[0]?.state ?? null;
  }

  it('settles the unstarted generation and frees the repository slot for the next task', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const messageId = await seedMessage(conversationId, 'ignored probe');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, lease);
    await reserve(fixture, taskId, lease, 'reserved');
    bridge.events.push(ignoredEvent(conversationId, messageId, `settle:${taskId}`));

    expect(await syncOnce(testDatabase.pool, fixture.binding, client, logger)).toBe(true);

    expect(await readTask(taskId)).toMatchObject({
      state: 'not_accepted',
      runtimeLeaseId: null,
      stopEvidence: { leaseSettlement: { kind: 'admission_ignored', noRuntimeTicket: true } },
    });
    expect(await readLease(lease.id)).toMatchObject({
      state: 'released',
      stopProof: { kind: 'admission_ignored', decisionId: `decision-settle:${taskId}` },
    });
    const reservation = await testDatabase.pool.query<{ state: string }>(
      `select state from execution_reservations where lease_id = $1`,
      [lease.id],
    );
    expect(reservation.rows[0]?.state).toBe('abandoned');
    expect(await releaseEventCount(lease.id)).toBe(1);

    // The next task in the same repository must obtain a new generation now,
    // not after the old lease's one-hour TTL.
    const next = await acquireExecutionLease(
      testDatabase.pool,
      fixture.repositoryId,
      { reason: 'after the ignored admission settled' },
      60_000,
    );
    expect(next.refused).toBeNull();
    expect(next.lease?.id).not.toBe(lease.id);
    expect(Number(next.lease?.fencingToken)).toBeGreaterThan(Number(lease.fencingToken));
  }, 30_000);

  it('keeps the task, reservation and lease when one named message has no delivery', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const first = await seedMessage(conversationId, 'has a delivery');
    const missing = await seedMessage(conversationId, 'has no delivery row');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(first, lease);
    await reserve(fixture, taskId, lease, 'reserved');
    // The receipt names the messages in the opposite order of the deliveries.
    bridge.events.push(
      ignoredEventForMessages(conversationId, [missing, first], `missing:${taskId}`),
    );

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readTask(taskId)).toMatchObject({
      state: 'pending_admission',
      runtimeLeaseId: lease.id,
    });
    expect(await readLease(lease.id)).toMatchObject({ state: 'active', recoveryState: 'none' });
    expect(await reservationState(lease.id)).toBe('reserved');
    expect(await releaseEventCount(lease.id)).toBe(0);
    const failures = await evidenceFailureDetails(lease.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      missingMessageIds: [missing],
      reason: expect.stringContaining('without a delivery'),
    });
  }, 30_000);

  it('keeps the task, reservation and lease when a named delivery has no fencing token', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const messageId = await seedMessage(conversationId, 'delivery without a fence');
    const lease = await acquireLease(fixture, taskId);
    await bindDeliveryEvidence(messageId, lease.id, null);
    await reserve(fixture, taskId, lease, 'reserved');
    bridge.events.push(ignoredEvent(conversationId, messageId, `empty-token:${taskId}`));

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readTask(taskId)).toMatchObject({
      state: 'pending_admission',
      runtimeLeaseId: lease.id,
    });
    expect(await readLease(lease.id)).toMatchObject({ state: 'active', recoveryState: 'none' });
    expect(await reservationState(lease.id)).toBe('reserved');
    expect(await releaseEventCount(lease.id)).toBe(0);
    const failures = await evidenceFailureDetails(lease.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: expect.stringContaining('lacks a lease id or fencing token'),
      evidence: [{ messageId, leaseId: lease.id, fencingToken: null }],
    });
  }, 30_000);

  it('keeps the admission when deliveries on the same lease disagree about the fence', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const first = await seedMessage(conversationId, 'first conflicting delivery');
    const second = await seedMessage(conversationId, 'second conflicting delivery');
    const lease = await acquireLease(fixture, taskId);
    const otherToken = String(Number(lease.fencingToken) + 1);
    await bindDeliveryEvidence(first, lease.id, lease.fencingToken);
    await bindDeliveryEvidence(second, lease.id, otherToken);
    await reserve(fixture, taskId, lease, 'reserved');
    bridge.events.push(
      ignoredEventForMessages(conversationId, [first, second], `conflict:${taskId}`),
    );

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readTask(taskId)).toMatchObject({
      state: 'pending_admission',
      runtimeLeaseId: lease.id,
    });
    expect(await readLease(lease.id)).toMatchObject({ state: 'active', recoveryState: 'none' });
    expect(await reservationState(lease.id)).toBe('reserved');
    expect(await releaseEventCount(lease.id)).toBe(0);
    const failures = await evidenceFailureDetails(lease.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: expect.stringContaining('disagree about the fencing token'),
      evidence: [
        { messageId: first, leaseId: lease.id, fencingToken: lease.fencingToken },
        { messageId: second, leaseId: lease.id, fencingToken: otherToken },
      ],
    });
  }, 30_000);

  it('reaches the same refusal when the same conflicting evidence arrives in another order', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const first = await seedMessage(conversationId, 'first permuted delivery');
    const second = await seedMessage(conversationId, 'second permuted delivery');
    const lease = await acquireLease(fixture, taskId);
    const otherToken = String(Number(lease.fencingToken) + 1);
    // Insert and name the rows in the reverse order of the previous case.
    await bindDeliveryEvidence(second, lease.id, otherToken);
    await bindDeliveryEvidence(first, lease.id, lease.fencingToken);
    await reserve(fixture, taskId, lease, 'reserved');
    bridge.events.push(
      ignoredEventForMessages(conversationId, [second, first], `permuted:${taskId}`),
    );

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readTask(taskId)).toMatchObject({
      state: 'pending_admission',
      runtimeLeaseId: lease.id,
    });
    expect(await readLease(lease.id)).toMatchObject({ state: 'active', recoveryState: 'none' });
    expect(await reservationState(lease.id)).toBe('reserved');
    expect(await releaseEventCount(lease.id)).toBe(0);
    const failures = await evidenceFailureDetails(lease.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: expect.stringContaining('disagree about the fencing token'),
      evidence: [
        { messageId: second, leaseId: lease.id, fencingToken: otherToken },
        { messageId: first, leaseId: lease.id, fencingToken: lease.fencingToken },
      ],
    });
  }, 30_000);

  it('applies the same settlement to a routed decision and keeps its handoff target', async () => {
    const fixture = await seedRepository();
    const sourceConversationId = await seedConversation(fixture);
    const sourceTaskId = await seedTask(fixture, sourceConversationId);
    const sourceMessageId = await seedMessage(sourceConversationId, 'route me to the old PR');
    const sourceLease = await acquireLease(fixture, sourceTaskId);
    await bindDelivery(sourceMessageId, sourceLease);

    const targetConversationId = await seedConversation(fixture);
    const targetTicketId = `target-ticket-${process.pid}`;
    await seedTask(fixture, targetConversationId, {
      state: 'awaiting_review',
      ticketId: targetTicketId,
    });
    bridge.events.push(
      ignoredEvent(sourceConversationId, sourceMessageId, `routed:${sourceTaskId}`, [
        { code: 'routed', values: { ticket: targetTicketId } },
      ]),
    );

    expect(await syncOnce(testDatabase.pool, fixture.binding, client, logger)).toBe(true);

    const source = await testDatabase.pool.query<{
      state: string;
      runtimeLeaseId: string | null;
      decision: Record<string, unknown>;
    }>(
      `select state, runtime_lease_id as "runtimeLeaseId", decision
         from task_links where id = $1`,
      [sourceTaskId],
    );
    expect(source.rows[0]).toMatchObject({
      state: 'not_accepted',
      runtimeLeaseId: null,
      decision: {
        outcome: 'routed',
        targetTicketId,
        routingState: 'pending',
      },
    });
    expect(await readLease(sourceLease.id)).toMatchObject({ state: 'released' });
  }, 30_000);

  it('leaves the new generation alone when a late ignored receipt names the old one', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const messageId = await seedMessage(conversationId, 'old probe');
    const oldLease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, oldLease);
    await testDatabase.pool.query(
      `update runtime_leases set state = 'released', released_at = now() where id = $1`,
      [oldLease.id],
    );
    await testDatabase.pool.query(`update task_links set runtime_lease_id = null where id = $1`, [
      taskId,
    ]);
    const currentLease = await acquireLease(fixture, taskId);
    expect(currentLease.id).not.toBe(oldLease.id);
    bridge.events.push(ignoredEvent(conversationId, messageId, `late:${taskId}`));

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readTask(taskId)).toMatchObject({
      state: 'pending_admission',
      runtimeLeaseId: currentLease.id,
    });
    expect(await readLease(currentLease.id)).toMatchObject({ state: 'active' });
    expect(await releaseEventCount(currentLease.id)).toBe(0);
    const failures = await evidenceFailureDetails(currentLease.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: expect.stringContaining('different execution generation'),
    });
  }, 30_000);

  it('keeps the generation and records why when a runtime ticket may have executed', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId, {
      ticketId: `ticket-${process.pid}`,
    });
    const messageId = await seedMessage(conversationId, 'ignored but ticketed');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, lease);
    bridge.events.push(ignoredEvent(conversationId, messageId, `ticketed:${taskId}`));

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readTask(taskId)).toMatchObject({
      state: 'not_accepted',
      runtimeLeaseId: lease.id,
    });
    expect(await readLease(lease.id)).toMatchObject({
      state: 'active',
      recoveryState: 'blocked',
      waitingFor: 'execution_stop_proof',
      recoveryReason: expect.stringContaining('runtime ticket'),
    });
    expect(await releaseEventCount(lease.id)).toBe(0);
  }, 30_000);

  it('keeps the generation when a worker already claimed the reservation', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const messageId = await seedMessage(conversationId, 'ignored while claimed');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, lease);
    await reserve(fixture, taskId, lease, 'claimed');
    bridge.events.push(ignoredEvent(conversationId, messageId, `claimed:${taskId}`));

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readLease(lease.id)).toMatchObject({
      state: 'active',
      recoveryState: 'blocked',
      recoveryReason: expect.stringContaining('claimed'),
    });
    expect(await readTask(taskId)).toMatchObject({ runtimeLeaseId: lease.id });
  }, 30_000);

  it('keeps the generation while a command is still queued on it', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const messageId = await seedMessage(conversationId, 'ignored with a queued command');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, lease);
    await testDatabase.pool.query(
      `insert into task_operations
         (task_id, repository_id, kind, client_command_id, request_fingerprint, state)
       values ($1, $2, 'start', 'queued-command', 'fingerprint', 'queued')`,
      [taskId, fixture.repositoryId],
    );
    bridge.events.push(ignoredEvent(conversationId, messageId, `queued:${taskId}`));

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readLease(lease.id)).toMatchObject({
      state: 'active',
      recoveryState: 'blocked',
      recoveryReason: expect.stringContaining('command'),
    });
    expect(await readTask(taskId)).toMatchObject({ runtimeLeaseId: lease.id });
  }, 30_000);

  it('leaves the admission and generation open while another delivery is in flight', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const messageId = await seedMessage(conversationId, 'ignored with an in-flight sibling');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, lease);
    const siblingMessageId = await seedMessage(conversationId, 'still being delivered');
    await bindDelivery(siblingMessageId, lease, 'delivering');
    bridge.events.push(ignoredEvent(conversationId, messageId, `delivery:${taskId}`));

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    // The acceptance guard keeps the pending admission open for the in-flight
    // message; nothing about this generation may be settled yet.
    expect(await readTask(taskId)).toMatchObject({
      state: 'pending_admission',
      runtimeLeaseId: lease.id,
    });
    expect(await readLease(lease.id)).toMatchObject({ state: 'active' });
    expect(await releaseEventCount(lease.id)).toBe(0);
  }, 30_000);

  it('keeps the admission when the delivery fence disagrees with the locked lease row', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const messageId = await seedMessage(conversationId, 'mismatched fence probe');
    const lease = await acquireLease(fixture, taskId);
    await bindDeliveryEvidence(messageId, lease.id, String(Number(lease.fencingToken) + 1));
    await reserve(fixture, taskId, lease, 'reserved');
    bridge.events.push(ignoredEvent(conversationId, messageId, `fence:${taskId}`));

    await syncOnce(testDatabase.pool, fixture.binding, client, logger);

    expect(await readTask(taskId)).toMatchObject({
      state: 'pending_admission',
      runtimeLeaseId: lease.id,
    });
    expect(await readLease(lease.id)).toMatchObject({ state: 'active', recoveryState: 'none' });
    expect(await reservationState(lease.id)).toBe('reserved');
    expect(await releaseEventCount(lease.id)).toBe(0);
    const failures = await evidenceFailureDetails(lease.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: expect.stringContaining('does not match the delivery evidence'),
    });
  }, 30_000);

  it('settles once when two dispatchers apply the same ignored receipt together', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId);
    const messageId = await seedMessage(conversationId, 'concurrent ignored probe');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, lease);
    await reserve(fixture, taskId, lease, 'reserved');
    const event = ignoredEvent(conversationId, messageId, `concurrent:${taskId}`);

    const applyOnce = async () => {
      const connection = await testDatabase.pool.connect();
      try {
        await connection.query('begin');
        await applyEvent(connection, fixture.binding, event, logger);
        await connection.query('commit');
      } catch (error) {
        await connection.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    };
    await Promise.all([applyOnce(), applyOnce()]);

    expect(await readTask(taskId)).toMatchObject({
      state: 'not_accepted',
      runtimeLeaseId: null,
    });
    expect(await readLease(lease.id)).toMatchObject({ state: 'released' });
    expect(await releaseEventCount(lease.id)).toBe(1);
    const reservations = await testDatabase.pool.query<{ state: string }>(
      `select state from execution_reservations where lease_id = $1`,
      [lease.id],
    );
    expect(reservations.rows[0]?.state).toBe('abandoned');
  }, 30_000);

  it('settles a historical not_accepted admission that never created a runtime ticket', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId, { state: 'not_accepted' });
    const messageId = await seedMessage(conversationId, 'pre-existing stranded admission');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, lease);
    await reserve(fixture, taskId, lease, 'reserved');

    expect(await recoverIgnoredLeases(testDatabase.pool, fixture.repositoryId, logger)).toBe(1);

    expect(await readTask(taskId)).toMatchObject({ runtimeLeaseId: null });
    expect(await readLease(lease.id)).toMatchObject({
      state: 'released',
      stopProof: { kind: 'admission_ignored' },
    });
    const reservation = await testDatabase.pool.query<{ state: string }>(
      `select state from execution_reservations where lease_id = $1`,
      [lease.id],
    );
    expect(reservation.rows[0]?.state).toBe('abandoned');
  }, 30_000);

  it('keeps a historical admission whose runtime ticket may have executed', async () => {
    const fixture = await seedRepository();
    const conversationId = await seedConversation(fixture);
    const taskId = await seedTask(fixture, conversationId, {
      state: 'not_accepted',
      ticketId: `ticket-unproven-${process.pid}`,
    });
    const messageId = await seedMessage(conversationId, 'unproven stranded admission');
    const lease = await acquireLease(fixture, taskId);
    await bindDelivery(messageId, lease);

    expect(await recoverIgnoredLeases(testDatabase.pool, fixture.repositoryId, logger)).toBe(0);

    expect(await readTask(taskId)).toMatchObject({ runtimeLeaseId: lease.id });
    expect(await readLease(lease.id)).toMatchObject({
      state: 'active',
      recoveryState: 'blocked',
      waitingFor: 'execution_stop_proof',
    });
  }, 30_000);
});
