#!/usr/bin/env node
/**
 * Sends the same workspace Trigger twice at the same time to an isolated M5-B
 * Bridge. The runtime's persisted Trigger id is the idempotency key: exactly
 * one request must be `stored` and the other `duplicate`, and a paused Ticket
 * must keep one input. Prints the raw responses and exits non-zero when the
 * invariant does not hold.
 *
 * The HTTP result alone does not prove the two invariants this fixture claims.
 * Two further checks are done against the two real stores, separately, and their
 * exact statements are recorded with the evidence:
 *
 *   persisted runtime input (Bridge SQLite state, one row per trigger id):
 *     sqlite3 /root/.dsh-m5/state/m5b/orchestrator.sqlite \
 *       "select count(*) from bridge_triggers where id='<triggerId>';"
 *   platform delivery count (dispatcher PostgreSQL):
 *     psql "$DATABASE_URL" -c "select count(*) from deliveries where payload->>'triggerId'='<triggerId>';"
 *
 * Run this script only against the isolated matrix stack; point both statements at
 * that stack's state directory and database, never at production.
 *
 * Required env:
 *   MOYU_BRIDGE_URL, MOYU_BRIDGE_TOKEN, MOYU_BRIDGE_TICKET_ID, MOYU_BRIDGE_REPOSITORY
 * Optional:
 *   MOYU_BRIDGE_TRIGGER_ID, MOYU_BRIDGE_ACTOR,
 *   MOYU_BRIDGE_ADMISSION_LEASE_ID, MOYU_BRIDGE_ADMISSION_FENCE
 */
import { randomUUID } from 'node:crypto';

const url = process.env.MOYU_BRIDGE_URL;
const token = process.env.MOYU_BRIDGE_TOKEN;
const ticketId = process.env.MOYU_BRIDGE_TICKET_ID;
const repository = process.env.MOYU_BRIDGE_REPOSITORY;
if (!url || !token || !ticketId || !repository) {
  console.error(
    'MOYU_BRIDGE_URL, MOYU_BRIDGE_TOKEN, MOYU_BRIDGE_TICKET_ID and MOYU_BRIDGE_REPOSITORY are required',
  );
  process.exit(2);
}

const triggerId = process.env.MOYU_BRIDGE_TRIGGER_ID ?? `workspace:concurrent-${randomUUID()}`;
const body = {
  triggerId,
  conversationId: randomUUID(),
  messageId: randomUUID(),
  replyToMessageId: null,
  actor: { id: process.env.MOYU_BRIDGE_ACTOR ?? 'm5b-probe', name: 'M5-B concurrency probe' },
  text: 'Also correct the adjacent typo in the same table.',
  at: new Date().toISOString(),
  targetTicketId: ticketId,
  executionSpec: {
    repository,
    baseBranch: process.env.MOYU_BRIDGE_BASE_BRANCH ?? 'main',
    baseCommit: null,
    model: process.env.MOYU_BRIDGE_MODEL
      ? {
          provider: process.env.MOYU_BRIDGE_MODEL.split('/')[0],
          model: process.env.MOYU_BRIDGE_MODEL.split('/').slice(1).join('/'),
        }
      : { provider: 'local-test', model: 'local-test' },
    mode: 'execute',
  },
  admission: {
    leaseId: process.env.MOYU_BRIDGE_ADMISSION_LEASE_ID ?? 'lease-concurrent',
    fencingToken: process.env.MOYU_BRIDGE_ADMISSION_FENCE ?? '2000000000000',
  },
};

async function post(name) {
  const started = Date.now();
  const response = await globalThis.fetch(`${url}/bridge/v1/triggers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    name,
    started,
    finished: Date.now(),
    status: response.status,
    body: await response.text(),
  };
}

const posts = await Promise.all([post('A'), post('B')]);
const parsed = posts.map((item) => {
  try {
    return JSON.parse(item.body).result;
  } catch {
    return 'unparseable';
  }
});
console.log(JSON.stringify({ at: new Date().toISOString(), triggerId, posts }, null, 2));
const sorted = [...parsed].sort().join(',');
if (sorted !== 'duplicate,stored') {
  console.error(`expected one stored and one duplicate, got: ${parsed.join(',')}`);
  process.exitCode = 1;
}
