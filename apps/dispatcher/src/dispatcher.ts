import { setTimeout as delay } from 'node:timers/promises';

import type pg from 'pg';

import { createPool } from '@moyu/db';
import type { RuntimeBridgeClient } from '@moyu/runtime-client';

import type { DispatcherConfig } from './config';
import { deliverOnce } from './delivery';
import { createConsoleLogger, type DispatcherLogger } from './logger';
import { bridgeClient, resolveRepository, type RepositoryBinding } from './runtime';
import { syncOnce } from './sync';

export interface RunDispatcherOptions {
  signal: AbortSignal;
  logger?: DispatcherLogger;
}

/**
 * Resolves the repository binding once the platform has created it (the API may
 * start first), then waits for shutdown. A missing binding is a normal startup
 * state, not a crash: the first boot happens before Passkey registration.
 */
async function waitForRepository(
  pool: pg.Pool,
  config: DispatcherConfig,
  signal: AbortSignal,
  logger: DispatcherLogger,
): Promise<RepositoryBinding | null> {
  while (!signal.aborted) {
    const repository = await resolveRepository(pool, config);
    if (repository) {
      return repository;
    }
    logger.info(
      {
        event: 'dispatcher.repository_waiting',
        repository: config.bridgeRepository ?? '(first bound)',
      },
      'waiting for the API to bind a repository runtime',
    );
    await delay(2000, undefined, { signal }).catch(() => undefined);
  }
  return null;
}

async function runLoop(
  name: string,
  intervalMs: number,
  signal: AbortSignal,
  logger: DispatcherLogger,
  work: () => Promise<boolean>,
): Promise<void> {
  while (!signal.aborted) {
    let busy = false;
    try {
      busy = await work();
    } catch (error) {
      logger.error(
        {
          event: `dispatcher.${name}_error`,
          error: error instanceof Error ? error.message : String(error),
        },
        `${name} loop failed; retrying`,
      );
    }
    if (!busy) {
      await delay(intervalMs, undefined, { signal }).catch(() => undefined);
    }
  }
}

/**
 * M3 dispatcher: durable message delivery to the repository Bridge and Bridge
 * event catch-up. Both loops are idempotent; restarting the process resumes from
 * database leases and the persisted Bridge cursor.
 */
export async function runDispatcher(
  config: DispatcherConfig,
  options: RunDispatcherOptions,
): Promise<void> {
  const logger = options.logger ?? createConsoleLogger('moyu-dispatcher');
  const pool = createPool(config.databaseUrl, { max: 4 });

  try {
    await pool.query('select 1');
    logger.info(
      { event: 'dispatcher.ready', nodeEnv: config.nodeEnv },
      'dispatcher connected to PostgreSQL',
    );

    const repository = await waitForRepository(pool, config, options.signal, logger);
    if (!repository) {
      logger.info({ event: 'dispatcher.stopped' }, 'dispatcher stopped');
      return;
    }
    let bridge: RuntimeBridgeClient;
    try {
      bridge = bridgeClient(config, repository);
    } catch (error) {
      logger.error(
        {
          event: 'dispatcher.bridge_unconfigured',
          repository: repository.fullName,
          error: error instanceof Error ? error.message : String(error),
        },
        'the dispatcher has no Bridge token; refusing to pretend delivery works',
      );
      throw error;
    }

    logger.info(
      { event: 'dispatcher.repository', repository: repository.fullName },
      'dispatching for repository runtime',
    );

    await Promise.allSettled([
      runLoop('delivery', config.deliveryIntervalMs, options.signal, logger, () =>
        deliverOnce(pool, config, repository, bridge, logger),
      ),
      runLoop('event_sync', config.eventSyncIntervalMs, options.signal, logger, () =>
        syncOnce(pool, repository, bridge, logger),
      ),
    ]);
    logger.info({ event: 'dispatcher.stopped' }, 'dispatcher stopped');
  } finally {
    await pool.end();
  }
}
