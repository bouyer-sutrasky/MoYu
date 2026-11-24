import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATION_LEDGER_LOCK_KEY, migrateDatabase } from '../../src/migrate';
import { createTestDatabase, createTestDatabaseUpTo, type TestDatabase } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FOREIGN_KEYS = [
  'execution_reservations_delivery_fk',
  'execution_reservations_repository_fk',
  'execution_reservations_task_fk',
];

let hash = '';
let downSql = '';
const laterDownSql: string[] = [];
const databases: TestDatabase[] = [];

interface Snapshot {
  table: string | null;
  foreignKeys: string[];
  ledgerTotal: number;
  ledgerMatching: number;
}

const snapshot = async (database: TestDatabase): Promise<Snapshot> => {
  const table = await database.pool.query<{ name: string | null }>(
    "select to_regclass('public.execution_reservations')::text as name",
  );
  const foreignKeys = await database.pool.query<{ name: string }>(
    `select conname || '|' || pg_get_constraintdef(oid) as name
       from pg_constraint
      where connamespace = 'public'::regnamespace
        and conname = any($1::text[])
      order by conname`,
    [FOREIGN_KEYS],
  );
  const ledger = await database.pool.query<{ total: number; matching: number }>(
    `select count(*)::int as total,
            count(*) filter (where hash = $1)::int as matching
       from drizzle.__drizzle_migrations`,
    [hash],
  );
  return {
    table: table.rows[0]?.name ?? null,
    foreignKeys: foreignKeys.rows.map((row) => row.name),
    ledgerTotal: ledger.rows[0]?.total ?? -1,
    ledgerMatching: ledger.rows[0]?.matching ?? -1,
  };
};

/**
 * Runs the plain-SQL rollback on one connection. A refused script leaves its
 * explicit transaction open on that connection, so roll it back before the
 * client returns to the pool; a successful script has already committed.
 */
const runDown = async (database: TestDatabase): Promise<void> => {
  const client = await database.pool.connect();
  try {
    await client.query(downSql);
  } finally {
    try {
      await client.query('rollback');
    } catch {
      // The script already committed.
    }
    client.release();
  }
};

