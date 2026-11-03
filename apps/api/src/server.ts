import { createDatabase, createPool } from '@moyu/db';

import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const pool = config.databaseUrl ? createPool(config.databaseUrl) : undefined;
const database = pool ? createDatabase(pool) : undefined;
const app = buildApp({ config, database });

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ event: 'server.shutdown', signal }, 'shutting down MoYu API');
  await app.close();
  await pool?.end();
  process.exit(0);
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

try {
  const address = await app.listen({ host: config.apiHost, port: config.apiPort });
  app.log.info(
    { event: 'server.listening', address, nodeEnv: config.nodeEnv },
    'MoYu API listening',
  );
} catch (error) {
  app.log.error({ err: error, event: 'server.listen_failed' }, 'MoYu API failed to start');
  await app.close();
  await pool?.end();
  process.exitCode = 1;
}
