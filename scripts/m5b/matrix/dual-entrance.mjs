#!/usr/bin/env node
/**
 * M5-B item 1e — Web and GitHub entrance order and side-effect dedup, on the real
 * isolated stack.
 *
 * The scenario (docs/evidence/m5b/matrix/DUAL-ENTRANCE.md) drives one piece of
 * work through both entrances:
 *
 *   web-first     a Web conversation whose message names the exact Issue starts
 *                 the worker; the owner then @-mentions the agent on that Issue,
 *                 so the GitHub ticket refers to work that is already running.
 *   github-first  the owner @-mentions the agent first; the Web conversation
 *                 receives a follow-up message afterwards.
 *
 * This tool is read-only. `facts` prints what the real platform PostgreSQL, the
 * runtime's own state (Bridge SQLite), the worker session directories and the
 * real GitHub repository say. `check` asserts the invariants that make the
 * ordering meaningful:
 *
 *   - one conversation, one platform task and one executing runtime ticket;
 *   - exactly one worker harness start (assignment + session directory) for the
 *     work, and a second GitHub ticket that never gets one (web-first);
 *   - one external GitHub write (the acknowledgement on the triggering comment)
 *     and no PR;
 *   - duplicate events and processed receipts do not add rows or writes.
 *
 * Counting rule: a worker harness start is one `worker-<ticket>` session
 * directory plus one started assignment in the runtime ticket JSON. The matrix
 * has used that pair as the execution count since item 1; it is not the
 * platform's state field.
 *
 *   node scripts/m5b/matrix/dual-entrance.mjs setup
 *   node scripts/m5b/matrix/dual-entrance.mjs facts \
 *     --order web-first --issue 12 [--conversation <id>] [--task <id>]
 *   node scripts/m5b/matrix/dual-entrance.mjs check \
 *     --order web-first --issue 12 --conversation <id> --task <id> \
 *     --phase after-import [--wait 240]
 *
 * `setup` points the stack's GitHub source at M5B_DUAL_PROBE_REPO and allows the
 * human owner (M5B_DUAL_HUMAN_LOGIN) and the browser owner as senders. It only
 * touches the ephemeral stack's own runtime settings, which `stack.sh up`
 * recreates from scratch for every run; `facts` and `check` are read-only.
 *
 * Requires the matrix stack (`scripts/m5b/matrix/stack.sh up`) and
 * /tmp/m5bmatrix/state.env, or the same M5B_* variables in the environment. The
 * stack must serve the probe repository itself (M5B_MATRIX_REPOSITORY), so the
 * Web message, the GitHub Issue and the platform task share one work identity.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import pg from 'pg';

const { Client } = pg;

const ACK_MARKER = /<!--\s*dsh-superagent:ack:([0-9a-f]+)\s*-->/;
const ACTIVE_TASK_STATES = ['queued', 'pending_admission', 'running', 'blocked', 'stopping'];
const PARKED_STATES = ['paused', 'skipped'];

function loadState() {
  const file = process.env.M5B_MATRIX_STATE ?? '/tmp/m5bmatrix/state.env';
  const values = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^export ([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2];
    }
  } catch {
    /* fall through to the process environment */
  }
  return { ...values, ...process.env };
}

const state = loadState();
const PG_URL =
  process.env.M5B_MATRIX_PG_URL ??
  `postgres://moyu@127.0.0.1:${process.env.M5B_MATRIX_PG_PORT ?? 55433}/${
    process.env.M5B_MATRIX_DB ?? 'm5b_matrix'
  }`;
const DSH_HOME = process.env.M5B_MATRIX_DSH_HOME ?? '/tmp/m5bmatrix/dsh-home';
const PROFILE = process.env.M5B_MATRIX_PROFILE ?? 'm5b';
const RUNTIME_DB = join(DSH_HOME, 'state', PROFILE, 'orchestrator.sqlite');
const SESSIONS = join(DSH_HOME, 'sessions');
const PROBE_REPO = process.env.M5B_DUAL_PROBE_REPO ?? 'bouyer-sutrasky/m4-github-probe';
const AGENT_LOGIN = process.env.M5B_DUAL_AGENT_LOGIN ?? 'Bouyer12';
const HUMAN_LOGIN = process.env.M5B_DUAL_HUMAN_LOGIN ?? 'sutrasky';
const PANEL_PORT = Number(process.env.M5B_DUAL_PANEL_PORT ?? 3404);
const BRIDGE_PORT = Number(process.env.M5B_DUAL_BRIDGE_PORT ?? 3403);

