import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@moyu/runtime-client';

import { acquireExecutionLease } from '../../src/leases';
import type { RepositoryBinding } from '../../src/runtime';
import { applyEvent } from '../../src/sync';
import { createTestDatabase, type TestDatabase } from './helpers';

const logger = { info() {}, warn() {}, error() {} };

describe('an expired generation cannot project through a matching reservation', () => {
  let db: TestDatabase;
  let repository: RepositoryBinding;
  let taskId = '';
  let leaseId = '';
  let token = '';

  beforeAll(async () => {
    db = await createTestDatabase();
    const owner = await db.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('expired-reservation') returning id`,
    );
    const repo = await db.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name, default_branch, status) values ($1, $2, 'main', 'active') returning id`,
      [owner.rows[0]!.id, `Bouyer12/m5b-expired-reservation-${process.pid}`],
    );
    repository = {
      id: repo.rows[0]!.id,
      fullName: `Bouyer12/m5b-expired-reservation-${process.pid}`,
      defaultBranch: 'main',
      bridgeUrl: 'http://127.0.0.1:1',
      bridgeCredentialRef: 'MOYU_BRIDGE_TOKEN',
    };
    const conversation = await db.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch, title)
       values ($1, $2, 'work', 'execute', 'main', 'expired reservation') returning id`,
      [owner.rows[0]!.id, repository.id],
    );
    const task = await db.pool.query<{ id: string }>(
      `insert into task_links (conversation_id, repository_id, state, base_branch, upstream_ticket_id)
       values ($1, $2, 'queued', 'main', 'ticket-1') returning id`,
      [conversation.rows[0]!.id, repository.id],
    );
    taskId = task.rows[0]!.id;
    const lease = await acquireExecutionLease(db.pool, repository.id, { taskId }, 60_000);
    leaseId = lease.lease!.id;
    token = lease.lease!.fencingToken;

    // The reservation matches this exact event identity. Only the lease is expired,
    // so identity alone must not be treated as proof that the generation is live.
    await db.pool.query(
      `insert into execution_reservations
         (repository_id, task_id, ticket_id, assignment_id, lease_id, fencing_token, request_key, state)
       values ($1, $2, 'ticket-1', 'assignment-1', $3, $4, $5, 'claimed')`,
      [repository.id, taskId, leaseId, token, `admit:${taskId}`],
    );
    await db.pool.query(
      `update runtime_leases set expires_at = now() - interval '1 second' where id = $1`,
      [leaseId],
    );
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  it('keeps the task queued when the only matching lease has expired', async () => {
    const event = {
      id: 'evt-expired-reservation',
      type: 'ticket.state_changed',
      seq: 10,
      at: new Date().toISOString(),
      data: {
        ticketId: 'ticket-1',
        state: 'running',
        assignmentId: 'assignment-1',
        leaseId,
        fencingToken: token,
      },
    } as unknown as BridgeEvent;

    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await applyEvent(client, repository, event, logger);
      await client.query('commit');
    } finally {
      client.release();
    }

    const task = await db.pool.query<{ state: string; stop_evidence: Record<string, unknown> }>(
      `select state, stop_evidence from task_links where id = $1`,
      [taskId],
    );
    expect(task.rows[0]?.state).toBe('queued');
    expect(task.rows[0]?.stop_evidence).toMatchObject({ admissionProjection: 'stale_generation' });
  });

  it('keeps the task queued when the matching lease was already released', async () => {
    // The same hole exists for a lease that moved to released rather than merely
    // expiring: the reservation and identity still agree, so identity alone must
    // not promote the task.
    await db.pool.query(
      `update runtime_leases set state = 'released', released_at = now() where id = $1`,
      [leaseId],
    );

    const event = {
      id: 'evt-released-reservation',
      type: 'ticket.state_changed',
      seq: 11,
      at: new Date().toISOString(),
      data: {
        ticketId: 'ticket-1',
        state: 'running',
        assignmentId: 'assignment-1',
        leaseId,
        fencingToken: token,
      },
    } as unknown as BridgeEvent;

    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await applyEvent(client, repository, event, logger);
      await client.query('commit');
    } finally {
      client.release();
    }

    const task = await db.pool.query<{ state: string }>(
      `select state from task_links where id = $1`,
      [taskId],
    );
    expect(task.rows[0]?.state).toBe('queued');
  });

  it('still projects a de-escalating event from that generation', async () => {
    // Blocking promotions must not swallow a genuine stop: dropping it would
    // leave the task stuck with no way to observe the outcome.
    const event = {
      id: 'evt-released-stop',
      type: 'ticket.state_changed',
      seq: 12,
      at: new Date().toISOString(),
      data: {
        ticketId: 'ticket-1',
        state: 'stopped',
        assignmentId: 'assignment-1',
        leaseId,
        fencingToken: token,
      },
    } as unknown as BridgeEvent;

    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await applyEvent(client, repository, event, logger);
      await client.query('commit');
    } finally {
      client.release();
    }

    const task = await db.pool.query<{ state: string }>(
      `select state from task_links where id = $1`,
      [taskId],
    );
    expect(task.rows[0]?.state).toBe('stopped');
  });
});
