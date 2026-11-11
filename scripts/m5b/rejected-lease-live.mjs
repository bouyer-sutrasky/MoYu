#!/usr/bin/env node
/**
 * Isolated live driver for the unaccepted-admission lease settlement.
 *
 *   node scripts/m5b/rejected-lease-live.mjs ignore
 *   node scripts/m5b/rejected-lease-live.mjs accept
 *   node scripts/m5b/rejected-lease-live.mjs replay
 *   node scripts/m5b/rejected-lease-live.mjs snapshot
 *
 * Uses the real owner API, the real Bridge and the isolated PostgreSQL started
 * by `scripts/m5b/matrix/stack.sh up`; /tmp/m5bmatrix/state.env supplies the
 * owner session, repository and Bridge token. The only stand-in is the
 * deterministic loopback model provider, as in the other M5-B matrix runs.
 *
 * `ignore` writes `ignore` to the provider's per-run route file, creates one Web
 * task and waits for the runtime's real `decision.ignored` receipt to close it.
 * `accept` switches the provider to accept and creates a second task, proving
 * the repository can start again. `replay` rewinds the event cursor over the
 * ignored receipt, then re-reads the two tasks and both generations.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

function loadState() {
  const file = process.env.M5B_MATRIX_STATE ?? '/tmp/m5bmatrix/state.env';
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^export ([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return { ...values, ...process.env };
}

const state = loadState();
const RUN = process.env.M5B_MATRIX_RUN ?? '/tmp/m5bmatrix';
const API = `http://127.0.0.1:${process.env.M5B_MATRIX_API_PORT ?? 4510}`;
const PG_URL =
  process.env.M5B_MATRIX_PG_URL ??
  `postgres://moyu@127.0.0.1:55433/${process.env.M5B_MATRIX_DB ?? 'm5b_matrix'}`;
const PROVIDER_LOG = process.env.M5B_MATRIX_PROVIDER_LOG ?? `${RUN}/local-provider.jsonl`;

async function api(method, path, body) {
  const headers = { cookie: `moyu_session=${state.M5B_SESSION_TOKEN}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await globalThis.fetch(`${API}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload };
}

async function query(sql, params = []) {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function bridge(path) {
  const response = await globalThis.fetch(`${state.M5B_BRIDGE_URL}${path}`, {
    headers: { authorization: `Bearer ${state.M5B_BRIDGE_TOKEN}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`bridge ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function bridgeEvents() {
  const events = [];
  let after = 0;
  for (;;) {
    const page = await bridge(`/bridge/v1/events?after=${after}&limit=200`);
    events.push(...page.events);
    if (!page.hasMore) break;
    after = page.next;
  }
  return events;
}

function providerRoute(kind) {
  const file = `${RUN}/provider-route.txt`;
  writeFileSync(file, `${kind}\n`);
  chmodSync(file, 0o644);
  return file;
}

async function poll(label, read, accept, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let value;
  for (;;) {
    value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
}

async function taskRow(taskId) {
  const [row] = await query(
    `select t.id, t.conversation_id as "conversationId", t.state,
            t.upstream_ticket_id as "upstreamTicketId", t.runtime_lease_id as "runtimeLeaseId",
            t.version, t.stop_evidence as "stopEvidence"
       from task_links t where t.id = $1`,
    [taskId],
  );
  return row;
}

async function leaseForTask(taskId) {
  const [row] = await query(
    `select id, holder_id as "holderId", state, fencing_token::text as "fencingToken",
            recovery_state as "recoveryState", recovery_reason as "recoveryReason",
            waiting_for as "waitingFor", stop_proof as "stopProof",
            acquired_at as "acquiredAt", released_at as "releasedAt"
       from runtime_leases where holder_id = 'task:' || $1 order by acquired_at desc limit 1`,
    [taskId],
  );
  return row ?? null;
}

async function leaseEvents(leaseId) {
  if (!leaseId) return [];
  return query(
    `select type, fencing_token::text as "fencingToken", detail, created_at as "createdAt"
       from runtime_lease_events where lease_id = $1 order by created_at`,
    [leaseId],
  );
}

async function createTask(text) {
  const created = await api('POST', '/api/v1/conversations', {
    repositoryId: state.M5B_REPOSITORY_ID,
    mode: 'work',
    executionMode: 'execute',
    baseBranch: 'main',
    clientRequestId: `rejected-lease-${randomUUID()}`,
    model: { provider: 'local-test', model: 'local-test' },
  });
  if (created.status !== 201) {
    throw new Error(`conversation creation: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const conversation = created.body.data.conversation;
  const messageId = `message-${randomUUID()}`;
  const message = await api('POST', `/api/v1/conversations/${conversation.id}/messages`, {
    clientMessageId: messageId,
    text,
  });
  if (![200, 201, 202].includes(message.status)) {
    throw new Error(`message: ${message.status} ${JSON.stringify(message.body)}`);
  }
  return {
    conversationId: conversation.id,
    taskId: conversation.task.id,
    messageId,
    triggerId: `workspace:${message.body?.data?.message?.id ?? messageId}`,
    messageStatus: message.status,
  };
}

function providerDecisions(triggerId) {
  let lines = [];
  try {
    lines = readFileSync(PROVIDER_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return { route: 0, report: 0 };
  }
  const route = lines.filter((line) =>
    String(line?.response?.choice?.arguments ?? '').includes(triggerId),
  );
  const report = lines.filter((line) => line?.response?.choice?.tool === 'orchestrator_report');
  return { route: route.length, report: report.length, routeResponses: route };
}

async function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

const command = process.argv[2];
if (!command) {
  console.error('usage: rejected-lease-live.mjs ignore|accept|replay|snapshot');
  process.exit(2);
}

if (command === 'ignore') {
  const routeFile = providerRoute('ignore');
  const task = await createTask('Ignored admission lease probe: no Ticket should be created.');
  const closed = await poll(
    'the ignored admission',
    () => taskRow(task.taskId),
    (row) => row && row.state === 'not_accepted',
  );
  const lease = await leaseForTask(task.taskId);
  const events = await bridgeEvents();
  const ignored = events.filter(
    (event) =>
      event.type === 'decision.ignored' && JSON.stringify(event.data).includes(task.conversationId),
  );
  const linked = events.filter(
    (event) =>
      event.type === 'ticket.linked' && JSON.stringify(event.data).includes(task.conversationId),
  );
  const deliveries = await query(
    `select d.state, d.runtime_lease_id as "runtimeLeaseId", d.fencing_token::text as "fencingToken",
            d.upstream_trigger_id as "upstreamTriggerId"
       from deliveries d join messages m on m.id = d.message_id
      where m.conversation_id = $1`,
    [task.conversationId],
  );
  await print({
    phase: 'ignore',
    routeFile,
    ...task,
    task: closed,
    lease,
    leaseEvents: await leaseEvents(lease?.id),
    deliveries,
    bridge: {
      decisionIgnored: ignored.map((event) => ({ seq: event.seq, id: event.id })),
      ticketLinked: linked.length,
    },
  });
} else if (command === 'accept') {
  const routeFile = providerRoute('accept');
  writeFileSync(
    `${RUN}/worker-report.json`,
    '{"state":"progress","summary":"Rejected-lease fixture: worker started."}\n',
  );
  chmodSync(`${RUN}/worker-report.json`, 0o644);
  writeFileSync(`${RUN}/worker-sleep.txt`, '30\n');
  chmodSync(`${RUN}/worker-sleep.txt`, 0o644);
  const task = await createTask('Follow-up task after the ignored admission was settled.');
  const started = await poll(
    'the follow-up ticket to start',
    () => taskRow(task.taskId),
    (row) => row && row.upstreamTicketId !== null,
    90_000,
  );
  await new Promise((resolve) => globalThis.setTimeout(resolve, 3000));
  const lease = await leaseForTask(task.taskId);
  const ticket = await bridge(`/bridge/v1/tickets/${started.upstreamTicketId}`);
  const events = await bridgeEvents();
  const ticketEvents = events.filter((event) =>
    JSON.stringify(event.data).includes(started.upstreamTicketId),
  );
  const deliveries = await query(
    `select d.state, d.runtime_lease_id as "runtimeLeaseId", d.fencing_token::text as "fencingToken",
            d.upstream_trigger_id as "upstreamTriggerId"
       from deliveries d join messages m on m.id = d.message_id
      where m.conversation_id = $1`,
    [task.conversationId],
  );
  await print({
    phase: 'accept',
    routeFile,
    ...task,
    task: await taskRow(task.taskId),
    lease,
    leaseEvents: await leaseEvents(lease?.id),
    deliveries,
    ticket: {
      ticketId: ticket.ticketId,
      state: ticket.state,
      assignmentId: ticket.assignmentId ?? null,
      report: ticket.report ?? null,
      ended: ticket.ended ?? null,
    },
    bridgeEventIds: ticketEvents.map((event) => `${event.seq}:${event.id}`),
    bridgeEventIdCount: ticketEvents.length,
    provider: providerDecisions(task.triggerId),
  });
} else if (command === 'replay') {
  const conversations = await query(
    `select c.id as "conversationId", t.id as "taskId"
       from conversations c left join task_links t on t.conversation_id = c.id
      order by c.created_at`,
  );
  if (conversations.length < 2) throw new Error('run the ignore and accept phases first');
  const [ignoredTask] = conversations;
  const [followUp] = conversations.slice(-1);
  const events = await bridgeEvents();
  const ignored = events.filter(
    (event) =>
      event.type === 'decision.ignored' &&
      JSON.stringify(event.data).includes(ignoredTask.conversationId),
  );
  if (ignored.length !== 1)
    throw new Error(`expected one ignored receipt, found ${ignored.length}`);
  const seq = ignored[0].seq;
  const before = {
    ignored: {
      task: await taskRow(ignoredTask.taskId),
      lease: await leaseForTask(ignoredTask.taskId),
    },
    followUp: { task: await taskRow(followUp.taskId), lease: await leaseForTask(followUp.taskId) },
    releaseEvents: await query(
      `select count(*)::int as count from runtime_lease_events where type = 'released'`,
    ),
  };
  const cursor = await query(`select cursor from runtime_cursors where repository_id = $1`, [
    state.M5B_REPOSITORY_ID,
  ]);
  await query(`update runtime_cursors set cursor = $2 where repository_id = $1`, [
    state.M5B_REPOSITORY_ID,
    String(seq - 1),
  ]);
  const advanced = await poll(
    'the dispatcher to consume the replayed receipt',
    async () => {
      const [row] = await query(`select cursor from runtime_cursors where repository_id = $1`, [
        state.M5B_REPOSITORY_ID,
      ]);
      return Number(row?.cursor ?? 0);
    },
    (value) => value >= seq,
    60_000,
  );
  await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
  const after = {
    cursor: advanced,
    ignored: {
      task: await taskRow(ignoredTask.taskId),
      lease: await leaseForTask(ignoredTask.taskId),
    },
    followUp: { task: await taskRow(followUp.taskId), lease: await leaseForTask(followUp.taskId) },
    releaseEvents: await query(
      `select count(*)::int as count from runtime_lease_events where type = 'released'`,
    ),
    dedupe: await query(
      `select count(*)::int as count from events where source = 'bridge' and source_event_id = $1`,
      [ignored[0].id],
    ),
  };
  await print({
    phase: 'replay',
    replayed: { seq, id: ignored[0].id },
    cursorBefore: cursor[0]?.cursor ?? null,
    before,
    after,
  });
} else if (command === 'snapshot') {
  const conversations = await query(
    `select c.id as "conversationId", t.id as "taskId", t.state,
            t.upstream_ticket_id as "upstreamTicketId", t.runtime_lease_id as "runtimeLeaseId",
            t.stop_evidence as "stopEvidence"
       from conversations c left join task_links t on t.conversation_id = c.id
      order by c.created_at`,
  );
  const leases = await query(
    `select id, holder_id as "holderId", state, fencing_token::text as "fencingToken",
            recovery_state as "recoveryState", recovery_reason as "recoveryReason",
            waiting_for as "waitingFor", stop_proof as "stopProof",
            acquired_at as "acquiredAt", released_at as "releasedAt"
       from runtime_leases order by acquired_at`,
  );
  const tasks = [];
  for (const conversation of conversations) {
    tasks.push({
      ...conversation,
      lease: conversation.taskId ? await leaseForTask(conversation.taskId) : null,
    });
  }
  await print({ phase: 'snapshot', tasks, leases });
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
