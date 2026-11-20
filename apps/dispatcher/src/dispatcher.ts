import { setTimeout as delay } from 'node:timers/promises';

import type pg from 'pg';

import { createPool } from '@moyu/db';
import { RuntimeBridgeError, type RuntimeBridgeClient } from '@moyu/runtime-client';

import type { DispatcherConfig } from './config';
import { admitImportedOnce } from './admissions';
import { deliverOnce } from './delivery';
import { createConsoleLogger, type DispatcherLogger } from './logger';
import { maintainLeases, operationsOnce, reconcileTasks } from './operations';
import { captureReportsOnce } from './reports';
import { duplicatesOnce } from './duplicates';
import { bridgeClient, listActiveRepositories, type RepositoryBinding } from './runtime';
import { recoverIgnoredLeases, syncOnce } from './sync';
import { handoffRoutedOnce } from './routing';

export interface RunDispatcherOptions {
  signal: AbortSignal;
  logger?: DispatcherLogger;
}

/**
 * Consecutive failures after which a loop's failure is a real error rather than a
 * transient one. A supervisor restart makes every Bridge call fail for a few
 * seconds, and reporting that at error level once per second buries real errors.
 */
const TRANSIENT_FAILURES = 3;

/**
 * A retryable Bridge error (unreachable runtime, 5xx, timeout) is a transient
 * outage. Contract violations, SQL errors and non-retryable 4xx responses are
 * not: retrying cannot fix them, so they must stay at error level even on the
 * first failure instead of being reported as a passing hiccup.
 */
function isTransientLoopError(error: unknown): boolean {
  return error instanceof RuntimeBridgeError && error.retryable;
}

/** @internal Exported so the loop's level/backoff decisions have a direct test. */
export async function runLoop(
  name: string,
  intervalMs: number,
  signal: AbortSignal,
  logger: DispatcherLogger,
  work: () => Promise<boolean>,
): Promise<void> {
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    let busy = false;
    try {
      busy = await work();
      if (consecutiveFailures > 0) {
        logger.info(
          {
            event: `dispatcher.${name}_recovered`,
            consecutiveFailures,
          },
          `${name} loop recovered`,
        );
        consecutiveFailures = 0;
      }
    } catch (error) {
      const transient = isTransientLoopError(error);
      const detail = {
        event: `dispatcher.${name}_error`,
        consecutiveFailures: transient ? consecutiveFailures + 1 : 0,
        transient,
        ...(error instanceof RuntimeBridgeError ? { code: error.code, status: error.status } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
      if (!transient) {
        // Do not let a contract/SQL failure accumulate into the transient
        // counter: the next short Bridge outage must start again at warning 1.
        consecutiveFailures = 0;
        logger.error(detail, `${name} loop failed with a non-transient error; retrying`);
      } else {
        consecutiveFailures += 1;
        detail.consecutiveFailures = consecutiveFailures;
        // A bridge that is briefly unreachable while an instance restarts is a
        // warning; only a failure that persists past the transient window is an
        // error the operator has to act on.
        if (consecutiveFailures < TRANSIENT_FAILURES) {
          logger.warn(detail, `${name} loop failed; retrying`);
        } else {
          logger.error(detail, `${name} loop failed ${consecutiveFailures} times; retrying`);
        }
      }
    }
    if (!busy) {
      await delay(intervalMs, undefined, { signal }).catch(() => undefined);
    }
  }
}

/**
 * One independent loop set per online repository. Each has its own Bridge
 * client, credential and scoped cursor; a stopped repository's loops are
 * aborted, so its messages can never be delivered to another runtime.
 */
async function runRepositoryWorker(
  pool: pg.Pool,
  config: DispatcherConfig,
  repository: RepositoryBinding,
  signal: AbortSignal,
  logger: DispatcherLogger,
): Promise<void> {
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
      'refusing to dispatch a repository without its own verified Bridge credentials',
    );
    return;
  }

  await recoverIgnoredLeases(pool, repository.id, logger).catch((error) => {
    logger.warn(
      {
        event: 'dispatcher.ignored_lease_recovery_failed',
        repository: repository.fullName,
        error: error instanceof Error ? error.message : String(error),
      },
      'could not release an ignored admission lease; the execution slot may stay occupied',
    );
  });
  let admissionSupported = false;
  let attachmentsSupported = false;
  let pauseRecheckSupported = false;
  try {
    const capabilities = await bridge.capabilities();
    admissionSupported = capabilities.capabilities.admission === true;
    // A failed stop can only be checked again by a runtime that declares it; without this the platform keeps the blocked
    // placeholder and explains that the runtime needs upgrading, instead of sending a request the old strict schema refuses.
    pauseRecheckSupported = capabilities.capabilities.pauseRecheck === true;
    // L113: absent means unsupported. An old Bridge's strict trigger schema
    // rejects unknown keys with a non-retryable 400, so this stays false until
    // the runtime explicitly declares the capability.
    attachmentsSupported = capabilities.capabilities.attachments === true;
  } catch (error) {
    logger.warn(
      {
        event: 'dispatcher.capabilities_unavailable',
        repository: repository.fullName,
        error: error instanceof Error ? error.message : String(error),
      },
      'runtime capabilities are unknown; execution admission stays on the platform control plane',
    );
  }
  logger.info(
    {
      event: 'dispatcher.repository',
      repository: repository.fullName,
      admissionSupported,
      attachmentsSupported,
      pauseRecheckSupported,
    },
    'dispatching for repository runtime',
  );

  if (config.reconcileOnStart) {
    try {
      await reconcileTasks(pool, repository, bridge, logger);
    } catch (error) {
      logger.error(
        {
          event: 'dispatcher.reconcile_error',
          repository: repository.fullName,
          error: error instanceof Error ? error.message : String(error),
        },
        'startup reconciliation failed; loops continue with the stored state',
      );
    }
  }

  await Promise.allSettled([
    runLoop('delivery', config.deliveryIntervalMs, signal, logger, () =>
      deliverOnce(
        pool,
        config,
        repository,
        bridge,
        logger,
        admissionSupported,
        attachmentsSupported,
      ),
    ),
    runLoop('event_sync', config.eventSyncIntervalMs, signal, logger, () =>
      syncOnce(pool, repository, bridge, logger),
    ),
    runLoop('operations', config.operationIntervalMs, signal, logger, () =>
      operationsOnce(
        pool,
        config,
        repository,
        bridge,
        logger,
        admissionSupported,
        pauseRecheckSupported,
      ),
    ),
    runLoop('leases', 5000, signal, logger, async () => {
      await maintainLeases(pool, config, repository, bridge, logger);
      return false;
    }),
    runLoop('admissions', 2000, signal, logger, () =>
      admitImportedOnce(pool, config, repository, bridge, admissionSupported, logger),
    ),
    runLoop('routing', 1000, signal, logger, () =>
      handoffRoutedOnce(pool, config, repository, bridge, admissionSupported, logger),
    ),
    runLoop('reports', config.reportCaptureIntervalMs, signal, logger, () =>
      captureReportsOnce(pool, repository, bridge, logger),
    ),
    runLoop('duplicates', config.duplicateIntervalMs, signal, logger, () =>
      duplicatesOnce(pool, config, repository, bridge, logger),
    ),
  ]);
}

