import { sql } from 'drizzle-orm';

import type { Database } from '@moyu/db';

/**
 * Transaction-scoped advisory lock serialising owner auth-state transitions.
 * The lock is held until the surrounding transaction commits or rolls back, so
 * it serialises credential registration and revocation across every API process
 * that shares the database. MoYu has a single owner, so one key covers it.
 */
export const AUTH_STATE_LOCK_KEY = 918_273_645;

export async function lockAuthState(executor: Pick<Database, 'execute'>): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(${AUTH_STATE_LOCK_KEY}::bigint)`);
}
