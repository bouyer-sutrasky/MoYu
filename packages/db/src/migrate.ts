import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Database } from './client';

/**
 * Resolves the committed migration folder from this module. It works both from
 * src (tsx/vitest) and from dist (a built package lives next to migrations/).
 */
export const defaultMigrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Advisory-lock key serialising every read-check-write sequence on
 * drizzle.__drizzle_migrations. Rollback scripts take the same transaction-
 * scoped key (see 0014_execution_reservations.down.sql) so a rollback cannot
 * delete a migration while a migrator has already read it as applied.
 * 918273646 is already the platform-events lock, so this is the next key.
 */
export const MIGRATION_LEDGER_LOCK_KEY = 918273647;

export async function migrateDatabase(
  database: Database,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  // Drizzle reads the latest ledger row before it opens its transaction, so the
  // lock has to cover that read as well as the apply step. Taking the lock on
  // the same connection the migrator then uses keeps both under one session.
  const client = await database.$client.connect();
  let unlockError: Error | undefined;
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LEDGER_LOCK_KEY]);
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LEDGER_LOCK_KEY]);
    } catch (error) {
      unlockError = error instanceof Error ? error : new Error(String(error));
    }
    // Destroy the connection if it could not release the session-level lock, so
    // it cannot leak back into the pool.
    client.release(unlockError);
  }
  if (unlockError !== undefined) {
    throw unlockError;
  }
}