interface WorkerHandle {
  key: string;
  controller: AbortController;
  task: Promise<void>;
}

function bindingKey(repository: RepositoryBinding): string {
  return `${repository.bridgeUrl ?? ''}|${repository.bridgeCredentialRef ?? ''}`;
}

/**
 * M5 dispatcher: discovers online repository instances from the supervisor
 * projection and runs an independent loop set for each. Restarting the
 * dispatcher resumes every repository from its own persisted Bridge cursor.
 */
export async function runDispatcher(
  config: DispatcherConfig,
  options: RunDispatcherOptions,
): Promise<void> {
  const logger = options.logger ?? createConsoleLogger('moyu-dispatcher');
  const pool = createPool(config.databaseUrl, { max: 8 });
  const workers = new Map<string, WorkerHandle>();

  try {
    await pool.query('select 1');
    logger.info(
      { event: 'dispatcher.ready', nodeEnv: config.nodeEnv },
      'dispatcher connected to PostgreSQL',
    );

    const stopWorkers = async () => {
      for (const worker of workers.values()) worker.controller.abort();
      await Promise.allSettled([...workers.values()].map((worker) => worker.task));
      workers.clear();
    };

    while (!options.signal.aborted) {
      try {
        const repositories = await listActiveRepositories(pool, config);
        const seen = new Set(repositories.map((repository) => repository.id));
        for (const [id, worker] of workers) {
          if (!seen.has(id)) {
            logger.info(
              { event: 'dispatcher.repository_offline', repositoryId: id },
              'repository runtime is no longer online; stopping its loops',
            );
            worker.controller.abort();
            workers.delete(id);
          }
        }
        for (const repository of repositories) {
          const existing = workers.get(repository.id);
          if (existing && existing.key === bindingKey(repository)) continue;
          if (existing) {
            existing.controller.abort();
            workers.delete(repository.id);
          }
          const controller = new AbortController();
          const task = runRepositoryWorker(
            pool,
            config,
            repository,
            controller.signal,
            logger,
          ).catch((error) => {
            logger.error(
              {
                event: 'dispatcher.worker_failed',
                repository: repository.fullName,
                error: error instanceof Error ? error.message : String(error),
              },
              'repository dispatcher worker stopped unexpectedly',
            );
          });
          workers.set(repository.id, {
            key: bindingKey(repository),
            controller,
            task,
          });
        }
      } catch (error) {
        logger.error(
          {
            event: 'dispatcher.discovery_error',
            error: error instanceof Error ? error.message : String(error),
          },
          'could not read online repository instances; retrying',
        );
      }
      await delay(2000, undefined, { signal: options.signal }).catch(() => undefined);
    }

    await stopWorkers();
    logger.info({ event: 'dispatcher.stopped' }, 'dispatcher stopped');
  } finally {
    await pool.end();
  }
}
