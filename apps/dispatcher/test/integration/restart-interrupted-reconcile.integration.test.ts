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

/** A Bridge whose ticket snapshot and event page a test scripts, as a restart leaves them. */
async function startFakeBridge(): Promise<FakeBridge> {
  const state = {
    events: [] as BridgeEvent[],
    triggerCalls: [] as BridgeTriggerInput[],
    startCalls: [] as { ticketId: string; admission: unknown }[],
    snapshot: {} as Record<string, unknown>,
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
      send(200, state.snapshot);
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The two restart-reconciliation scenarios M5-B left unverified, measured on the
 * platform side only: the runtime's own recovery is proved live by the matrix.
 *
 * 1. An interrupted turn. The host restart ends the running Assignment and
 *    re-issues one under the same lease and fencing token. The platform's
 *    generation identity is (Ticket, lease, token), so this is a supersession,
 *    not a stale generation: the old Assignment stays traceable on the lease
 *    ledger, the reservation follows the live Assignment so recovery can still
 *    claim it, the follow-up input is delivered exactly once, and the cursor
 *    advances on the events the restart and the follow-up produce.
 * 2. An open pull request awaiting review. A restart must neither start a
 *    worker nor drop the PR, and closing the PR must still end the ticket.
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
      at: new Date(Date.UTC(2026, 10, 8, 5, 30, seq)).toISOString(),
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

  /** One repository per scenario, so a lease or cursor from one cannot leak into the other. */
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

  it('keeps an interrupted turn traceable, delivers the follow-up once, and advances the cursor', async () => {
    const triggersBefore = bridge.triggerCalls.length;
    const repositoryId = await newRepository('interrupted');
    const binding: RepositoryBinding = {
      id: repositoryId,
      fullName: `Bouyer12/m5b-restart-interrupted-${process.pid}`,
      defaultBranch: 'main',
      bridgeUrl: bridge.url,
      bridgeCredentialRef: 'MOYU_BRIDGE_TOKEN',
    };
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
    await reserveExecution(db.pool, {
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
    bridge.snapshot = {
      ticketId: TICKET,
      title: 'Interrupted turn',
      mode: 'execute',
      assignmentId: assignmentBeforeRestart,
      state: 'running',
      base: { repository: binding.fullName, branch: 'main', commit: 'a'.repeat(40) },
      admission: { leaseId, fencingToken },
    };

    // The host restart: the runtime ends the running Assignment and re-issues one
    // under the same lease, so the Ticket drops to queued with a new assignment.
    const restartSeq = pushEvent('ticket.state_changed', {
      ticketId: TICKET,
      state: 'queued',
      assignmentId: assignmentAfterRestart,
      leaseId,
      fencingToken,
    });
    bridge.snapshot = {
      ticketId: TICKET,
      title: 'Interrupted turn',
      mode: 'execute',
      assignmentId: assignmentAfterRestart,
      state: 'queued',
      base: { repository: binding.fullName, branch: 'main', commit: 'a'.repeat(40) },
      admission: { leaseId, fencingToken },
    };
    await syncOnce(db.pool, binding, client, logger);

    // The restart event was consumed and projected, never dropped as stale.
    expect(await cursor(repositoryId)).toBe(restartSeq);
    const projected = await db.pool.query<{ state: string }>(
      'select state from task_links where id = $1',
      [taskId],
    );
    expect(projected.rows[0]!.state).toBe('queued');

    // The live generation is the one the runtime reports: the reservation follows
    // it, and the one it replaced stays on the lease ledger.
    const reservation = await db.pool.query<{ assignment_id: string; state: string }>(
      `select assignment_id, state from execution_reservations
        where repository_id = $1 and request_key = $2`,
      [repositoryId, `admit:${taskId}`],
    );
    expect(reservation.rows[0]?.assignment_id).toBe(assignmentAfterRestart);
    const supersessions = await db.pool.query<{ detail: Record<string, unknown> }>(
      `select detail from runtime_lease_events
        where lease_id = $1 and type = 'assignment_superseded' order by id`,
      [leaseId],
    );
    expect(supersessions.rows.map((row) => row.detail)).toEqual([
      expect.objectContaining({
        ticketId: TICKET,
        fromAssignmentId: assignmentBeforeRestart,
        toAssignmentId: assignmentAfterRestart,
      }),
    ]);

    // A real follow-up input reaches the same Ticket exactly once, under the
    // admission this Ticket already holds.
    const followUp = await newMessage(conversationId, 'Matrix restart follow-up', false);
    const deliveredOnce = await deliverOnce(db.pool, config, binding, client, logger, true);
    expect(deliveredOnce).toBe(true);
    const sent = bridge.triggerCalls.slice(triggersBefore);
    expect(sent.map((call) => call.messageId)).toEqual([followUp.messageId]);
    expect(sent[0]!.admission).toEqual({ leaseId, fencingToken });
    const delivery = await db.pool.query<{ state: string; runtime_lease_id: string }>(
      'select state, runtime_lease_id from deliveries where id = $1',
      [followUp.deliveryId],
    );
    expect(delivery.rows[0]).toMatchObject({ state: 'delivered', runtime_lease_id: leaseId });
    // A second pass has nothing left to send: the input is not delivered twice.
    expect(await deliverOnce(db.pool, config, binding, client, logger, true)).toBe(false);
    expect(bridge.triggerCalls).toHaveLength(triggersBefore + 1);

    // The re-issued Assignment starts, and its state event advances the cursor.
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
  }, 60_000);

  it('neither starts work nor drops the PR of an awaiting_review ticket across a restart, and ends it when the PR closes', async () => {
    // The other scenario's deliveries are not evidence about this one.
    const triggersBefore = bridge.triggerCalls.length;
    const repositoryId = await newRepository('review');
    const binding: RepositoryBinding = {
      id: repositoryId,
      fullName: `Bouyer12/m5b-restart-review-${process.pid}`,
      defaultBranch: 'main',
      bridgeUrl: bridge.url,
      bridgeCredentialRef: 'MOYU_BRIDGE_TOKEN',
    };
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
    bridge.snapshot = {
      ticketId: TICKET,
      title: 'Awaiting review',
      mode: 'execute',
      assignmentId: 'assignment-awaiting-review',
      state: 'awaiting_review',
      report: { state: 'ready', summary: 'ready for review', at: '2026-11-08T05:35:00.000Z' },
      base: { repository: binding.fullName, branch: 'main', commit: 'a'.repeat(40) },
      admission: { leaseId, fencingToken },
      pr,
    };

    // The platform restart: reconciliation reads the runtime snapshot and must
    // keep the ticket where it is, with its PR.
    await reconcileTasks(db.pool, binding, client, logger);
    const reviewed = await db.pool.query<{
      state: string;
      prUrl: string;
      prNumber: number;
      question: string | null;
    }>(
      'select state, pr_url as "prUrl", pr_number as "prNumber", question from task_links where id = $1',
      [taskId],
    );
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
    bridge.snapshot = {
      ticketId: TICKET,
      title: 'Awaiting review',
      mode: 'execute',
      assignmentId: 'assignment-awaiting-review',
      state: 'closed_unmerged',
      ended: { at: '2026-11-08T05:40:00.000Z', by: 'executor', outcome: 'closed' },
      base: { repository: binding.fullName, branch: 'main', commit: 'a'.repeat(40) },
      admission: { leaseId, fencingToken },
      pr,
    };
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

  it('never adopts an Assignment from a generation that is not the live one', async () => {
    const repositoryId = await newRepository('stale');
    const binding: RepositoryBinding = {
      id: repositoryId,
      fullName: `Bouyer12/m5b-restart-stale-${process.pid}`,
      defaultBranch: 'main',
      bridgeUrl: bridge.url,
      bridgeCredentialRef: 'MOYU_BRIDGE_TOKEN',
    };
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
    bridge.snapshot = {
      ticketId: TICKET,
      title: 'Stale generation',
      mode: 'execute',
      assignmentId: live,
      state: 'running',
      base: { repository: binding.fullName, branch: 'main', commit: 'a'.repeat(40) },
      admission: { leaseId, fencingToken },
    };

    // A late event from another generation: a different lease names it, so it
    // must neither project queued/running nor move the reservation.
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
  }, 60_000);
});
