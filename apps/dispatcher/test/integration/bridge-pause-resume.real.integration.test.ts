/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.MOYU_BRIDGE_URL;
const token = process.env.MOYU_BRIDGE_TOKEN;
const repository = process.env.MOYU_BRIDGE_REPOSITORY;
const maybe = url && token && repository ? it : it.skip;

interface Snapshot {
  ticketId: string;
  state: string;
  assignmentId?: string | null;
  admissionRequired?: boolean;
  paused?: unknown;
}

async function bridge(path: string, init: RequestInit = {}) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

async function ticket(id: string): Promise<Snapshot> {
  return (await bridge(`/bridge/v1/tickets/${id}`)).body;
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    last = value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

async function ticketIdFor(triggerId: string): Promise<string> {
  return waitFor(async () => {
    const page = await bridge('/bridge/v1/events?cursor=0');
    const event = (page.body?.events ?? []).find(
      (item: any) => item.type === 'ticket.imported' && item.data?.triggerId === triggerId,
    );
    return event?.data?.ticketId ?? null;
  }, 'ticket import');
}

describe('live Bridge pause and resume over HTTP', () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const id of created) {
      await bridge(`/bridge/v1/tickets/${id}/pause`, {
        method: 'POST',
        body: JSON.stringify({ operationId: randomUUID() }),
      }).catch(() => undefined);
    }
  });

  maybe(
    'pauses to stopped and resumes with a newer generation',
    async () => {
      const conversationId = randomUUID();
      const triggerId = `m5b-pause-${randomUUID()}`;
      const created = await bridge('/bridge/v1/triggers', {
        method: 'POST',
        body: JSON.stringify({
          triggerId,
          conversationId,
          messageId: randomUUID(),
          replyToMessageId: null,
          actor: { id: 'm5b-probe' },
          text: 'M5-B pause/resume probe',
          at: new Date().toISOString(),
          executionSpec: {
            repository,
            baseBranch: 'main',
            baseCommit: null,
            model: null,
            mode: 'discuss',
          },
        }),
      });
      expect(created.status).toBe(200);
      const ticketId = await ticketIdFor(triggerId);
      created.push(ticketId);
      const before = await ticket(ticketId);
      expect(before.state).not.toBe('stopped');

      const paused = await bridge(`/bridge/v1/tickets/${ticketId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ operationId: randomUUID() }),
      });
      expect([200, 202]).toContain(paused.status);
      const stopped = await waitFor(async () => {
        const snapshot = await ticket(ticketId);
        return snapshot.state === 'stopped' ? snapshot : null;
      }, 'stopped');
      expect(stopped.state).toBe('stopped');

      const resumed = await bridge(`/bridge/v1/tickets/${ticketId}/resume`, {
        method: 'POST',
        body: JSON.stringify({
          operationId: randomUUID(),
          admission: { leaseId: `lease-${randomUUID()}`, fencingToken: '101' },
        }),
      });
      expect([200, 202]).toContain(resumed.status);
      const running = await waitFor(async () => {
        const snapshot = await ticket(ticketId);
        return snapshot.assignmentId && snapshot.assignmentId !== before.assignmentId
          ? snapshot
          : null;
      }, 'resumed assignment');
      expect(running.assignmentId).not.toBe(before.assignmentId);
    },
    90_000,
  );
});