const waitForAdvisoryWaiter = async (
  database: TestDatabase,
  timeoutMs = 2_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await database.pool.query<{ count: number }>(
      `select count(*)::int as count
         from pg_locks
        where locktype = 'advisory'
          and not granted
          and database = (select oid from pg_database where datname = current_database())`,
    );
    if ((waiting.rows[0]?.count ?? 0) > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const rollBackThrough0014 = async (database: TestDatabase): Promise<void> => {
  for (const sql of laterDownSql) {
    await database.pool.query(sql);
  }
  await runDown(database);
};

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('0014 rollback script on real PostgreSQL', () => {
  beforeAll(async () => {
    hash = createHash('sha256')
      .update(
        await readFile(path.join(ROOT, 'packages/db/migrations/0014_execution_reservations.sql')),
      )
      .digest('hex');
    downSql = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0014_execution_reservations.down.sql'),
      'utf8',
    );
    for (const tag of [
      '0024_deletion_operation_id',
      '0023_fuzzy_pet_avengers',
      '0022_youthful_loki',
      '0021_task_decision_routing',
      '0020_worthless_carmella_unuscione',
      '0019_event_dedupe_per_repository',
      '0018_zippy_warhawk',
      '0017_workable_cardiac',
      '0016_attachment_revoke',
      '0015_late_gateway',
    ]) {
      laterDownSql.push(
        await readFile(path.join(ROOT, `packages/db/migrations/rollback/${tag}.down.sql`), 'utf8'),
      );
    }
  });

  it('pins the current forward migration hash', () => {
    expect(downSql).toContain(`'${hash}'`);
  });

  it('refuses to roll back underneath later applied migrations', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const before = await snapshot(database);

    await expect(runDown(database)).rejects.toThrow(/later migration\(s\) are already applied/);
    expect(await snapshot(database)).toEqual(before);
    expect(before).toMatchObject({ table: 'execution_reservations', ledgerMatching: 1 });
  }, 30_000);

  it('refuses a ledger row without created_at instead of guessing its order', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    // Drizzle's ledger allows created_at to be NULL, and PostgreSQL sorts NULL
    // first under ORDER BY created_at DESC, so the migrator would see this row
    // as the latest one. The guard must refuse instead of counting only
    // non-NULL timestamps.
    await database.pool.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ('null-created-at-fixture', null)",
    );
    const before = await snapshot(database);
    expect(before).toMatchObject({ table: 'execution_reservations', ledgerMatching: 1 });

    await expect(runDown(database)).rejects.toThrow(/ledger row\(s\) have no created_at/);
    expect(await snapshot(database)).toEqual(before);
  }, 30_000);

  it('refuses when the applied 0014 ledger row has no created_at', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query(
      'update drizzle.__drizzle_migrations set created_at = null where hash = $1',
      [hash],
    );
    const before = await snapshot(database);
    expect(before).toMatchObject({ table: 'execution_reservations', ledgerMatching: 1 });

    await expect(runDown(database)).rejects.toThrow(/ledger row\(s\) have no created_at/);
    expect(await snapshot(database)).toEqual(before);
  }, 30_000);

  it('refuses a drifted 0014 ledger hash without dropping the table', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query(
      "update drizzle.__drizzle_migrations set hash = repeat('0', 64) where hash = $1",
      [hash],
    );
    const drifted = await snapshot(database);

    await expect(runDown(database)).rejects.toThrow(
      /expected exactly one applied 0014 migration matching the pinned hash, found 0/,
    );
    expect(await snapshot(database)).toEqual(drifted);
    expect(drifted).toMatchObject({ table: 'execution_reservations', ledgerMatching: 0 });
  }, 30_000);

  it('refuses a missing 0014 ledger row without dropping the table', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query('delete from drizzle.__drizzle_migrations where hash = $1', [hash]);
    const missing = await snapshot(database);

    await expect(runDown(database)).rejects.toThrow(
      /expected exactly one applied 0014 migration matching the pinned hash, found 0/,
    );
    expect(await snapshot(database)).toEqual(missing);
    expect(missing).toMatchObject({ table: 'execution_reservations', ledgerMatching: 0 });
  }, 30_000);

  it('refuses a duplicated 0014 ledger row without dropping the table', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query(
      'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, 1)',
      [hash],
    );
    const duplicated = await snapshot(database);
    expect(duplicated.ledgerMatching).toBe(2);

    await expect(runDown(database)).rejects.toThrow(
      /expected exactly one applied 0014 migration matching the pinned hash, found 2/,
    );
    expect(await snapshot(database)).toEqual(duplicated);
  }, 30_000);

  it('refuses when 0014 is not applied at all', async () => {
    const database = await createTestDatabaseUpTo(13);
    databases.push(database);
    const before = await snapshot(database);

    await expect(runDown(database)).rejects.toThrow(
      /expected exactly one applied 0014 migration matching the pinned hash, found 0/,
    );
    expect(await snapshot(database)).toEqual(before);
    expect(before).toMatchObject({ table: null, ledgerMatching: 0 });
  }, 30_000);

  it('rolls the whole transaction back when a later statement fails', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    // Make 0014 the latest migration so the guard passes and the DDL really
    // runs; the injected delete failure must then undo the dropped table.
    for (const sql of laterDownSql) {
      await database.pool.query(sql);
    }
    const before = await snapshot(database);
    await database.pool.query(`
      create function moyu_refuse_0014_ledger_delete() returns trigger as $$
      begin
        raise exception 'injected 0014 ledger delete failure';
      end $$ language plpgsql;
      create trigger moyu_refuse_0014_ledger_delete
        before delete on drizzle.__drizzle_migrations
        for each row execute function moyu_refuse_0014_ledger_delete();
    `);

    await expect(runDown(database)).rejects.toThrow(/injected 0014 ledger delete failure/);
    expect(await snapshot(database)).toEqual(before);
  }, 30_000);

  it('rolls back legally, refuses a second rollback and re-applies cleanly', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const applied = await snapshot(database);
    const rolledBackCount = laterDownSql.length + 1;

    await rollBackThrough0014(database);
    expect(await snapshot(database)).toEqual({
      table: null,
      foreignKeys: [],
      ledgerTotal: applied.ledgerTotal - rolledBackCount,
      ledgerMatching: 0,
    });

    await expect(runDown(database)).rejects.toThrow(
      /expected exactly one applied 0014 migration matching the pinned hash, found 0/,
    );
    expect(await snapshot(database)).toEqual({
      table: null,
      foreignKeys: [],
      ledgerTotal: applied.ledgerTotal - rolledBackCount,
      ledgerMatching: 0,
    });

    await migrateDatabase(database.db);
    expect(await snapshot(database)).toEqual(applied);
  }, 30_000);

  it('waits for the migration ledger lock before refusing', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select pg_advisory_xact_lock($1)', [MIGRATION_LEDGER_LOCK_KEY]);

      const refused = runDown(database);
      expect(await waitForAdvisoryWaiter(database)).toBe(true);
      await blocker.query('commit');
      await expect(refused).rejects.toThrow(/later migration\(s\) are already applied/);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
  }, 30_000);

  it('makes migrateDatabase wait for the same ledger lock', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const before = await snapshot(database);
    const blocker = await database.pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query('select pg_advisory_xact_lock($1)', [MIGRATION_LEDGER_LOCK_KEY]);

      const migrated = migrateDatabase(database.db);
      expect(await waitForAdvisoryWaiter(database)).toBe(true);
      await blocker.query('commit');
      await expect(migrated).resolves.toBeUndefined();
      expect(await snapshot(database)).toEqual(before);
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
    }
  }, 30_000);
});
