import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import type { DispatcherLogger } from './logger';
import type { DispatcherConfig } from './config';
import type { RepositoryBinding } from './runtime';
import { bridgeErrorMessage } from './runtime';
import type { RuntimeBridgeClient } from '@moyu/runtime-client';

interface DuplicateRow {
  id: string;
  ticket_id: string;
  task_id: string;
  state: 'pending' | 'pausing' | 'paused' | 'failed' | 'skipped';
  attempts: number;
  operation_id: string | null;
  last_error: string | null;
}

const RETRY_CAP_MS = 5 * 60_000;

/**
 * One durable duplicate-Ticket pass: settle a pause already in flight, then send
 * at most one pause. The row is written in the import transaction, so a failed
 * network call or a process exit is retried after a restart instead of being
 * only a log line. The platform task remains the sole execution.
 */
export async function duplicatesOnce(
  pool: pg.Pool,
  config: DispatcherConfig,
  repository: RepositoryBinding,
  bridge: RuntimeBridgeClient,
  logger: DispatcherLogger,
): Promise<boolean> {
  // A process that died while pausing leaves a row in `pausing`; recover it after
  // a short grace rather than waiting forever for the old operation.
  await pool.query(
    `update duplicate_tickets
        set state = 'pending', updated_at = now()
      where repository_id = $1 and state = 'pausing'
        and updated_at < now() - interval '90 seconds'`,
    [repository.id],
  );

  const inFlight = await pool.query<DuplicateRow>(
    `select id, ticket_id, task_id, state, attempts, operation_id, last_error
       from duplicate_tickets
      where repository_id = $1 and state = 'pausing' and operation_id is not null
      order by updated_at limit 1`,
    [repository.id],
  );
  const current = inFlight.rows[0];
  if (current) {
    try {
      const operation = await bridge.operation(current.operation_id!);
      if (operation.state === 'succeeded') {
        await finish(pool, current.id, 'paused', null);
        logger.info(
          { event: 'duplicate.paused', ticketId: current.ticket_id },
          'duplicate runtime ticket paused',
        );
        return true;
      }
      if (operation.state === 'failed') {
        await retryLater(pool, current, bridgeErrorMessage(operation.error));
        return true;
      }
      await pool.query(
        `update duplicate_tickets set next_attempt_at = now() + interval '1 second', updated_at = now() where id = $1`,
        [current.id],
      );
      return true;
    } catch (error) {
      await retryLater(pool, current, bridgeErrorMessage(error));
      return true;
    }
  }

  const claimed = await pool.query<DuplicateRow>(
    `update duplicate_tickets
        set state = 'pausing', attempts = attempts + 1, operation_id = $2, updated_at = now()
      where id = (
        select id from duplicate_tickets
         where repository_id = $1 and state in ('pending', 'failed') and next_attempt_at <= now()
         order by next_attempt_at limit 1 for update skip locked
      )
      returning id, ticket_id, task_id, state, attempts, operation_id, last_error`,
    [repository.id, randomUUID()],
  );
  const row = claimed.rows[0];
  if (!row) {
    return false;
  }
  try {
    const accepted = await bridge.pause(row.ticket_id, {
      operationId: row.operation_id!,
      reason: 'Duplicate GitHub requirement; the existing task continues',
    });
    const operation = await bridge.operation(accepted.operationId);
    if (operation.state === 'succeeded') {
      await finish(pool, row.id, 'paused', null);
      logger.info(
        { event: 'duplicate.paused', ticketId: row.ticket_id },
        'duplicate runtime ticket paused',
      );
    } else if (operation.state === 'failed') {
      await retryLater(pool, row, bridgeErrorMessage(operation.error));
    } else {
      await pool.query(
        `update duplicate_tickets set next_attempt_at = now() + interval '1 second', updated_at = now() where id = $1`,
        [row.id],
      );
    }
  } catch (error) {
    const code =
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : '';
    if (code === 'notPaused' || code === 'ticketEnded') {
      await finish(pool, row.id, 'skipped', null);
      logger.info(
        { event: 'duplicate.already_stopped', ticketId: row.ticket_id },
        'duplicate runtime ticket is already stopped or ended',
      );
      return true;
    }
    await retryLater(pool, row, bridgeErrorMessage(error));
  }
  return true;
}

async function finish(
  pool: pg.Pool,
  id: string,
  state: string,
  error: string | null,
): Promise<void> {
  await pool.query(
    `update duplicate_tickets set state = $2, operation_id = null, last_error = $3, updated_at = now() where id = $1`,
    [id, state, error],
  );
}

async function retryLater(pool: pg.Pool, row: DuplicateRow, error: string | null): Promise<void> {
  const delay = Math.min(RETRY_CAP_MS, 1000 * 2 ** Math.max(0, row.attempts - 1));
  await pool.query(
    `update duplicate_tickets
        set state = 'failed', operation_id = null, last_error = $2,
            next_attempt_at = now() + ($3::int * interval '1 millisecond'), updated_at = now()
      where id = $1`,
    [row.id, error?.slice(0, 1000) ?? null, delay],
  );
}
