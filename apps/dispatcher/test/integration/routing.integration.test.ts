import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BridgeEvent, BridgeTicketSnapshot } from '@moyu/runtime-client';
import { RuntimeBridgeClient } from '@moyu/runtime-client';

import { loadDispatcherConfig, type DispatcherConfig } from '../../src/config';
import type { DispatcherLogger } from '../../src/logger';
import type { RepositoryBinding } from '../../src/runtime';
import { handoffRoutedOnce } from '../../src/routing';
import { captureReportsOnce } from '../../src/reports';
import { syncOnce } from '../../src/sync';
import { createTestDatabase, type TestDatabase } from './helpers';

const TOKEN = 'routing-test-bridge-token-0123456789';

interface AdmitCall {
  ticketId: string;
  admission: unknown;
  assignmentId?: string;
}

interface FakeBridge {
  url: string;
  events: BridgeEvent[];
  snapshots: Map<string, BridgeTicketSnapshot>;
  admissions: AdmitCall[];
  refuseAdmission: { status: number; code: string; message: string } | null;
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

async function startFakeBridge(): Promise<FakeBridge> {
  const state: Omit<FakeBridge, 'url' | 'close' | 'snapshots'> & {
    snapshots: Map<string, BridgeTicketSnapshot>;
    server?: Server;
  } = {
    events: [],
    snapshots: new Map(),
    admissions: [],
    refuseAdmission: null,
  };
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { error: { code: 'unauthorized', message: 'machine token required' } });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && url.pathname === '/bridge/v1/events') {
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
    if (
      request.method === 'GET' &&
      parts[0] === 'bridge' &&
      parts[1] === 'v1' &&
      parts[2] === 'tickets' &&
      parts.length === 4
    ) {
      const ticketId = decodeURIComponent(parts[3]!);
      const snapshot = state.snapshots.get(ticketId);
      if (!snapshot) {
        send(404, { error: { code: 'not_found', message: 'ticket not found' } });
        return;
      }
      send(200, snapshot);
      return;
    }
    if (
      request.method === 'POST' &&
      parts[0] === 'bridge' &&
      parts[1] === 'v1' &&
      parts[2] === 'tickets' &&
      parts[4] === 'admit'
    ) {
      const ticketId = decodeURIComponent(parts[3]!);
      const body = (await readBody(request)) as AdmitCall;
      state.admissions.push({
        ticketId,
        admission: body.admission,
        assignmentId: body.assignmentId,
      });
      if (state.refuseAdmission) {
        send(state.refuseAdmission.status, {
          error: { code: state.refuseAdmission.code, message: state.refuseAdmission.message },
        });
        return;
      }
      const snapshot = state.snapshots.get(ticketId);
      if (snapshot) {
        snapshot.admissionRequired = false;
        snapshot.state = 'queued';
        snapshot.assignmentId = body.assignmentId ?? null;
      }
      send(200, { ticketId, admitted: true });
      return;
    }
    send(404, { error: { code: 'not_found', message: 'route not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake bridge did not listen');
  return {
    url: `http://127.0.0.1:${address.port}`,
    events: state.events,
    snapshots: state.snapshots,
    get admissions() {
      return state.admissions;
    },
    get refuseAdmission() {
      return state.refuseAdmission;
    },
    set refuseAdmission(value) {
      state.refuseAdmission = value;
    },
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

interface Seed {
  ownerId: string;
  repository: RepositoryBinding;
  source: {
    conversationId: string;
    taskId: string;
    messageId: string;
    leaseId: string;
  };
  target: {
    conversationId: string;
    taskId: string;
    ticketId: string;
  };
}

describe('routed admission handoff on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let bridge: FakeBridge;
  let client: RuntimeBridgeClient;
  let config: DispatcherConfig;
  let logger: ReturnType<typeof silentLogger>;
  let counter = 0;

  async function seed(
    options: {
      sourceState?: string;
      targetState?: string;
      reason?: Array<{ code: string; values?: Record<string, unknown> }>;
      targetPaused?: boolean;
      targetAdmissionRequired?: boolean;
    } = {},
  ): Promise<Seed> {
    counter += 1;
    const suffix = `${process.pid}-${counter}-${Date.now()}`;
    const owner = await testDatabase.pool.query<{ id: string }>(
      `insert into owners (display_name) values ($1) returning id`,
      [`Routing Test Owner ${suffix}`],
    );
    const ownerId = owner.rows[0]!.id;
    const repositoryRow = await testDatabase.pool.query<{ id: string; full_name: string }>(
      `insert into repositories (owner_id, full_name, default_branch, status, bridge_url)
       values ($1, $2, 'main', 'active', $3) returning id, full_name`,
      [ownerId, `Bouyer12/routing-${suffix}`, bridge.url],
    );
    const repositoryId = repositoryRow.rows[0]!.id;
    const repository: RepositoryBinding = {
      id: repositoryId,
      fullName: repositoryRow.rows[0]!.full_name,
      defaultBranch: 'main',
      bridgeUrl: bridge.url,
      bridgeCredentialRef: null,
    };
    const targetTicketId = `target-ticket-${suffix}`;

    const sourceConversation = await testDatabase.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, source)
       values ($1, $2, 'work', 'execute', 'main', 'web') returning id`,
      [ownerId, repositoryId],
    );
    const sourceConversationId = sourceConversation.rows[0]!.id;
    const sourceMessage = await testDatabase.pool.query<{ id: string }>(
      `insert into messages (conversation_id, direction, kind, body, source)
       values ($1, 'inbound', 'user', '请根据 PR #12 返修', 'web') returning id`,
      [sourceConversationId],
    );
    const sourceMessageId = sourceMessage.rows[0]!.id;
    await testDatabase.pool.query(
      `insert into deliveries (message_id, state, delivered_at, handed_to_worker_at)
       values ($1, 'delivered', now(), now())`,
      [sourceMessageId],
    );
    const sourceTask = await testDatabase.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, state, base_branch)
       values ($1, $2, $3, 'main') returning id`,
      [sourceConversationId, repositoryId, options.sourceState ?? 'pending_admission'],
    );
    const sourceTaskId = sourceTask.rows[0]!.id;
    const sourceLease = await testDatabase.pool.query<{ id: string }>(
      `insert into runtime_leases (repository_id, holder_id, expires_at)
       values ($1, $2, now() + interval '1 hour') returning id`,
      [repositoryId, `task:${sourceTaskId}`],
    );
    await testDatabase.pool.query(`update task_links set runtime_lease_id = $2 where id = $1`, [
      sourceTaskId,
      sourceLease.rows[0]!.id,
    ]);

    const targetConversation = await testDatabase.pool.query<{ id: string }>(
      `insert into conversations
         (owner_id, repository_id, mode, execution_mode, base_branch, model_id, title)
       values ($1, $2, 'work', 'execute', 'main', 'commandcode/deepseek/deepseek-v4.1-flash', '旧工单')
       returning id`,
      [ownerId, repositoryId],
    );
    const targetConversationId = targetConversation.rows[0]!.id;
    const targetTask = await testDatabase.pool.query<{ id: string }>(
      `insert into task_links
         (conversation_id, repository_id, state, base_branch, model_id, upstream_ticket_id, pr_url, pr_number)
       values ($1, $2, $3, 'main', 'commandcode/deepseek/deepseek-v4.1-flash', $4, $5, 12)
       returning id`,
      [
        targetConversationId,
        repositoryId,
        options.targetState ?? 'awaiting_review',
        targetTicketId,
        `${bridge.url}/pull/12`,
      ],
    );
    const targetTaskId = targetTask.rows[0]!.id;
    bridge.snapshots.set(targetTicketId, {
      ticketId: targetTicketId,
      title: '旧工单',
      state: options.targetPaused ? 'stopped' : (options.targetState ?? 'awaiting_review'),
      question: null,
      assignmentId: 'old-assignment-without-worker',
      report: { state: 'ready', summary: 'PR #12 ready', at: new Date().toISOString() },
      admissionRequired: options.targetAdmissionRequired ?? true,
      paused: options.targetPaused
        ? { at: new Date().toISOString(), by: 'human', stoppedAt: new Date().toISOString() }
        : null,
      pr: { number: 12, url: `${bridge.url}/pull/12` },
    });

    const routed = options.reason ?? [{ code: 'routed', values: { ticket: targetTicketId } }];
    bridge.events.push({
      seq: bridge.events.length + 1,
      id: `decision-routed-${suffix}`,
      type: 'decision.ignored',
      at: new Date().toISOString(),
      data: {
        decisionId: `decision-${suffix}`,
        triggerIds: [`workspace:${sourceMessageId}`],
        conversationId: sourceConversationId,
        messageId: sourceMessageId,
        messageIds: [sourceMessageId],
        threadKey: `workspace:${sourceConversationId}`,
        at: new Date().toISOString(),
        reason: routed,
      },
    });
    return {
      ownerId,
      repository,
      source: {
        conversationId: sourceConversationId,
        taskId: sourceTaskId,
        messageId: sourceMessageId,
        leaseId: sourceLease.rows[0]!.id,
      },
      target: {
        conversationId: targetConversationId,
        taskId: targetTaskId,
        ticketId: targetTicketId,
      },
    };
  }

  async function readDecision(taskId: string) {
    const result = await testDatabase.pool.query<{
      state: string;
      decision: Record<string, unknown>;
    }>('select state, decision from task_links where id = $1', [taskId]);
    return result.rows[0]!;
  }

  async function readTaskRow(taskId: string) {
    const result = await testDatabase.pool.query<{
      state: string;
      runtime_lease_id: string | null;
      runtimeLeaseId: string | null;
    }>(
      `select state, runtime_lease_id, runtime_lease_id as "runtimeLeaseId"
         from task_links where id = $1`,
      [taskId],
    );
    return result.rows[0]!;
  }

  beforeEach(async () => {
    bridge = await startFakeBridge();
    client = new RuntimeBridgeClient({ baseUrl: bridge.url, token: TOKEN });
    logger = silentLogger();
    testDatabase = await createTestDatabase();
    config = loadDispatcherConfig({
      NODE_ENV: 'test',
      DATABASE_URL: testDatabase.url,
      BRIDGE_TOKEN: TOKEN,
      OPERATION_LEASE_TTL_MS: '3600000',
    });
  });

  afterEach(async () => {
    await bridge?.close();
    await testDatabase?.drop();
  });

  it('persists a routed decision, releases the source slot and admits the target', async () => {
    const fixture = await seed();
    expect(await syncOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(true);

    const source = await readDecision(fixture.source.taskId);
    expect(source.state).toBe('not_accepted');
    expect(source.decision).toMatchObject({
      kind: 'ignore',
      outcome: 'routed',
      targetTicketId: fixture.target.ticketId,
      targetTaskId: fixture.target.taskId,
      targetConversationId: fixture.target.conversationId,
      routingState: 'pending',
    });
    const released = await testDatabase.pool.query<{ state: string }>(
      'select state from runtime_leases where id = $1',
      [fixture.source.leaseId],
    );
    expect(released.rows[0]?.state).toBe('released');

    expect(
      await handoffRoutedOnce(testDatabase.pool, config, fixture.repository, client, true, logger),
    ).toBe(true);
    expect(bridge.admissions).toHaveLength(1);
    expect(bridge.admissions[0]?.ticketId).toBe(fixture.target.ticketId);
    expect(bridge.admissions[0]?.assignmentId).toBeTruthy();

    const handedOff = await readDecision(fixture.source.taskId);
    expect(handedOff.state).toBe('not_accepted');
    expect(handedOff.decision).toMatchObject({
      routingState: 'handed_off',
      targetTaskId: fixture.target.taskId,
    });
    expect(typeof handedOff.decision.handedOffAt).toBe('string');
    const target = await readTaskRow(fixture.target.taskId);
    expect(target.state).toBe('queued');
    expect(target.runtime_lease_id).toBeTruthy();

    // A repeated event and a repeated handoff pass do no work and start no
    // second admission.
    expect(await syncOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(false);
    expect(
      await handoffRoutedOnce(testDatabase.pool, config, fixture.repository, client, true, logger),
    ).toBe(false);
    expect(bridge.admissions).toHaveLength(1);
  }, 30_000);

  it('sends the routed source conversation one Chinese completion notice from the target report', async () => {
    const fixture = await seed();
    expect(await syncOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(true);
    expect(
      await handoffRoutedOnce(testDatabase.pool, config, fixture.repository, client, true, logger),
    ).toBe(true);
    // The target finished again without a state transition: it was already
    // awaiting_review, so only its new report proves the rework result.
    await testDatabase.pool.query(`update task_links set state = 'awaiting_review' where id = $1`, [
      fixture.target.taskId,
    ]);
    const snapshot = bridge.snapshots.get(fixture.target.ticketId)!;
    snapshot.report = {
      state: 'ready',
      summary: 'Revision completed on the same PR #12.',
      at: new Date(Date.now() + 60_000).toISOString(),
    };
    snapshot.state = 'awaiting_review';
    expect(await captureReportsOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(
      true,
    );

    const notices = await testDatabase.pool.query<{ body: string; kind: string }>(
      `select body, kind from messages where conversation_id = $1 and direction = 'outbound'`,
      [fixture.source.conversationId],
    );
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]?.kind).toBe('notice');
    expect(notices.rows[0]?.body).toContain('已转交的返修已完成');
    expect(notices.rows[0]?.body).toContain('PR #12');

    // A repeated report tick does not send a second notice.
    await captureReportsOnce(testDatabase.pool, fixture.repository, client, logger);
    const after = await testDatabase.pool.query(
      `select 1 from messages where conversation_id = $1 and direction = 'outbound'`,
      [fixture.source.conversationId],
    );
    expect(after.rows).toHaveLength(1);
  }, 30_000);

  it('does not let a historical PR artifact replace the current PR pointer', async () => {
    const fixture = await seed();
    await testDatabase.pool.query(
      `update task_links
          set pr_url = $2, pr_number = 13, pr_updated_at = now()
        where id = $1`,
      [fixture.target.taskId, `${bridge.url}/pull/13`],
    );
    bridge.events.push({
      seq: bridge.events.length + 1,
      id: 'historical-pr-artifact',
      type: 'artifact.created',
      at: new Date(Date.now() - 86_400_000).toISOString(),
      data: {
        ticketId: fixture.target.ticketId,
        conversationId: fixture.target.conversationId,
        type: 'pull_request',
        url: `${bridge.url}/pull/12`,
        number: 12,
        at: new Date(Date.now() - 86_400_000).toISOString(),
      },
    });
    expect(await syncOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(true);
    const task = await testDatabase.pool.query<{ pr_number: number; pr_url: string }>(
      'select pr_number, pr_url from task_links where id = $1',
      [fixture.target.taskId],
    );
    expect(task.rows[0]).toMatchObject({ pr_number: 13, pr_url: `${bridge.url}/pull/13` });
    const historical = await testDatabase.pool.query(
      `select 1 from artifacts where task_id = $1 and metadata->>'number' = '12'`,
      [fixture.target.taskId],
    );
    expect(historical.rows).toHaveLength(1);
  }, 30_000);

  it('keeps the concrete reason for an ordinary refusal and never wakes a target', async () => {
    const fixture = await seed({
      reason: [{ code: 'said', values: { text: '这不是一个返修请求' } }],
    });
    expect(await syncOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(true);
    const source = await readDecision(fixture.source.taskId);
    expect(source.state).toBe('not_accepted');
    expect(source.decision).toMatchObject({
      outcome: 'not_accepted',
      code: 'said',
      reason: [{ code: 'said', values: { text: '这不是一个返修请求' } }],
    });
    expect(source.decision.targetTaskId).toBeUndefined();
    expect(
      await handoffRoutedOnce(testDatabase.pool, config, fixture.repository, client, true, logger),
    ).toBe(false);
    expect(bridge.admissions).toHaveLength(0);
  }, 30_000);

  it('keeps a manually paused target paused and hands off after it resumes', async () => {
    const fixture = await seed({ targetPaused: true, targetState: 'stopped' });
    expect(await syncOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(true);
    expect(
      await handoffRoutedOnce(testDatabase.pool, config, fixture.repository, client, true, logger),
    ).toBe(true);
    const deferred = await readDecision(fixture.source.taskId);
    expect(deferred.decision).toMatchObject({
      routingState: 'deferred',
      targetTaskId: fixture.target.taskId,
    });
    expect(bridge.admissions).toHaveLength(0);
    expect((await readTaskRow(fixture.target.taskId)).state).toBe('stopped');

    // The owner resumes the target: no paused snapshot, the old assignment is
    // gone and the new generation must be admitted.
    await testDatabase.pool.query(`update task_links set state = 'stopped' where id = $1`, [
      fixture.target.taskId,
    ]);
    const snapshot = bridge.snapshots.get(fixture.target.ticketId)!;
    snapshot.paused = null;
    snapshot.state = 'awaiting_review';
    snapshot.admissionRequired = true;
    expect(
      await handoffRoutedOnce(testDatabase.pool, config, fixture.repository, client, true, logger),
    ).toBe(true);
    expect(bridge.admissions).toHaveLength(1);
    expect((await readDecision(fixture.source.taskId)).decision).toMatchObject({
      routingState: 'handed_off',
    });
  }, 30_000);

  it('admits a waiting_input target whose old assignment has no live worker', async () => {
    const fixture = await seed({ targetState: 'waiting_input' });
    expect(await syncOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(true);
    expect(
      await handoffRoutedOnce(testDatabase.pool, config, fixture.repository, client, true, logger),
    ).toBe(true);
    expect(bridge.admissions).toHaveLength(1);
    expect(bridge.admissions[0]?.assignmentId).not.toBe('old-assignment-without-worker');
    const target = await readTaskRow(fixture.target.taskId);
    expect(target.state).toBe('queued');
    expect((await readDecision(fixture.source.taskId)).decision).toMatchObject({
      routingState: 'handed_off',
    });
  }, 30_000);

  it('keeps the source not_accepted and records a failed handoff when the runtime refuses', async () => {
    bridge.refuseAdmission = { status: 409, code: 'ticketPaused', message: 'The ticket is paused' };
    const fixture = await seed();
    expect(await syncOnce(testDatabase.pool, fixture.repository, client, logger)).toBe(true);
    expect(
      await handoffRoutedOnce(testDatabase.pool, config, fixture.repository, client, true, logger),
    ).toBe(true);
    const failed = await readDecision(fixture.source.taskId);
    expect(failed.decision).toMatchObject({ routingState: 'failed' });
    expect(String(failed.decision.routingError)).toContain('ticketPaused');
    expect((await readTaskRow(fixture.target.taskId)).state).toBe('awaiting_review');
    expect((await readTaskRow(fixture.target.taskId)).runtime_lease_id).toBeNull();
  }, 30_000);
});
