import { loadDispatcherConfig } from './config';
import { runDispatcher } from './dispatcher';
import { createConsoleLogger } from './logger';

const logger = createConsoleLogger('moyu-dispatcher');
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ event: 'dispatcher.signal', signal }, 'shutdown requested');
    controller.abort();
  });
}

try {
  await runDispatcher(loadDispatcherConfig(), { signal: controller.signal, logger });
} catch (error) {
  logger.error(
    {
      event: 'dispatcher.failed',
      message: error instanceof Error ? error.message : 'unknown dispatcher error',
    },
    'dispatcher stopped with an error',
  );
  process.exitCode = 1;
}
