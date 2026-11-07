/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.MOYU_BRIDGE_URL;
const token = process.env.MOYU_BRIDGE_TOKEN;
const repository = process.env.MOYU_BRIDGE_REPOSITORY;
const maybe = url && token && repository ? it : it.skip;

interface Admission {
  leaseId: string;
  fencingToken: string;
}

interface PausedEvidence {
  stoppedAt?: string;
  evidence?: Record<string, unknown>;
}

interface Snapshot {
  ticketId: string;
  state: string;
  assignmentId?: string | null;
  admission?: Admission | null;
  admissionRequired?: boolean;
  paused?: PausedEvidence | null;
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
    'pause records stop evidence, resume records the actual fence and a running generation',
    async () => {
      const conversationId = randomUUID();
      const triggerId = `m5b-pause-${randomUUID()}`;
      const createdTrigger = process.env.MOYU_BRIDGE_TICKET_ID
        ? null
        : await bridge('/bridge/v1/triggers', {
            method: 'POST',
            body: JSON.stringify({
              triggerId,
              conversationId,
              messageId: randomUUID(),
              replyToMessageId: null,
              actor: { id: process.env.MOYU_BRIDGE_ACTOR ?? 'm5b-probe' },
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
      if (createdTrigger) expect(createdTrigger.status).toBe(200);
      const ticketId = process.env.MOYU_BRIDGE_TICKET_ID ?? (await ticketIdFor(triggerId));
      created.push(ticketId);
      const before = await ticket(ticketId);
      expect(before.state).not.toBe('stopped');
      expect(before.assignmentId).toBeTruthy();

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
      // A stopped projection is not enough: the runtime must have recorded the
      // worker stop evidence, and the dispatcher can assert it.
      expect(stopped.paused?.stoppedAt).toBeTruthy();
      expect(stopped.paused?.evidence).toMatchObject({
        ticketId,
        assignmentId: before.assignmentId,
      });
      const evidence = stopped.paused?.evidence ?? {};
      expect(Array.isArray(evidence.lingeringPids)).toBe(true);
      expect(evidence.lingeringPids).toEqual([]);

      const admission: Admission = {
        leaseId: process.env.MOYU_BRIDGE_ADMISSION_LEASE_ID ?? `lease-${randomUUID()}`,
        fencingToken:
          process.env.MOYU_BRIDGE_ADMISSION_FENCE ??
          // A token strictly above the current generation; the runtime keeps a
          // repository-wide fence and refuses a replayed older one.
          String(BigInt(before.admission?.fencingToken ?? '0') + 1n),
      };
      const resumed = await bridge(`/bridge/v1/tickets/${ticketId}/resume`, {
        method: 'POST',
        body: JSON.stringify({ operationId: randomUUID(), admission }),
      });
      expect([200, 202]).toContain(resumed.status);
      const running = await waitFor(async () => {
        const snapshot = await ticket(ticketId);
        return snapshot.assignmentId && snapshot.assignmentId !== before.assignmentId
          ? snapshot
          : null;
      }, 'resumed assignment');
      expect(running.assignmentId).not.toBe(before.assignmentId);
      expect(running.state).toBe('running');
      // The snapshot exposes the fence the runtime actually accepted, not just
      // the value the caller submitted.
      expect(running.admission).toEqual(admission);

      // The superseded generation can no longer be admitted for this Ticket.
      const stale = await bridge(`/bridge/v1/tickets/${ticketId}/admit`, {
        method: 'POST',
        body: JSON.stringify({
          ...(running.assignmentId ? { assignmentId: running.assignmentId } : {}),
          admission: {
            leaseId: before.admission?.leaseId ?? 'stale-lease',
            fencingToken: before.admission?.fencingToken ?? '0',
          },
        }),
      });
      expect(stale.status).toBe(422);
      const afterStale = await ticket(ticketId);
      expect(afterStale.admission).toEqual(admission);
      expect(afterStale.assignmentId).toBe(running.assignmentId);
      expect(afterStale.state).toBe('running');
    },
    90_000,
  );
});
