import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BridgeTicketSnapshot, RuntimeBridgeClient } from '@moyu/runtime-client';

import { acquireExecutionLease, receiptIsCurrent, reconcileLeases } from '../../src/leases';
import { createConsoleLogger } from '../../src/logger';
import type { RepositoryBinding } from '../../src/runtime';
import { createTestDatabase, type TestDatabase } from './helpers';

const logger = createConsoleLogger('test');

function bridgeWith(snapshot: Partial<BridgeTicketSnapshot>): RuntimeBridgeClient {
  return {
    ticket: async () => ({
      ticketId: 'ticket-1',
      title: 'lease test',
      state: 'running',
      paused: null,
      ...snapshot,
    }),
  } as unknown as RuntimeBridgeClient;
}

describe('repository execution lease on real PostgreSQL', () => {
  let testDatabase: TestDatabase;
  let repository: RepositoryBinding;
  let ownerId: string;
  let counter = 0;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
    const owner = await testDatabase.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('M5-B lease owner') returning id`,
    );
    ownerId = owner.rows[0]!.id;
    const repo = await testDatabase.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name, default_branch, status)
       values ($1, $2, 'main', 'active') returning id`,
      [ownerId, `Bouyer12/m5b-lease-${process.pid}`],
    );
    repository = {
      id: repo.rows[0]!.id,
      fullName: `Bouyer12/m5b-lease-${process.pid}`,
      defaultBranch: 'main',
      bridgeUrl: 'http://127.0.0.1:1',
      bridgeCredentialRef: 'MOYU_BRIDGE_TOKEN',
    };
  }, 60_000);

  afterAll(async () => {
    if (testDatabase) await testDatabase.drop();
  });

  beforeEach(async () => {
    await testDatabase.pool.query(
      `update runtime_leases set state = 'released', released_at = now()
        where repository_id = $1 and state = 'active'`,
      [repository.id],
    );
    await testDatabase.pool.query(
      `update task_links set runtime_lease_id = null where repository_id = $1`,
      [repository.id],
    );
  });

  async function seedTask(state = 'running'): Promise<{ taskId: string; ticketId: string }> {
    counter += 1;
    const suffix = `${process.pid}-${counter}-${Date.now()}`;
    const conversation = await testDatabase.pool.query<{ id: string }>(
      `insert into conversations
         (owner_id, repository_id, mode, execution_mode, source, base_branch, title)
       values ($1, $2, 'work', 'execute', 'web', 'main', $3) returning id`,
      [ownerId, repository.id, `lease task ${suffix}`],
    );
    const ticketId = `ticket-${suffix}`;
    const task = await testDatabase.pool.query<{ id: string }>(
      `insert into task_links
         (conversation_id, repository_id, upstream_ticket_id, upstream_thread_id, state, base_branch)
       values ($1, $2, $3, $4, $5, 'main') returning id`,
      [conversation.rows[0]!.id, repository.id, ticketId, `workspace:${suffix}`, state],
    );
    return { taskId: task.rows[0]!.id, ticketId };
  }

  it('issues exactly one generation when two tasks race for the same repository', async () => {
    const first = await seedTask();
    const second = await seedTask();
    const [left, right] = await Promise.all([
      acquireExecutionLease(testDatabase.pool, repository.id, { taskId: first.taskId }, 60_000),
      acquireExecutionLease(testDatabase.pool, repository.id, { taskId: second.taskId }, 60_000),
    ]);
    const granted = [left, right].filter((account) => account.lease);
    expect(granted).toHaveLength(1);
    expect([left, right].some((account) => account.refused === 'held')).toBe(true);
    const rows = await testDatabase.pool.query<{ count: number }>(
      `select count(*)::int as count from runtime_leases
        where repository_id = $1 and state = 'active'`,
      [repository.id],
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('refuses a replacement until the old execution is proven stopped, then fences a new generation', async () => {
    const running = await seedTask('running');
    const waiting = await seedTask('waiting_input');
    const first = await acquireExecutionLease(
      testDatabase.pool,
      repository.id,
      { taskId: running.taskId },
      60_000,
    );
    expect(first.lease).not.toBeNull();
    const firstToken = first.lease!.fencingToken;

    await testDatabase.pool.query(
      `update runtime_leases set expires_at = now() - interval '1 second' where id = $1`,
      [first.lease!.id],
    );
    const refused = await acquireExecutionLease(
      testDatabase.pool,
      repository.id,
      { taskId: waiting.taskId },
      60_000,
    );
    expect(refused.lease).toBeNull();
    expect(refused.refused).toBe('stop_proof_required');
    expect(refused.waitingFor).toBe('execution_stop_proof');

    // The same running ticket is adopted under its original generation: no
    // second execution is started and no stop is fabricated.
    await reconcileLeases(testDatabase.pool, repository, bridgeWith({ state: 'running' }), logger);
    const adopted = await testDatabase.pool.query<{ holder_id: string; state: string }>(
      `select holder_id, state from runtime_leases where id = $1`,
      [first.lease!.id],
    );
    expect(adopted.rows[0]).toMatchObject({ state: 'active' });
    expect(adopted.rows[0]?.holder_id).toMatch(/^dispatcher:/);

    // Still no replacement while the adopted execution runs.
    const stillHeld = await acquireExecutionLease(
      testDatabase.pool,
      repository.id,
      { taskId: waiting.taskId },
      60_000,
    );
    expect(stillHeld.refused).toBe('held');

    // Once the runtime proves the worker stopped (pause evidence), the old
    // generation is recovered and a newer token may be issued.
    await testDatabase.pool.query(
      `update runtime_leases set expires_at = now() - interval '1 second' where id = $1`,
      [first.lease!.id],
    );
    await reconcileLeases(
      testDatabase.pool,
      repository,
      bridgeWith({
        state: 'stopped',
        paused: {
          at: new Date().toISOString(),
          by: 'human',
          operationId: 'recovery-1',
          stoppedAt: new Date().toISOString(),
          evidence: {
            stoppedAt: new Date().toISOString(),
            agentStatus: 'idle',
            jobsAfter: [],
            subagentsAfter: 0,
          },
        },
      }),
      logger,
    );
    const recovered = await testDatabase.pool.query<{ state: string; recovery_state: string }>(
      `select state, recovery_state from runtime_leases where id = $1`,
      [first.lease!.id],
    );
    expect(recovered.rows[0]).toMatchObject({ state: 'expired', recovery_state: 'recovered' });

    const next = await acquireExecutionLease(
      testDatabase.pool,
      repository.id,
      { taskId: waiting.taskId },
      60_000,
    );
    expect(next.lease).not.toBeNull();
    expect(Number(next.lease!.fencingToken)).toBeGreaterThan(Number(firstToken));

    // The old generation no longer owns the task and its late receipt is refused.
    const stale = await receiptIsCurrent(testDatabase.pool, {
      repositoryId: repository.id,
      leaseId: first.lease!.id,
      fencingToken: firstToken,
      taskId: running.taskId,
      kind: 'resume',
    });
    expect(stale.current).toBe(false);
    const events = await testDatabase.pool.query<{ count: number }>(
      `select count(*)::int as count from runtime_lease_events
        where lease_id = $1 and type = 'stale_receipt_rejected'`,
      [first.lease!.id],
    );
    expect(events.rows[0]?.count).toBeGreaterThan(0);
  }, 30_000);

  it('releases the slot when the runtime reports no active worker', async () => {
    const task = await seedTask('awaiting_review');
    const account = await acquireExecutionLease(
      testDatabase.pool,
      repository.id,
      { taskId: task.taskId },
      60_000,
    );
    expect(account.lease).not.toBeNull();
    await testDatabase.pool.query(
      `update runtime_leases set expires_at = now() - interval '1 second' where id = $1`,
      [account.lease!.id],
    );
    await reconcileLeases(
      testDatabase.pool,
      repository,
      bridgeWith({ state: 'awaiting_review' }),
      logger,
    );
    const lease = await testDatabase.pool.query<{ state: string; recovery_state: string }>(
      `select state, recovery_state from runtime_leases where id = $1`,
      [account.lease!.id],
    );
    expect(lease.rows[0]).toMatchObject({ state: 'expired', recovery_state: 'recovered' });
    const taskRow = await testDatabase.pool.query<{ runtime_lease_id: string | null }>(
      `select runtime_lease_id from task_links where id = $1`,
      [task.taskId],
    );
    expect(taskRow.rows[0]?.runtime_lease_id).toBeNull();
  }, 30_000);
});