function args(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        index += 1;
      }
    } else out._.push(token);
  }
  return out;
}

const options = args(process.argv.slice(3));
const command = process.argv[2];

function required(name) {
  const value = options[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
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

function runtime() {
  if (!existsSync(RUNTIME_DB)) throw new Error(`runtime state not found: ${RUNTIME_DB}`);
  return new DatabaseSync(RUNTIME_DB, { readOnly: true });
}

function parse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function ghApi(path) {
  const text = execFileSync('gh', ['api', path], { encoding: 'utf8' });
  return JSON.parse(text);
}

/** A worker harness start leaves exactly one session directory per ticket. */
function workerSessions(ticketId) {
  if (!existsSync(SESSIONS)) return 0;
  let count = 0;
  for (const entry of readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(SESSIONS, entry.name);
    if (existsSync(join(dir, `worker-${ticketId}`))) count += 1;
  }
  return count;
}

function threadKeys(value) {
  const trigger = parse(value);
  return (trigger?.threads ?? []).map((thread) => `${thread.source}:${thread.id}`);
}

async function collect({ issue, conversationId }) {
  const externalKey = `github:${issue}`;
  const repositoryId = state.M5B_REPOSITORY_ID;
  if (!repositoryId) throw new Error('M5B_REPOSITORY_ID is missing; is the matrix stack up?');

  const repositories = await query(
    `select id, full_name as "fullName" from repositories where id = $1`,
    [repositoryId],
  );
  const repository = repositories[0] ?? null;

  const conversations = await query(
    `select id, source, external_key as "externalKey", external_url as "externalUrl",
            created_at as "createdAt"
       from conversations
      where repository_id = $1
        and (external_key = $2 or ($3::uuid is not null and id = $3::uuid))
      order by created_at`,
    [repositoryId, externalKey, conversationId ?? null],
  );

  const conversationIds = conversations.map((row) => row.id);
  const tasks = conversationIds.length
    ? await query(
        `select id, conversation_id as "conversationId", upstream_ticket_id as "ticketId",
                upstream_thread_id as "thread", state, version,
                runtime_lease_id as "leaseId", pr_url as "prUrl", pr_number as "prNumber",
                stopped_at as "stoppedAt"
           from task_links
          where repository_id = $1 and conversation_id = any($2::uuid[])
          order by created_at`,
        [repositoryId, conversationIds],
      )
    : [];

  const leases = await query(
    `select l.id, l.state, l.fencing_token as "fencingToken",
            t.id as "taskId", t.upstream_ticket_id as "upstreamTicketId"
       from runtime_leases l
       left join task_links t
         on t.runtime_lease_id = l.id and t.repository_id = l.repository_id
      where l.repository_id = $1
      order by l.acquired_at`,
    [repositoryId],
  );
  const duplicates = await query(
    `select ticket_id as "ticketId", task_id as "taskId", state, attempts,
            last_error as "lastError"
       from duplicate_tickets where repository_id = $1 order by created_at`,
    [repositoryId],
  );

  const messages = conversationIds.length
    ? await query(
        `select count(*)::int as total,
                count(*) filter (where kind = 'notice')::int as notices,
                count(*) filter (where kind = 'user')::int as userMessages
           from messages where conversation_id = any($1::uuid[])`,
        [conversationIds],
      )
    : [{ total: 0, notices: 0, userMessages: 0 }];
  const deliveries = conversationIds.length
    ? await query(
        `select d.state::text as state, count(*)::int as count
           from messages m join deliveries d on d.message_id = m.id
          where m.conversation_id = any($1::uuid[])
          group by 1 order by 1`,
        [conversationIds],
      )
    : [];

  const db = runtime();
  try {
    const triggerThreads = new Map();
    const triggerRows = [];
    for (const row of db.prepare('select id, value, at from trigger').all()) {
      const keys = threadKeys(row.value);
      triggerThreads.set(row.id, keys);
      const value = parse(row.value);
      triggerRows.push({
        id: row.id,
        at: row.at,
        source: value?.source ?? null,
        human: value?.human === true,
        actor: value?.actor ? `${value.actor.source}:${value.actor.id}` : null,
        threads: keys,
        url: value?.url ?? null,
      });
    }
    const tickets = [];
    for (const row of db.prepare('select id, value from ticket').all()) {
      const value = parse(row.value);
      const originIds = value?.origin?.triggerIds ?? [];
      const keys = originIds.flatMap((id) => triggerThreads.get(id) ?? []);
      const assignments = value?.assignments ?? [];
      tickets.push({
        id: row.id,
        threads: [...new Set(keys)],
        state: value?.state ?? null,
        assignmentCount: assignments.length,
        startedAssignments: assignments.filter((item) => item.startedAt).length,
        assignments: assignments.map((item) => ({
          id: item.id,
          state: item.state ?? null,
          startedAt: item.startedAt ?? null,
          endedAt: item.endedAt ?? null,
        })),
        pausedStoppedAt: value?.paused?.stoppedAt ?? null,
        ended: value?.ended?.outcome ?? null,
        undelivered: (value?.undelivered ?? []).length,
        workerSessions: workerSessions(row.id),
      });
    }
    const outbox = [];
    for (const row of db.prepare('select id, value from outbox').all()) {
      const value = parse(row.value);
      outbox.push({
        id: row.id,
        ticketId: value?.ticketId ?? null,
        kind: value?.kind ?? null,
        channel: value?.channel?.source ?? null,
        thread: value?.channel?.thread ?? null,
        status: value?.status ?? null,
      });
    }
    const instances = await query(
      `select state, pid, profile, reason_code as "reasonCode"
         from repository_instances where repository_id = $1`,
      [repositoryId],
    );
    const issueThread = `github:${issue}`;
    const workspaceThread = conversationId ? `workspace:workspace:${conversationId}` : null;
    const relevant = tickets.filter(
      (ticket) =>
        ticket.threads.includes(issueThread) ||
        (workspaceThread !== null && ticket.threads.includes(workspaceThread)),
    );
    const githubComments = ghApi(`repos/${PROBE_REPO}/issues/${issue}/comments?per_page=100`).map(
      (comment) => ({
        id: comment.id,
        login: comment.user?.login ?? null,
        at: comment.created_at ?? null,
        ack: ACK_MARKER.test(comment.body ?? ''),
      }),
    );
    return {
      at: new Date().toISOString(),
      order: options.order ?? null,
      phase: options.phase ?? null,
      repository,
      probeRepository: PROBE_REPO,
      issueThread,
      workspaceThread,
      platform: {
        conversations,
        tasks,
        leases,
        activeLeases: leases.filter((lease) => lease.state === 'active'),
        duplicates,
        messages: messages[0],
        deliveries,
      },
      runtime: {
        triggers: triggerRows.filter((trigger) => trigger.threads.includes(issueThread)),
        tickets: relevant,
        githubOutbox: outbox.filter((row) => row.thread === issueThread),
        instances,
      },
      github: {
        agentComments: githubComments.filter((comment) => comment.login === AGENT_LOGIN),
        humanComments: githubComments.filter((comment) => comment.login !== AGENT_LOGIN),
      },
    };
  } finally {
    db.close();
  }
}

/** Returns every invariant failure for one phase; an empty list is a pass. */
function checks(facts, { order, phase, taskId }) {
  const failures = [];
  const expect = (ok, name, detail) => {
    if (!ok) failures.push({ name, detail });
  };
  const { platform, runtime: runtimeFacts, github } = facts;
  const [task] = platform.tasks;
  const githubTickets = runtimeFacts.tickets.filter((ticket) =>
    ticket.threads.includes(facts.issueThread),
  );
  const workspaceTickets = runtimeFacts.tickets.filter(
    (ticket) => !ticket.threads.includes(facts.issueThread),
  );
  const duplicates = platform.duplicates;
  const humanComments = github.humanComments.filter((comment) => comment.login === HUMAN_LOGIN);

  expect(
    facts.repository?.fullName === facts.probeRepository,
    'one work identity',
    `platform repository ${facts.repository?.fullName ?? 'missing'} is not the probe repository ${facts.probeRepository}`,
  );
  if (taskId) {
    expect(
      task?.id === taskId,
      'the same platform task',
      `expected task ${taskId}, found ${task?.id ?? 'nothing'}`,
    );
  }
  expect(
    platform.conversations.length === 1,
    'one conversation',
    `expected 1 conversation for ${facts.issueThread}, found ${platform.conversations.length}`,
  );
  expect(
    platform.tasks.length === 1,
    'one platform task',
    `expected 1 task, found ${platform.tasks.length}`,
  );
  expect(
    platform.activeLeases.length <= 1,
    'execution lease',
    `${platform.activeLeases.length} active leases for one repository`,
  );
  if (task) {
    expect(
      platform.activeLeases.every((lease) => lease.taskId === task.id),
      'lease bound to the executing task',
      'the active lease belongs to another task',
    );
    expect(
      ACTIVE_TASK_STATES.includes(task.state),
      'executing task is active',
      `executing task state is ${task.state}`,
    );
    expect(
      task.prNumber === null && task.prUrl === null,
      'no pull request from this work',
      `task reports PR ${task.prNumber ?? task.prUrl}`,
    );
  }
  expect(
    runtimeFacts.githubOutbox.length === 1 &&
      runtimeFacts.githubOutbox[0]?.kind === 'acknowledgement',
    'one GitHub write for the trigger',
    `outbox rows for ${facts.issueThread}: ${JSON.stringify(runtimeFacts.githubOutbox)}`,
  );
  expect(
    runtimeFacts.githubOutbox.every((row) => row.status === 'sent'),
    'the GitHub write settled',
    `outbox state ${runtimeFacts.githubOutbox.map((row) => row.status).join(',')}`,
  );
  expect(
    github.agentComments.length === 1 && github.agentComments[0]?.ack === true,
    'one acknowledgement comment',
    `${github.agentComments.length} agent comments, ${github.agentComments.filter((item) => item.ack).length} acknowledgements`,
  );
  expect(
    humanComments.length >= 1,
    'human trigger present',
    `no comment by ${HUMAN_LOGIN} on the probe Issue`,
  );

  if (order === 'web-first') {
    const [workspaceTicket] = workspaceTickets;
    expect(
      workspaceTickets.length === 1,
      'the Web-work ticket',
      `${workspaceTickets.length} runtime tickets for the workspace thread`,
    );
    expect(
      githubTickets.length === 1,
      'the extra GitHub ticket',
      `${githubTickets.length} runtime tickets for ${facts.issueThread}`,
    );
    expect(
      task?.ticketId === workspaceTicket?.id,
      'same work identity',
      `platform task follows ${task?.ticketId ?? 'nothing'}, Web worker ran ${workspaceTicket?.id ?? 'nothing'}`,
    );
    expect(
      workspaceTicket?.startedAssignments === 1 && workspaceTicket?.workerSessions === 1,
      'the work started once',
      `worker starts=${workspaceTicket?.startedAssignments ?? 0}, session dirs=${workspaceTicket?.workerSessions ?? 0}`,
    );
    expect(
      (githubTickets[0]?.startedAssignments ?? 0) === 0,
      'the GitHub ticket never started a worker',
      `the extra ticket has ${githubTickets[0]?.startedAssignments ?? 0} started assignments`,
    );
    expect(
      (githubTickets[0]?.workerSessions ?? 0) === 0,
      'no worker session for the GitHub ticket',
      `${githubTickets[0]?.workerSessions ?? 0} session directories`,
    );
    expect(
      typeof githubTickets[0]?.pausedStoppedAt === 'string' ||
        typeof githubTickets[0]?.ended === 'string',
      'the extra ticket is parked',
      'the GitHub ticket is neither paused with a stop proof nor ended',
    );
    expect(
      duplicates.length === 1 &&
        duplicates[0]?.ticketId === githubTickets[0]?.id &&
        PARKED_STATES.includes(duplicates[0]?.state),
      'durable duplicate pause',
      `duplicate rows=${JSON.stringify(duplicates)}`,
    );
    expect(
      platform.messages.notices === 1,
      'one duplicate notice',
      `${platform.messages.notices} notices in the conversation`,
    );
  }

  if (order === 'github-first') {
    expect(
      githubTickets.length === 1,
      'the GitHub-work ticket',
      `${githubTickets.length} runtime tickets for ${facts.issueThread}`,
    );
    expect(
      task?.ticketId === githubTickets[0]?.id,
      'same work identity',
      `platform task follows ${task?.ticketId ?? 'nothing'}, runtime ticket is ${githubTickets[0]?.id ?? 'nothing'}`,
    );
    expect(
      githubTickets[0]?.startedAssignments === 1 && githubTickets[0]?.workerSessions === 1,
      'the work started once',
      `worker starts=${githubTickets[0]?.startedAssignments ?? 0}, session dirs=${githubTickets[0]?.workerSessions ?? 0}`,
    );
    expect(
      duplicates.length === 0,
      'no duplicate ticket in this order',
      `${duplicates.length} parked tickets`,
    );

    if (phase === 'after-followup') {
      expect(
        platform.deliveries.some((row) => row.state === 'delivered'),
        'the Web follow-up reached the runtime',
        `delivery states ${JSON.stringify(platform.deliveries)}`,
      );
      expect(
        platform.deliveries.every((row) => row.state === 'delivered'),
        'no failed delivery',
        `delivery states ${JSON.stringify(platform.deliveries)}`,
      );
      expect(
        (githubTickets[0]?.undelivered ?? 1) === 0,
        'the follow-up is not left undelivered',
        `${githubTickets[0]?.undelivered ?? 0} undelivered inputs`,
      );
      expect(
        githubTickets[0]?.startedAssignments === 1 && githubTickets[0]?.workerSessions === 1,
        'the follow-up did not start a second worker',
        `worker starts=${githubTickets[0]?.startedAssignments ?? 0}`,
      );
      expect(
        runtimeFacts.githubOutbox.length === 1,
        'the Web follow-up wrote nothing to GitHub',
        `${runtimeFacts.githubOutbox.length} GitHub outbox rows`,
      );
    }
  }

  return failures;
}

async function factsOnce() {
  const issue = required('issue');
  return collect({
    issue,
    conversationId: typeof options.conversation === 'string' ? options.conversation : null,
  });
}

async function panel(method, path, body) {
  const headers = {
    'x-orchestrator-request': '1',
    origin: `http://127.0.0.1:${PANEL_PORT}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await globalThis.fetch(
    `http://127.0.0.1:${PANEL_PORT}/orchestrator/api${path}`,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForRuntime() {
  let streak = 0;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`);
      const body = await response.json();
      if (body?.ok === true && body?.configured === true) {
        streak += 1;
        if (streak >= 3) return body;
      } else streak = 0;
    } catch {
      streak = 0;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  }
  throw new Error('the runtime Bridge did not become healthy after the settings change');
}

/** Points the ephemeral stack's GitHub source and sender policy at the probe. */
async function runSetup() {
  const ownerId = state.M5B_OWNER_ID;
  if (!ownerId) throw new Error('M5B_OWNER_ID is missing; is the matrix stack up?');
  const before = await panel('GET', '/settings');
  const github = before.sources?.find((source) => source.id === 'github');
  if (!github) throw new Error('the runtime has no github source to configure');
  // The policy save does not restart the runtime; the source save does. Save the
  // policy first so the restart cannot race the sender list, then wait for health.
  const policyBlock = before.blocks.policy;
  const sources = {
    ...policyBlock.value.sources,
    github: { ...(policyBlock.value.sources.github ?? {}), allowed: [{ id: HUMAN_LOGIN }] },
    workspace: { ...(policyBlock.value.sources.workspace ?? {}), allowed: [{ id: ownerId }] },
  };
  const savedPolicy = await panel('PUT', '/settings/policy', {
    value: { ...policyBlock.value, sources },
    revision: policyBlock.revision,
  });
  const sourceValue = {
    ...github.value,
    config: {
      ...github.value.config,
      repository: PROBE_REPO,
      cli: github.value.config.cli ?? '/root/.local/bin/gh-agent',
    },
  };
  let savedSource = null;
  for (let attempt = 0; attempt < 10 && savedSource === null; attempt += 1) {
    try {
      savedSource = await panel('PUT', '/settings/source:github', {
        value: sourceValue,
        revision: github.revision + attempt,
      });
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
    }
  }
  const health = await waitForRuntime();
  const after = await panel('GET', '/settings');
  const githubAfter = after.sources?.find((source) => source.id === 'github');
  console.log(
    JSON.stringify(
      {
        probeRepository: PROBE_REPO,
        humanSender: HUMAN_LOGIN,
        ownerSender: ownerId,
        sourceBefore: github.value.config,
        sourceAfter: githubAfter?.value.config,
        policyBefore: policyBlock.value.sources,
        policyAfter: after.blocks.policy.value.sources,
        savedSource,
        savedPolicy,
        runtimeHealth: health,
        runtimeCursor: await (async () => {
          const db = runtime();
          try {
            const row = db.prepare("select value from kv where key = 'github-since'").get();
            return row ? parse(row.value) : null;
          } finally {
            db.close();
          }
        })(),
      },
      null,
      2,
    ),
  );
}

async function runFacts() {
  const facts = await factsOnce();
  console.log(JSON.stringify(facts, null, 2));
}

async function runCheck() {
  const order = required('order');
  if (!['web-first', 'github-first'].includes(order)) {
    throw new Error('--order must be web-first or github-first');
  }
  const phase = typeof options.phase === 'string' ? options.phase : 'after-import';
  if (!['after-import', 'after-followup', 'after-replay'].includes(phase)) {
    throw new Error('--phase must be after-import, after-followup or after-replay');
  }
  if (order === 'web-first') {
    required('conversation');
    required('task');
  }
  const deadline = Date.now() + Number(options.wait ?? 0) * 1000;
  let facts;
  let failures;
  for (;;) {
    facts = await factsOnce();
    failures = checks(facts, {
      order,
      phase,
      taskId: typeof options.task === 'string' ? options.task : null,
    });
    if (failures.length === 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 3000));
  }
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        order,
        phase,
        passed: failures.length === 0,
        failures,
        counters: {
          conversations: facts.platform.conversations.length,
          tasks: facts.platform.tasks.length,
          activeLeases: facts.platform.activeLeases.length,
          duplicateTickets: facts.platform.duplicates.map((row) => ({
            ticketId: row.ticketId,
            state: row.state,
          })),
          messages: facts.platform.messages,
          deliveries: facts.platform.deliveries,
          runtimeTickets: facts.runtime.tickets.map((ticket) => ({
            id: ticket.id,
            threads: ticket.threads,
            startedAssignments: ticket.startedAssignments,
            workerSessions: ticket.workerSessions,
            pausedStoppedAt: ticket.pausedStoppedAt,
            ended: ticket.ended,
            undelivered: ticket.undelivered,
          })),
          githubOutbox: facts.runtime.githubOutbox,
          agentComments: facts.github.agentComments,
        },
      },
      null,
      2,
    ),
  );
  if (failures.length > 0) process.exitCode = 1;
}

const handler =
  command === 'setup'
    ? runSetup
    : command === 'facts'
      ? runFacts
      : command === 'check'
        ? runCheck
        : null;
if (!handler) {
  console.error(
    'usage: dual-entrance.mjs setup | facts --order <o> --issue <n> | check --order <o> --issue <n> --phase <p>',
  );
  process.exit(2);
}
await handler();
