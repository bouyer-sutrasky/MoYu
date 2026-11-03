import { createPool } from '@moyu/db';

import type { DispatcherConfig } from './config';
import { createConsoleLogger, type DispatcherLogger } from './logger';

export interface RunDispatcherOptions {
  signal: AbortSignal;
  logger?: DispatcherLogger;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * M1 dispatcher skeleton: prove database connectivity and structured startup,
 * then idle until shutdown. Message delivery, lease sweeping and runtime
 * admission are deliberately not implemented before their acceptance stage; the
 * process must not pretend to deliver work it cannot deliver.
 */
export async function runDispatcher(
  config: DispatcherConfig,
  options: RunDispatcherOptions,
): Promise<void> {
  const logger = options.logger ?? createConsoleLogger('moyu-dispatcher');
  const pool = createPool(config.databaseUrl, { max: 2 });

  try {
    await pool.query('select 1');
    logger.info(
      {
        event: 'dispatcher.ready',
        nodeEnv: config.nodeEnv,
        deliveryLoop: 'not-implemented-until-m3',
      },
      'dispatcher connected to PostgreSQL; delivery loop is not part of M1',
    );
    await waitForAbort(options.signal);
    logger.info({ event: 'dispatcher.stopped' }, 'dispatcher stopped');
  } finally {
    await pool.end();
  }
}
