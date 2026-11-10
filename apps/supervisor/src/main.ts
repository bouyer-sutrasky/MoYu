import { createPool } from '@moyu/db';

import { loadSupervisorConfig } from './config';
import { createConsoleLogger } from './logger';
import { InstanceManager } from './manager';
import { buildSupervisorServer } from './server';
import { SupervisorStore } from './store';

const config = loadSupervisorConfig();
const logger = createConsoleLogger('moyu-supervisor', config.logLevel);
const pool = createPool(config.databaseUrl, { max: 4 });
const store = new SupervisorStore(pool);
const manager = new InstanceManager(config, store, logger);
const app = buildSupervisorServer({ config, manager, store, logger });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info({ event: 'supervisor.shutdown', signal }, 'supervisor shutting down');
  await manager.stop();
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exitCode = 0;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await pool.query('select 1');
  await manager.start();
  await app.listen({ host: config.host, port: config.port });
  logger.info(
    {
      event: 'supervisor.ready',
      host: config.host,
      port: config.port,
      maxOnline: config.maxOnline,
    },
    'supervisor is listening',
  );
} catch (error) {
  logger.error(
    { event: 'supervisor.failed', error: error instanceof Error ? error.message : String(error) },
    'supervisor failed to start',
  );
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
}
