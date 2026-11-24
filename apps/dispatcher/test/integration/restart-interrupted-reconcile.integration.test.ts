import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BridgeEvent, BridgeTriggerInput } from '@moyu/runtime-client';
import { RuntimeBridgeClient } from '@moyu/runtime-client';

import { loadDispatcherConfig, type DispatcherConfig } from '../../src/config';
import { deliverOnce } from '../../src/delivery';
import { acquireExecutionLease } from '../../src/leases';
import { maintainLeases, reconcileTasks } from '../../src/operations';
import { claimExecution, reserveExecution } from '../../src/reservations';
import type { RepositoryBinding } from '../../src/runtime';
import { syncOnce } from '../../src/sync';
import { createTestDatabase, type TestDatabase } from './helpers';

const TOKEN = 'm5b-restart-reconcile-token-0123456789';
const TICKET = 'ticket-interrupted';

interface FakeBridge {
  url: string;
  events: BridgeEvent[];
  triggerCalls: BridgeTriggerInput[];
  startCalls: { ticketId: string; admission: unknown }[];
  snapshot: Record<string, unknown>;
  /** Runs before a ticket snapshot is returned, for in-flight interleavings. */
  onTicket?: (call: number) => Promise<void> | void;
  /** Overrides the snapshot per ticket call; undefined falls back to `snapshot`. */
  ticketResponder?: (call: number) => Record<string, unknown> | undefined;
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

/** A Bridge whose authoritative ticket record and event page a test scripts, as a restart leaves them. */
async function startFakeBridge(): Promise<FakeBridge> {
  const state = {
    events: [] as BridgeEvent[],
    triggerCalls: [] as BridgeTriggerInput[],
    startCalls: [] as { ticketId: string; admission: unknown }[],
    snapshot: {} as Record<string, unknown>,
    ticketCalls: 0,
    onTicket: undefined as FakeBridge['onTicket'],
    ticketResponder: undefined as FakeBridge['ticketResponder'],
  };
  const server: Server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { error: { code: 'unauthorized', message: 'machine token required' } });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/bridge/v1/capabilities') {
      send(200, {
        protocolVersion: 'moyu-bridge/1',
        upstream: { package: 'dsh-superagent', version: '0.1.0' },
        capabilities: {
          trigger: true,
          events: true,
          tickets: true,
          models: true,
          pause: true,
          resume: true,
          retry: true,
          readOnlyDiscussion: true,
          start: true,
          admission: true,
        },
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/bridge/v1/triggers') {
      const body = (await readBody(request)) as BridgeTriggerInput;
      state.triggerCalls.push(body);
      send(200, {
        result: 'stored',
        triggerId: body.triggerId,
        baseCommit: 'a'.repeat(40),
        ticketId: TICKET,
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
    const ticketMatch = /^\/bridge\/v1\/tickets\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && ticketMatch) {
      state.ticketCalls += 1;
      await state.onTicket?.(state.ticketCalls);
      send(200, state.ticketResponder?.(state.ticketCalls) ?? state.snapshot);
      return;
    }
    const startMatch = /^\/bridge\/v1\/tickets\/([^/]+)\/start$/.exec(url.pathname);
    if (request.method === 'POST' && startMatch) {
      state.startCalls.push({
        ticketId: decodeURIComponent(startMatch[1]!),
        admission: await readBody(request),
      });
      send(200, { ticketId: decodeURIComponent(startMatch[1]!), accepted: true });
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
    get events() {
      return state.events;
    },
    get triggerCalls() {
      return state.triggerCalls;
    },
    get startCalls() {
      return state.startCalls;
    },
    get snapshot() {
      return state.snapshot;
    },
    set snapshot(value: Record<string, unknown>) {
      state.snapshot = value;
    },
    get onTicket() {
      return state.onTicket;
    },
    set onTicket(value: FakeBridge['onTicket']) {
      state.onTicket = value;
    },
    get ticketResponder() {
      return state.ticketResponder;
    },
    set ticketResponder(value: FakeBridge['ticketResponder']) {
      state.ticketResponder = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The restart-reconciliation scenarios #39 left unverified, measured on the
 * platform side against the runtime's authoritative ticket record. The live
 * Bridge/dispatcher/two-database restart itself is a separate field run.
 *
 * 1. An interrupted turn. The host restart ends the running Assignment and
 *    re-issues one under the same lease and fencing token, sometimes without a
 *    state change. The platform adopts the Assignment named by the authoritative
 *    runtime record, keeps the reservation's existing keys, records the old and
 *    new value plus the source record, and continues only once.
 * 2. An Assignment named by a superseded turn must never move the reservation
 *    or the projection backwards, and a replay must not adopt twice.
 * 3. An open pull request awaiting review. A restart must neither start a worker
 *    nor drop the PR, and closing the PR must still end the ticket.
 * 4. A generation that is not the live one is never adopted.
 */
describe('restart reconciliation on real PostgreSQL', () => {
  let db: TestDatabase;
  let bridge: FakeBridge;
  let config: DispatcherConfig;
  let client: RuntimeBridgeClient;
  let ownerId = '';
  let sequence = 0;

  const pushEvent = (type: string, data: Record<string, unknown>) => {
    const seq = (bridge.events.at(-1)?.seq ?? 0) + 1;
    bridge.events.push({
      seq,
      id: `${type}:${seq}`,
      type,
      at: new Date(Date.UTC(2026, 10, 20, 5, 30, seq)).toISOString(),
      data,
    });
    return seq;
  };
  const cursor = async (repositoryId: string) => {
    const row = await db.pool.query<{ cursor: string }>(
      'select cursor from runtime_cursors where repository_id = $1',
      [repositoryId],
    );
    return Number(row.rows[0]?.cursor ?? 0);
  };
  const newConversation = async (repositoryId: string, title: string) => {
    sequence += 1;
    const conversation = await db.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, model_id, title)
       values ($1, $2, 'work', 'execute', 'main', 'commandcode/deepseek/deepseek-v4.1-flash', $3)
       returning id`,
      [ownerId, repositoryId, title],
    );
    return conversation.rows[0]!.id;
  };
  const newMessage = async (conversationId: string, body: string, delivered: boolean) => {
    sequence += 1;
    const message = await db.pool.query<{ id: string }>(
      `insert into messages (conversation_id, direction, kind, client_message_id, body)
       values ($1, 'inbound', 'user', $2, $3) returning id`,
      [conversationId, `restart-reconcile-${sequence}`, body],
    );
    const delivery = await db.pool.query<{ id: string }>(
      `insert into deliveries (message_id, upstream_trigger_id, state, delivered_at)
       values ($1, $2, $3, ${delivered ? 'now()' : 'null'}) returning id`,
      [
        message.rows[0]!.id,
        `workspace:${message.rows[0]!.id}`,
        delivered ? 'delivered' : 'pending',
      ],
    );
    return { messageId: message.rows[0]!.id, deliveryId: delivery.rows[0]!.id };
  };

  /** One repository per scenario, so a lease or cursor from one cannot leak into another. */
  const newRepository = async (suffix: string) => {
    const repo = await db.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name, default_branch, status, bridge_url, bridge_credential_ref)
       values ($1, $2, 'main', 'active', $3, 'MOYU_BRIDGE_TOKEN')
       returning id`,
      [ownerId, `Bouyer12/m5b-restart-${suffix}-${process.pid}`, bridge.url],
    );
    const id = repo.rows[0]!.id;
    await db.pool.query(`insert into runtime_cursors (repository_id) values ($1)`, [id]);
    return id;
  };
  const bindingFor = (repositoryId: string, suffix: string): RepositoryBinding => ({
    id: repositoryId,
    fullName: `Bouyer12/m5b-restart-${suffix}-${process.pid}`,
    defaultBranch: 'main',
    bridgeUrl: bridge.url,
    bridgeCredentialRef: 'MOYU_BRIDGE_TOKEN',
  });
  const snapshotFor = (
    binding: RepositoryBinding,
    assignmentId: string,
    state: string,
    leaseId: string,
    fencingToken: string,
    extra: Record<string, unknown> = {},
  ) => ({
    ticketId: TICKET,
    title: 'Restart reconcile',
    mode: 'execute',
    assignmentId,
    state,
    base: { repository: binding.fullName, branch: 'main', commit: 'a'.repeat(40) },
    admission: { leaseId, fencingToken },
    ...extra,
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    bridge = await startFakeBridge();
    const owner = await db.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('restart reconcile') returning id`,
    );
    ownerId = owner.rows[0]!.id;
    config = loadDispatcherConfig({
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      BRIDGE_REPOSITORY: `Bouyer12/m5b-restart-a-${process.pid}`,
      BRIDGE_TOKEN: TOKEN,
      DELIVERY_RETRY_CAP_MS: '1000',
    });
    client = new RuntimeBridgeClient({ baseUrl: bridge.url, token: TOKEN });
  }, 60_000);

  afterAll(async () => {
    await bridge.close();
    await db.drop();
  });

  it('adopts the assignment a restart re-issues under the same lease, records it once, and continues', async () => {
    const triggersBefore = bridge.triggerCalls.length;
    const repositoryId = await newRepository('interrupted');
    const binding = bindingFor(repositoryId, 'interrupted');
    const conversationId = await newConversation(repositoryId, 'interrupted turn');
    const first = await newMessage(conversationId, 'Run the interrupted turn', true);
    const task = await db.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, upstream_ticket_id, state, base_branch, model_id)
       values ($1, $2, $3, 'running', 'main', 'commandcode/deepseek/deepseek-v4.1-flash') returning id`,
      [conversationId, repositoryId, TICKET],
    );
    const taskId = task.rows[0]!.id;
    const lease = await acquireExecutionLease(db.pool, repositoryId, { taskId }, 3_600_000);
    expect(lease.lease).not.toBeNull();
    const leaseId = lease.lease!.id;
    const fencingToken = lease.lease!.fencingToken;
    await db.pool.query(
      `update deliveries set runtime_lease_id = $2, fencing_token = $3 where id = $1`,
      [first.deliveryId, leaseId, fencingToken],
    );
    const assignmentBeforeRestart = 'assignment-before-restart';
    const assignmentAfterRestart = 'assignment-after-restart';
    const reserved = await reserveExecution(db.pool, {
      repositoryId,
      requestKey: `admit:${taskId}`,
      taskId,
      ticketId: TICKET,
      assignmentId: assignmentBeforeRestart,
      leaseId,
      fencingToken,
    });
    const claimed = await claimExecution(db.pool, {
      repositoryId,
      requestKey: `admit:${taskId}`,
      taskId,
      ticketId: TICKET,
      assignmentId: assignmentBeforeRestart,
      leaseId,
      fencingToken,
    });
    expect(claimed.claimed).toBe(true);
    const before = await db.pool.query<{
      id: string;
      request_key: string;
      task_id: string;
      ticket_id: string;
      assignment_id: string;
      state: string;
    }>(
      `select id, request_key, task_id, ticket_id, assignment_id, state
         from execution_reservations where id = $1`,
      [reserved.id],
    );
    bridge.snapshot = snapshotFor(
      binding,
      assignmentBeforeRestart,
      'running',
      leaseId,
      fencingToken,
    );

    // The host restart ends the running Assignment and re-issues one under the
    // same lease and fencing token, while the projected state stays the same, so
    // no state event announces it. Only the authoritative runtime record does.
    bridge.snapshot = snapshotFor(binding, assignmentAfterRestart, 'queued', leaseId, fencingToken);
    await syncOnce(db.pool, binding, client, logger);

    const adopted = await db.pool.query<{
      id: string;
      request_key: string;
      task_id: string;
      ticket_id: string;
      assignment_id: string;
      lease_id: string;
      fencing_token: string;
      state: string;
    }>(
      `select id, request_key, task_id, ticket_id, assignment_id, lease_id, fencing_token, state
         from execution_reservations where id = $1`,
      [reserved.id],
    );
    expect(adopted.rows[0]).toMatchObject({
      id: before.rows[0]!.id,
      request_key: before.rows[0]!.request_key,
      task_id: before.rows[0]!.task_id,
      ticket_id: before.rows[0]!.ticket_id,
      lease_id: leaseId,
      fencing_token: fencingToken,
      assignment_id: assignmentAfterRestart,
      state: 'claimed',
    });
    const supersessions = await db.pool.query<{ detail: Record<string, unknown> }>(
      `select detail from runtime_lease_events
        where lease_id = $1 and type = 'assignment_superseded' order by created_at, id`,
      [leaseId],
    );
    expect(supersessions.rows).toHaveLength(1);
    expect(supersessions.rows[0]!.detail).toMatchObject({
      ticketId: TICKET,
      requestKey: `admit:${taskId}`,
      fromAssignmentId: assignmentBeforeRestart,
      toAssignmentId: assignmentAfterRestart,
      reservationState: 'claimed',
      source: 'bridge_snapshot',
    });
    expect(supersessions.rows[0]!.detail.sourceEventId ?? null).toBeNull();

    // Replaying the same authoritative record continues nothing: no second
    // adoption, no second ledger entry, no duplicate worker of any kind.
    await syncOnce(db.pool, binding, client, logger);
    const replayed = await db.pool.query<{ detail: Record<string, unknown> }>(
      `select detail from runtime_lease_events
        where lease_id = $1 and type = 'assignment_superseded'`,
      [leaseId],
    );
    expect(replayed.rows).toHaveLength(1);
    expect(await cursor(repositoryId)).toBe(0);

    // The re-issued Assignment starts and its state event advances the cursor.
    const runningSeq = pushEvent('ticket.state_changed', {
      ticketId: TICKET,
      state: 'running',
      assignmentId: assignmentAfterRestart,
      leaseId,
      fencingToken,
    });
    await syncOnce(db.pool, binding, client, logger);
    expect(await cursor(repositoryId)).toBe(runningSeq);
    const running = await db.pool.query<{ state: string }>(
      'select state from task_links where id = $1',
      [taskId],
    );
    expect(running.rows[0]!.state).toBe('running');

    // A late event from the replaced turn names the old Assignment under the
    // very same generation. It must neither move the reservation nor project.
    const lateSeq = pushEvent('ticket.state_changed', {
      ticketId: TICKET,
      state: 'queued',
      assignmentId: assignmentBeforeRestart,
      leaseId,
      fencingToken,
    });
    await syncOnce(db.pool, binding, client, logger);
    expect(await cursor(repositoryId)).toBe(lateSeq);
    const afterLate = await db.pool.query<{
      assignment_id: string;
      state: string;
      stop_evidence: Record<string, unknown>;
    }>(
      `select r.assignment_id, t.state, t.stop_evidence
         from execution_reservations r join task_links t on t.id = r.task_id
        where r.id = $1`,
      [reserved.id],
    );
    expect(afterLate.rows[0]).toMatchObject({
      assignment_id: assignmentAfterRestart,
      state: 'running',
      stop_evidence: { admissionProjection: 'stale_assignment' },
    });
    const stillOne = await db.pool.query<{ detail: Record<string, unknown> }>(
      `select detail from runtime_lease_events
        where lease_id = $1 and type = 'assignment_superseded'`,
      [leaseId],
    );
    expect(stillOne.rows).toHaveLength(1);

    // A real follow-up input reaches the same Ticket exactly once, under the
    // admission this Ticket already holds.
    const followUp = await newMessage(conversationId, 'Matrix restart follow-up', false);
    expect(await deliverOnce(db.pool, config, binding, client, logger, true)).toBe(true);
    const sent = bridge.triggerCalls.slice(triggersBefore);
    expect(sent.map((call) => call.messageId)).toEqual([followUp.messageId]);
    expect(sent[0]!.admission).toEqual({ leaseId, fencingToken });
    const delivery = await db.pool.query<{ state: string; runtime_lease_id: string }>(
      'select state, runtime_lease_id from deliveries where id = $1',
      [followUp.deliveryId],
    );
    expect(delivery.rows[0]).toMatchObject({ state: 'delivered', runtime_lease_id: leaseId });
    expect(await deliverOnce(db.pool, config, binding, client, logger, true)).toBe(false);
    expect(bridge.triggerCalls).toHaveLength(triggersBefore + 1);
  }, 60_000);

  it('never adopts an Assignment from a generation that is not the live one', async () => {
    const repositoryId = await newRepository('stale');
    const binding = bindingFor(repositoryId, 'stale');
    const conversationId = await newConversation(repositoryId, 'stale generation');
    const task = await db.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, upstream_ticket_id, state, base_branch, model_id)
       values ($1, $2, $3, 'running', 'main', 'commandcode/deepseek/deepseek-v4.1-flash') returning id`,
      [conversationId, repositoryId, TICKET],
    );
    const taskId = task.rows[0]!.id;
    const lease = await acquireExecutionLease(db.pool, repositoryId, { taskId }, 3_600_000);
    const leaseId = lease.lease!.id;
    const fencingToken = lease.lease!.fencingToken;
    const live = 'assignment-live';
    await reserveExecution(db.pool, {
      repositoryId,
      requestKey: `admit:${taskId}`,
      taskId,
      ticketId: TICKET,
      assignmentId: live,
      leaseId,
      fencingToken,
    });
    bridge.snapshot = snapshotFor(binding, live, 'running', leaseId, fencingToken);

    // A stale state event names another lease generation; it may neither project
    // queued/running nor move the reservation.
    pushEvent('ticket.state_changed', {
      ticketId: TICKET,
      state: 'queued',
      assignmentId: 'assignment-other-generation',
      leaseId: '00000000-0000-4000-8000-000000000000',
      fencingToken,
    });
    await syncOnce(db.pool, binding, client, logger);

    const reservation = await db.pool.query<{ assignment_id: string }>(
      `select assignment_id from execution_reservations
        where repository_id = $1 and request_key = $2`,
      [repositoryId, `admit:${taskId}`],
    );
    expect(reservation.rows[0]!.assignment_id).toBe(live);
    const supersessions = await db.pool.query(
      `select 1 from runtime_lease_events where lease_id = $1 and type = 'assignment_superseded'`,
      [leaseId],
    );
    expect(supersessions.rowCount).toBe(0);
    const evidence = await db.pool.query<{ stopEvidence: Record<string, unknown>; state: string }>(
      'select stop_evidence as "stopEvidence", state from task_links where id = $1',
      [taskId],
    );
    expect(evidence.rows[0]!.state).toBe('running');
    expect(evidence.rows[0]!.stopEvidence).toMatchObject({
      admissionProjection: 'stale_generation',
    });

    // The authoritative record names a foreign lease generation as well: the
    // recovery path keeps the reservation and records the mismatch.
    bridge.snapshot = {
      ...snapshotFor(binding, 'assignment-other-generation', 'running', leaseId, fencingToken),
      admission: { leaseId: '00000000-0000-4000-8000-000000000000', fencingToken },
    };
    await syncOnce(db.pool, binding, client, logger);
    const kept = await db.pool.query<{
      assignment_id: string;
      stop_evidence: Record<string, unknown>;
    }>(
      `select r.assignment_id, t.stop_evidence
         from execution_reservations r join task_links t on t.id = r.task_id
        where r.repository_id = $1 and r.request_key = $2`,
      [repositoryId, `admit:${taskId}`],
    );
    expect(kept.rows[0]!.assignment_id).toBe(live);
    expect(kept.rows[0]!.stop_evidence).toMatchObject({ admissionRecovery: 'snapshot_mismatch' });
    const stillNone = await db.pool.query(
      `select 1 from runtime_lease_events where lease_id = $1 and type = 'assignment_superseded'`,
      [leaseId],
    );
    expect(stillNone.rowCount).toBe(0);
  }, 60_000);

  it('keeps the newest Assignment when a stale snapshot lands after a newer adoption', async () => {
    const repositoryId = await newRepository('inflight');
    const binding = bindingFor(repositoryId, 'inflight');
    const conversationId = await newConversation(repositoryId, 'in-flight snapshot');
    const task = await db.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, upstream_ticket_id, state, base_branch, model_id)
       values ($1, $2, $3, 'running', 'main', 'commandcode/deepseek/deepseek-v4.1-flash') returning id`,
      [conversationId, repositoryId, TICKET],
    );
    const taskId = task.rows[0]!.id;
    const lease = await acquireExecutionLease(db.pool, repositoryId, { taskId }, 3_600_000);
    const leaseId = lease.lease!.id;
    const fencingToken = lease.lease!.fencingToken;
    const first = 'assignment-inflight-1';
    const older = 'assignment-inflight-2';
    const newest = 'assignment-inflight-3';
    await reserveExecution(db.pool, {
      repositoryId,
      requestKey: `admit:${taskId}`,
      taskId,
      ticketId: TICKET,
      assignmentId: first,
      leaseId,
      fencingToken,
    });
    await claimExecution(db.pool, {
      repositoryId,
      requestKey: `admit:${taskId}`,
      taskId,
      ticketId: TICKET,
      assignmentId: first,
      leaseId,
      fencingToken,
    });
    const staleSnapshot = snapshotFor(binding, older, 'queued', leaseId, fencingToken);
    const freshSnapshot = snapshotFor(binding, newest, 'queued', leaseId, fencingToken);
    let ticketCalls = 0;
    // While the recovery pass is returning the stale record, another pass adopts
    // the newer one. The stale pass must notice, re-read, and not write a
    // backward entry. The counter is local: the fake Bridge sees other tests too.
    bridge.onTicket = async () => {
      ticketCalls += 1;
      if (ticketCalls !== 1) return;
      const interleaved = await claimExecution(db.pool, {
        repositoryId,
        requestKey: `admit:${taskId}`,
        taskId,
        ticketId: TICKET,
        assignmentId: newest,
        leaseId,
        fencingToken,
        expectedAssignmentId: first,
        authoritative: {
          ticketId: TICKET,
          assignmentId: newest,
          leaseId,
          fencingToken,
          state: 'queued',
          sourceCursor: '0',
        },
      });
      expect(interleaved.supersededFrom).toBe(first);
    };
    bridge.ticketResponder = () => (ticketCalls === 1 ? staleSnapshot : freshSnapshot);

    try {
      await syncOnce(db.pool, binding, client, logger);
    } finally {
      bridge.onTicket = undefined;
      bridge.ticketResponder = undefined;
    }

    expect(ticketCalls).toBe(2);
    const reservation = await db.pool.query<{ assignment_id: string; state: string }>(
      `select assignment_id, state from execution_reservations
        where repository_id = $1 and request_key = $2`,
      [repositoryId, `admit:${taskId}`],
    );
    expect(reservation.rows[0]).toMatchObject({ assignment_id: newest, state: 'claimed' });
    const ledger = await db.pool.query<{ detail: Record<string, unknown> }>(
      `select detail from runtime_lease_events
        where lease_id = $1 and type = 'assignment_superseded'
        order by created_at, id`,
      [leaseId],
    );
    expect(ledger.rows.map((row) => row.detail)).toEqual([
      expect.objectContaining({
        fromAssignmentId: first,
        toAssignmentId: newest,
        source: 'bridge_snapshot',
      }),
    ]);
    expect(ledger.rows.some((row) => row.detail.toAssignmentId === older)).toBe(false);
  }, 60_000);

  it('never adopts backwards when the re-read record is still the stale one', async () => {
    const repositoryId = await newRepository('inflight-stale');
    const binding = bindingFor(repositoryId, 'inflight-stale');
    const conversationId = await newConversation(repositoryId, 'stale re-read');
    const task = await db.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, upstream_ticket_id, state, base_branch, model_id)
       values ($1, $2, $3, 'running', 'main', 'commandcode/deepseek/deepseek-v4.1-flash') returning id`,
      [conversationId, repositoryId, TICKET],
    );
    const taskId = task.rows[0]!.id;
    const lease = await acquireExecutionLease(db.pool, repositoryId, { taskId }, 3_600_000);
    const leaseId = lease.lease!.id;
    const fencingToken = lease.lease!.fencingToken;
    const first = 'assignment-stale-read-1';
    const stale = 'assignment-stale-read-2';
    const newest = 'assignment-stale-read-3';
    await reserveExecution(db.pool, {
      repositoryId,
      requestKey: `admit:${taskId}`,
      taskId,
      ticketId: TICKET,
      assignmentId: first,
      leaseId,
      fencingToken,
    });
    await claimExecution(db.pool, {
      repositoryId,
      requestKey: `admit:${taskId}`,
      taskId,
      ticketId: TICKET,
      assignmentId: first,
      leaseId,
      fencingToken,
    });
    const staleSnapshot = snapshotFor(binding, stale, 'queued', leaseId, fencingToken);
    let ticketCalls = 0;
    bridge.onTicket = async () => {
      ticketCalls += 1;
      if (ticketCalls !== 1) return;
      const interleaved = await claimExecution(db.pool, {
        repositoryId,
        requestKey: `admit:${taskId}`,
        taskId,
        ticketId: TICKET,
        assignmentId: newest,
        leaseId,
        fencingToken,
        expectedAssignmentId: first,
        authoritative: {
          ticketId: TICKET,
          assignmentId: newest,
          leaseId,
          fencingToken,
          state: 'queued',
          sourceCursor: '0',
        },
      });
      expect(interleaved.supersededFrom).toBe(first);
    };
    // Even the re-read still returns the old record. Without a per-Assignment
    // timestamp the platform cannot order it against the newer adoption, so it
    // must keep the reservation and leave the record for the next pass.
    bridge.ticketResponder = () => staleSnapshot;
    try {
      await syncOnce(db.pool, binding, client, logger);
    } finally {
      bridge.onTicket = undefined;
      bridge.ticketResponder = undefined;
    }

    expect(ticketCalls).toBe(2);
    const reservation = await db.pool.query<{ assignment_id: string; state: string }>(
      `select assignment_id, state from execution_reservations
        where repository_id = $1 and request_key = $2`,
      [repositoryId, `admit:${taskId}`],
    );
    expect(reservation.rows[0]).toMatchObject({ assignment_id: newest, state: 'claimed' });
    const ledger = await db.pool.query<{ detail: Record<string, unknown> }>(
      `select detail from runtime_lease_events
        where lease_id = $1 and type = 'assignment_superseded'
        order by created_at, id`,
      [leaseId],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]!.detail).toMatchObject({
      fromAssignmentId: first,
      toAssignmentId: newest,
    });

    // The next pass reloads the current reservation and adopts only a record
    // that agrees with it; the stale record is never written.
    bridge.ticketResponder = undefined;
    bridge.snapshot = snapshotFor(binding, newest, 'queued', leaseId, fencingToken);
    await syncOnce(db.pool, binding, client, logger);
    const after = await db.pool.query<{ assignment_id: string }>(
      `select assignment_id from execution_reservations
        where repository_id = $1 and request_key = $2`,
      [repositoryId, `admit:${taskId}`],
    );
    expect(after.rows[0]!.assignment_id).toBe(newest);
  }, 60_000);

  it('neither starts work nor drops the PR of an awaiting_review ticket across a restart, and ends it when the PR closes', async () => {
    const triggersBefore = bridge.triggerCalls.length;
    const repositoryId = await newRepository('review');
    const binding = bindingFor(repositoryId, 'review');
    const conversationId = await newConversation(repositoryId, 'awaiting review');
    const task = await db.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, upstream_ticket_id, state, base_branch, model_id)
       values ($1, $2, $3, 'awaiting_review', 'main', 'commandcode/deepseek/deepseek-v4.1-flash') returning id`,
      [conversationId, repositoryId, TICKET],
    );
    const taskId = task.rows[0]!.id;
    const lease = await acquireExecutionLease(db.pool, repositoryId, { taskId }, 3_600_000);
    const leaseId = lease.lease!.id;
    const fencingToken = lease.lease!.fencingToken;
    const pr = { number: 9, url: 'https://github.com/Bouyer12/m5b-fixture/pull/9' };
    bridge.snapshot = snapshotFor(
      binding,
      'assignment-awaiting-review',
      'awaiting_review',
      leaseId,
      fencingToken,
      {
        report: { state: 'ready', summary: 'ready for review', at: '2026-11-20T05:35:00.000Z' },
        pr,
      },
    );

    // The platform restart: reconciliation reads the runtime record and must
    // keep the ticket where it is, with its PR.
    await reconcileTasks(db.pool, binding, client, logger);
    const reviewed = await db.pool.query<{
      state: string;
      prUrl: string;
      prNumber: number;
    }>('select state, pr_url as "prUrl", pr_number as "prNumber" from task_links where id = $1', [
      taskId,
    ]);
    expect(reviewed.rows[0]).toMatchObject({
      state: 'awaiting_review',
      prUrl: pr.url,
      prNumber: 9,
    });

    // Maintenance gives the execution slot back without starting a worker: the
    // ticket waits for a person, so nothing is launched and the Bridge is told nothing.
    await maintainLeases(db.pool, config, binding, client, logger);
    const released = await db.pool.query<{ state: string }>(
      'select state from runtime_leases where id = $1',
      [leaseId],
    );
    expect(released.rows[0]!.state).toBe('released');
    const cleared = await db.pool.query<{ runtimeLeaseId: string | null }>(
      'select runtime_lease_id as "runtimeLeaseId" from task_links where id = $1',
      [taskId],
    );
    expect(cleared.rows[0]!.runtimeLeaseId).toBeNull();
    expect(bridge.startCalls).toHaveLength(0);
    expect(bridge.triggerCalls).toHaveLength(triggersBefore);

    // Closing the PR ends the ticket: reconciliation carries the terminal state
    // and the PR it reviewed, and still starts nothing.
    bridge.snapshot = snapshotFor(
      binding,
      'assignment-awaiting-review',
      'closed_unmerged',
      leaseId,
      fencingToken,
      {
        ended: { at: '2026-11-20T05:40:00.000Z', by: 'executor', outcome: 'closed' },
        pr,
      },
    );
    await reconcileTasks(db.pool, binding, client, logger);
    const closed = await db.pool.query<{
      state: string;
      question: string | null;
      prNumber: number;
    }>('select state, question, pr_number as "prNumber" from task_links where id = $1', [taskId]);
    expect(closed.rows[0]).toMatchObject({ state: 'closed_unmerged', prNumber: 9 });
    expect(bridge.startCalls).toHaveLength(0);
    expect(bridge.triggerCalls).toHaveLength(triggersBefore);
  }, 60_000);
});
