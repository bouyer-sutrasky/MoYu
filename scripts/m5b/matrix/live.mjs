#!/usr/bin/env node
/**
 * Drives the isolated M5-B matrix stack through the real owner API and the real
 * Bridge. Every command prints what it did; nothing here fakes a state field.
 *
 *   node scripts/m5b/matrix/live.mjs new-task --text "..." [--client-request-id id]
 *   node scripts/m5b/matrix/live.mjs start|pause|resume|retry --task <id>
 *   node scripts/m5b/matrix/live.mjs message --conversation <id> --text "..."
 *   node scripts/m5b/matrix/live.mjs snapshot --task <id>
 *   node scripts/m5b/matrix/live.mjs wait --task <id> --state waiting_input --timeout 120000
 *   node scripts/m5b/matrix/live.mjs ticket --ticket <id>
 *
 * Requires /tmp/m5bmatrix/state.env (written by stack.sh up) or the same
 * M5B_* variables in the environment.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

function loadState() {
  const file =
    process.env.M5B_MATRIX_STATE ??
    `${process.env.M5B_MATRIX_RUN ?? '/tmp/m5bmatrix'}/protected/state.env`;
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
const API = `http://127.0.0.1:${process.env.M5B_MATRIX_API_PORT ?? 4510}`;
const PG_URL =
  process.env.M5B_MATRIX_PG_URL ??
  `postgres://moyu@127.0.0.1:55433/${process.env.M5B_MATRIX_DB ?? 'm5b_matrix'}`;

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

function client() {
  return new Client({ connectionString: PG_URL });
}

async function query(sql, params = []) {
  const client_ = client();
  await client_.connect();
  try {
    return (await client_.query(sql, params)).rows;
  } finally {
    await client_.end();
  }
}

async function taskRow(taskId) {
  const rows = await query(
    `select id, conversation_id, state, version, upstream_ticket_id, base_branch, model_id,
            runtime_lease_id, stopped_at, stop_evidence, pr_url, pr_number, plan_revision
       from task_links where id = $1`,
    [taskId],
  );
  if (!rows[0]) throw new Error(`task ${taskId} not found`);
  return rows[0];
}

async function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

const commands = {
  async 'new-task'() {
    const clientRequestId = options['client-request-id'] ?? `matrix-${randomUUID()}`;
    const created = await api('POST', '/api/v1/conversations', {
      repositoryId: state.M5B_REPOSITORY_ID,
      mode: 'work',
      executionMode: 'execute',
      baseBranch: 'main',
      clientRequestId,
      model: { provider: 'local-test', model: 'local-test' },
    });
    if (created.status !== 201) {
      await print(created);
      process.exitCode = 1;
      return;
    }
    const conversation = created.body.data.conversation;
    const messageText =
      options.text ?? 'Matrix lifecycle probe: verify the runtime accepts the task.';
    const message = await api('POST', `/api/v1/conversations/${conversation.id}/messages`, {
      clientMessageId: `message-${randomUUID()}`,
      text: messageText,
    });
    if (![200, 201, 202].includes(message.status)) {
      await print({ created: conversation.id, message });
      process.exitCode = 1;
      return;
    }
    await print({
      conversationId: conversation.id,
      taskId: conversation.task.id,
      state: conversation.task.state,
      messageStatus: message.status,
      clientRequestId,
    });
  },

  async start() {
    const task = await taskRow(options.task);
    const response = await api('POST', `/api/v1/tasks/${task.id}/start`, {
      clientCommandId: `start-${randomUUID()}`,
      expectedVersion: Number(task.version),
      planRevision: Number(task.plan_revision ?? 1) || 1,
    });
    await print({
      status: response.status,
      body: response.body,
      sent: { expectedVersion: task.version },
    });
    if (response.status !== 202) process.exitCode = 1;
  },

  async pause() {
    const task = await taskRow(options.task);
    const response = await api('POST', `/api/v1/tasks/${task.id}/stop`, {
      clientCommandId: `stop-${randomUUID()}`,
      expectedVersion: Number(task.version),
    });
    await print({
      status: response.status,
      body: response.body,
      sent: { expectedVersion: task.version },
    });
    if (response.status !== 202) process.exitCode = 1;
  },

  async resume() {
    const task = await taskRow(options.task);
    const response = await api('POST', `/api/v1/tasks/${task.id}/resume`, {
      clientCommandId: `resume-${randomUUID()}`,
      expectedVersion: Number(task.version),
    });
    await print({
      status: response.status,
      body: response.body,
      sent: { expectedVersion: task.version },
    });
    if (response.status !== 202) process.exitCode = 1;
  },

  async retry() {
    const task = await taskRow(options.task);
    const response = await api('POST', `/api/v1/tasks/${task.id}/retry`, {
      clientCommandId: `retry-${randomUUID()}`,
      expectedVersion: Number(task.version),
    });
    await print({
      status: response.status,
      body: response.body,
      sent: { expectedVersion: task.version },
    });
    if (response.status !== 202) process.exitCode = 1;
  },

  async message() {
    const response = await api('POST', `/api/v1/conversations/${options.conversation}/messages`, {
      clientMessageId: `message-${randomUUID()}`,
      text: options.text ?? 'Matrix follow-up.',
    });
    await print({ status: response.status, body: response.body });
    if (![200, 201, 202].includes(response.status)) process.exitCode = 1;
  },

  async snapshot() {
    const task = await taskRow(options.task);
    const conversations = await query(
      `select id, source, external_key, external_url, execution_mode, model_id
         from conversations where id = $1`,
      [task.conversation_id],
    );
    const operations = await query(
      `select kind, state, attempts, last_error_code, created_at, updated_at
         from task_operations where task_id = $1 order by created_at`,
      [task.id],
    );
    const leases = await query(
      `select id, state, fencing_token, expires_at, task_id from runtime_leases where task_id = $1`,
      [task.id],
    );
    const instance = await query(
      `select state, desired_state, pid, port, bridge_port, profile, reason_code,
              memory_current_bytes, memory_events, resource_state
         from repository_instances where repository_id = $1`,
      [task.upstream_ticket_id ? state.M5B_REPOSITORY_ID : state.M5B_REPOSITORY_ID],
    );
    await print({
      task,
      conversation: conversations[0] ?? null,
      operations,
      leases,
      instance: instance[0] ?? null,
    });
  },

  async ticket() {
    const response = await globalThis.fetch(
      `${state.M5B_BRIDGE_URL}/bridge/v1/tickets/${options.ticket}`,
      { headers: { authorization: `Bearer ${state.M5B_BRIDGE_TOKEN}` } },
    );
    await print({ status: response.status, body: await response.json().catch(() => null) });
  },

  async wait() {
    const wanted = String(options.state ?? 'running').split(',');
    const deadline = Date.now() + Number(options.timeout ?? 120_000);
    let last = null;
    while (Date.now() < deadline) {
      last = await taskRow(options.task);
      if (wanted.includes(last.state)) {
        await print({ matched: last.state, task: last });
        return;
      }
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, Number(options.interval ?? 500)),
      );
    }
    await print({ matched: null, wanted, last });
    process.exitCode = 1;
  },
};

const handler = commands[command];
if (!handler) {
  console.error(`unknown command: ${command}`);
  console.error(`known: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
await handler();
