import { createDatabase, createPool } from '../client';
import { migrateDatabase } from '../migrate';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'moyu-db',
      event: 'migrate.config_error',
      message: 'DATABASE_URL is required',
    }),
  );
  process.exitCode = 1;
} else {
  const pool = createPool(databaseUrl, { max: 1 });

  try {
    const database = createDatabase(pool);
    await migrateDatabase(database);
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'moyu-db',
        event: 'migrate.completed',
        message: 'Database migrations applied successfully',
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'moyu-db',
        event: 'migrate.failed',
        message: error instanceof Error ? error.message : 'unknown migration error',
      }),
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
