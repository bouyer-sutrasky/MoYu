#!/usr/bin/env node
/**
 * Loopback-only deterministic OpenAI-completions provider for an isolated M5-B
 * runtime. It is test infrastructure: never point a production profile at it.
 *
 * Usage: LOCAL_PROVIDER_PORT=3801 node scripts/m5b/local-provider.mjs
 * The profile must use baseURL http://127.0.0.1:<port>/v1, model `local-test`
 * and a dummy apiKeyEnv. Requests are logged to LOCAL_PROVIDER_LOG.
 */
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.LOCAL_PROVIDER_PORT ?? 3801);
const log = process.env.LOCAL_PROVIDER_LOG ?? '/tmp/moyu-local-provider.jsonl';
const triggerFile = process.env.LOCAL_PROVIDER_TRIGGER_FILE;
/**
 * Seconds a worker's turn stays open. A matrix scenario that needs the ticket to
 * remain `running` while it pauses it writes this file; the value comes from the
 * provider's own environment so a stale file cannot change a normal run.
 */
function longTurnSeconds() {
  const file = process.env.LOCAL_PROVIDER_WORKER_SLEEP_FILE;
  if (!file) return 0;
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

let sequence = 0;

/** The trigger id the orchestrator route should accept: a per-run file wins over the fixed env value. */
function routedTriggerId(body) {
  if (triggerFile) {
    try {
      const value = fs.readFileSync(triggerFile, 'utf8').trim();
      if (value) return value;
    } catch {
      /* a missing file falls back to the prompt scan */
    }
  }
  if (process.env.LOCAL_PROVIDER_TRIGGER_ID) return process.env.LOCAL_PROVIDER_TRIGGER_ID;
  // The orchestrator prompt carries the candidate card, so the deterministic
  // stand-in for a model decision reads the candidate id out of it. The last
  // match wins: the newest delivered trigger is the one to answer.
  const text = (body.messages ?? [])
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n');
  // The candidate card carries `"trigger_id":"..."`; a bare scan would also
  // match the thread key (`workspace:workspace:<conversation>`), so read the
  // field first and fall back to the scan.
  const cards = [...text.matchAll(/"trigger_id"\s*:\s*"(workspace:[^"]+|github:[0-9]+)"/g)];
  if (cards.length > 0) return cards[cards.length - 1][1];
  const matches = [...text.matchAll(/(workspace:[A-Za-z0-9._:-]+|github:[0-9]+)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : 'workspace:probe-1';
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });

function completion(model, choice) {
  return {
    id: `chatcmpl-local-${++sequence}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'local-test', object: 'model', owned_by: 'local' }],
      }),
    );
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  const raw = await readBody(request);
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* a malformed request is answered deterministically below */
  }
  const tools = (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
  if (process.env.LOCAL_PROVIDER_DUMP) {
    // Diagnostic only: a write failure must never turn into a failed model
    // request (a stale file owned by another user did exactly that once).
    try {
      fs.appendFileSync(
        process.env.LOCAL_PROVIDER_DUMP,
        JSON.stringify({ at: new Date().toISOString(), tools, messages: body.messages ?? [] }) +
          '\n',
      );
    } catch {
      /* ignore a diagnostic dump that cannot be written */
    }
  }
  try {
    fs.appendFileSync(
      log,
      JSON.stringify({
        at: new Date().toISOString(),
        stream: !!body.stream,
        model: body.model,
        tools,
        roles: (body.messages ?? []).map((message) => message.role),
      }) + '\n',
    );
  } catch {
    /* the log is diagnostic; never fail the request because of it */
  }
  // An open turn without a child process: the worker is waiting on the model.
  // A matrix scenario that restarts the runtime in a waiting state uses this so
  // the restart cannot orphan a descendant.
  const delayFile = process.env.LOCAL_PROVIDER_WORKER_DELAY_FILE;
  if (delayFile && tools.includes('orchestrator_report')) {
    try {
      const delayMs = Number(fs.readFileSync(delayFile, 'utf8').trim());
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
      }
    } catch {
      /* a missing file answers immediately */
    }
  }
  const id = `chatcmpl-local-${++sequence}`;
  // Deterministic route decision for an isolated probe. Replace the trigger id
  // with the candidate card's id when driving a different fixture.
  const decision = {
    decisions: [
      {
        kind: 'accept',
        trigger_id: routedTriggerId(body),
        title: 'Fix README probe line',
        worktree_name: 'fix-readme-probe',
        acknowledgement: 'On it: updating the README probe line.',
      },
    ],
  };
  // A turn starts with a user message. Answering only there keeps one route
  // decision (or one worker report) per delivered candidate, even when earlier
  // turns already carry a tool result in the history.
  const messages = body.messages ?? [];
  const turnStart = messages.length === 0 || messages[messages.length - 1].role === 'user';
  const sawRouteResult = false;
  // A worker session reports through `orchestrator_report`. The report kind is
  // the fixture knob: `ready` reaches awaiting_review, a `human_action` reaches
  // waiting_input. LOCAL_PROVIDER_WORKER_REPORT carries the JSON arguments.
  // A per-scenario file wins over the fixed value so a matrix run can change the
  // worker's report kind without restarting the provider.
  const reportFile = process.env.LOCAL_PROVIDER_WORKER_REPORT_FILE;
  let reportArguments = process.env.LOCAL_PROVIDER_WORKER_REPORT;
  if (reportFile) {
    try {
      const value = fs.readFileSync(reportFile, 'utf8').trim();
      if (value) reportArguments = value;
    } catch {
      /* a missing file falls back to the fixed value */
    }
  }
  // A worker turn: report once at the turn start, then keep the turn open with a
  // real long-running bash call when the scenario asks for it. A plain text reply
  // ends the turn, which is what the executor turns into an ended ticket.
  const reportedAlready = messages.some(
    (message) =>
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((call) => call?.function?.name === 'orchestrator_report'),
  );
  const longBashAlready = messages.some(
    (message) =>
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some((call) => call?.function?.name === 'bash'),
  );
  const sleepSeconds = longTurnSeconds();
  // Fixture mode for the awaiting_review scenario: the worker runs one script that
  // pushes its ticket branch and opens a real PR in the test repository, then
  // reports with that `pr_number`. The runtime claims the PR thread, so the ready
  // report keeps the ticket open instead of ending it.
  const openPrFile = process.env.LOCAL_PROVIDER_WORKER_OPEN_PR_FILE;
  let openPrScript = null;
  if (openPrFile) {
    try {
      const value = fs.readFileSync(openPrFile, 'utf8').trim();
      if (value) openPrScript = value;
    } catch {
      openPrScript = null;
    }
  }
  // The harness opens the PR from the pushed branch (the worker's bash tool has a
  // short foreground budget), so the report waits briefly for that number.
  const prNumberFile = process.env.LOCAL_PROVIDER_PR_NUMBER_FILE;
  const numberFromFile = async () => {
    if (!prNumberFile) return null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const value = fs.readFileSync(prNumberFile, 'utf8').trim();
        if (/^\d+$/.test(value)) return Number(value);
      } catch {
        /* not written yet */
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    return null;
  };
  const prNumberFrom = (messageList) => {
    for (let index = messageList.length - 1; index >= 0; index -= 1) {
      const message = messageList[index];
      if (message.role !== 'tool') continue;
      const text =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const match = /PR_NUMBER=(\d+)/.exec(text ?? '');
      if (match) return Number(match[1]);
    }
    return null;
  };

  function call(name, args) {
    return {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_${id}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    };
  }
  let choice;
  if (tools.includes('orchestrator_route') && turnStart) {
    choice = call('orchestrator_route', decision);
  } else if (
    tools.includes('orchestrator_report') &&
    turnStart &&
    reportArguments &&
    !reportedAlready &&
    !openPrScript
  ) {
    choice = call('orchestrator_report', JSON.parse(reportArguments));
  } else if (tools.includes('bash') && openPrScript && !longBashAlready) {
    choice = call('bash', {
      description: 'Matrix fixture: push the ticket branch and open a real PR',
      command: `sh ${openPrScript}`,
    });
  } else if (tools.includes('orchestrator_report') && openPrScript && !reportedAlready) {
    const number = prNumberFrom(messages) ?? (await numberFromFile());
    choice = call('orchestrator_report', {
      state: 'ready',
      summary: 'Lifecycle probe ready for review.',
      ...(number ? { pr_number: number } : {}),
    });
  } else if (tools.includes('bash') && sleepSeconds > 0 && !longBashAlready && reportedAlready) {
    choice = call('bash', {
      description: 'Matrix fixture: keep the worker turn open',
      command: `sh -c 'sleep ${sleepSeconds} & sleep ${sleepSeconds} & wait'`,
    });
  } else {
    choice = {
      index: 0,
      message: { role: 'assistant', content: 'Deterministic local provider response.' },
      finish_reason: 'stop',
    };
  }
  fs.appendFileSync(
    log,
    JSON.stringify({
      at: new Date().toISOString(),
      response: {
        id,
        tools,
        sawRouteResult,
        choice: {
          finish: choice.finish_reason,
          tool: choice.message.tool_calls?.[0]?.function?.name ?? null,
          arguments: choice.message.tool_calls?.[0]?.function?.arguments ?? null,
        },
      },
    }) + '\n',
  );
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(completion(body.model ?? 'local-test', choice)));
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const delta =
    choice.finish_reason === 'tool_calls'
      ? {
          role: 'assistant',
          tool_calls: choice.message.tool_calls.map((call, index) => ({ index, ...call })),
        }
      : { role: 'assistant', content: choice.message.content };
  for (const value of [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] },
  ])
    response.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'local-test',
        ...value,
      })}\n\n`,
    );
  response.write('data: [DONE]\n\n');
  response.end();
});
server.listen(port, '127.0.0.1', () =>
  console.log(`local provider listening on 127.0.0.1:${port}`),
);
