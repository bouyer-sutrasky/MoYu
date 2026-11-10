#!/usr/bin/env node
/**
 * A recording stand-in for the runtime Bridge, used only to capture the exact
 * trigger payload the dispatcher sends for a message that carries attachments.
 * It implements the small set of endpoints the dispatcher needs; it is not a
 * runtime and makes no execution claims.
 */
import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.M6A_STUB_PORT ?? 4699);
const TOKEN = process.env.M6A_STUB_TOKEN;
if (!TOKEN) throw new Error('M6A_STUB_TOKEN is required');
const RECORD = process.env.M6A_STUB_RECORD ?? '/tmp/m6a/bridge-triggers.jsonl';

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
    const json = (payload) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (url.pathname === '/bridge/v1/capabilities') {
      json({
        protocolVersion: 'm6a-stub-1',
        upstream: { package: 'stub', version: '1', commit: null },
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
          branches: true,
          admission: true,
        },
        source: { kind: 'workspace', enabled: true },
      });
      return;
    }
    if (url.pathname === '/bridge/v1/events') {
      json({ events: [], next: 0, hasMore: false });
      return;
    }
    if (url.pathname === '/bridge/v1/triggers') {
      appendFileSync(RECORD, `${JSON.stringify({ at: new Date().toISOString(), body })}\n`);
      json({
        result: 'stored',
        triggerId: body?.triggerId ?? 'unknown',
        baseCommit: body?.executionSpec?.baseCommit ?? null,
        ticketId: 't_m6a_stub_ticket',
      });
      return;
    }
    json({ error: 'not implemented' });
  });
});
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`stub bridge listening on ${PORT}\n`);
});
