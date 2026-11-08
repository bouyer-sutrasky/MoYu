import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/migrate';
import { createTestDatabase, createTestDatabaseUpTo, type TestDatabase } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FORWARD = path.join(ROOT, 'packages/db/migrations/0014_execution_reservations.sql');
const PREVIOUS = path.join(ROOT, 'packages/db/migrations/0013_loving_quentin_quire.sql');
const ROLLBACK = path.join(
  ROOT,
  'packages/db/migrations/rollback/0014_execution_reservations.down.sql',
);
const FOREIGN_KEYS = [
  'execution_reservations_repository_fk',
  'execution_reservations_task_fk',
  'execution_reservations_delivery_fk',
];
let hash = '';
let previousHash = '';
const databases: TestDatabase[] = [];

const runRollback = (database: TestDatabase, supplied?: string) =>
  spawnSync(
    'psql',
    [
      database.url,
      '-v',
      'ON_ERROR_STOP=1',
      ...(supplied ? ['-v', `hash=${supplied}`] : []),
      '-f',
      ROLLBACK,
    ],
    { encoding: 'utf8' },
  );

const read = async (database: TestDatabase) => {
  const table = await database.pool.query<{ present: boolean }>(
    `select to_regclass('public.execution_reservations') is not null as present`,
  );
  const constraints = await database.pool.query<{ count: number }>(
    `select count(*)::int as count from pg_constraint where conname = any($1::text[])`,
    [FOREIGN_KEYS],
  );
  const matching = await database.pool.query<{ count: number }>(
    'select count(*)::int as count from drizzle.__drizzle_migrations where hash = $1',
    [hash],
  );
  const total = await database.pool.query<{ count: number }>(
    'select count(*)::int as count from drizzle.__drizzle_migrations',
  );
  const latest = await database.pool.query<{ hash: string }>(
    'select hash from drizzle.__drizzle_migrations order by id desc limit 1',
  );
  return {
    table: table.rows[0]?.present === true,
    constraints: Number(constraints.rows[0]?.count ?? -1),
    matching: Number(matching.rows[0]?.count ?? -1),
    total: Number(total.rows[0]?.count ?? -1),
    latest: latest.rows[0]?.hash ?? null,
  };
};

const applied = {
  table: true,
  constraints: 3,
  matching: 1,
  total: 15,
  latest: null as string | null,
};

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('0014 rollback script on real PostgreSQL', () => {
  beforeAll(async () => {
    hash = createHash('sha256')
      .update(await readFile(FORWARD))
      .digest('hex');
    previousHash = createHash('sha256')
      .update(await readFile(PREVIOUS))
      .digest('hex');
  });

  it('removes the reservation schema and re-applies it', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    expect(await read(database)).toEqual({ ...applied, latest: hash });

    const rollback = runRollback(database, hash);
    expect(rollback.stderr).toBe('');
    expect(rollback.status).toBe(0);
    expect(await read(database)).toEqual({
      table: false,
      constraints: 0,
      matching: 0,
      total: 14,
      latest: previousHash,
    });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({ ...applied, latest: hash });
  }, 30_000);

  it('refuses a second rollback instead of silently deleting nothing', async () => {
    const database = await createTestDatabase();
    databases.push(database);

    expect(runRollback(database, hash).status).toBe(0);
    const rejected = runRollback(database, hash);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('0014 rollback refused: expected exactly one applied 0014');
    // The refusal is transactional: nothing is half-applied.
    expect(await read(database)).toEqual({
      table: false,
      constraints: 0,
      matching: 0,
      total: 14,
      latest: previousHash,
    });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({ ...applied, latest: hash });
  }, 30_000);

  it('refuses a wrong or missing hash without changing the schema or ledger', async () => {
    const database = await createTestDatabase();
    databases.push(database);

    const wrong = runRollback(database, '0'.repeat(64));
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('0014 rollback refused: hash mismatch');
    expect(await read(database)).toEqual({ ...applied, latest: hash });

    const missing = runRollback(database);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('0014 rollback refused: pass -v hash=');
    expect(await read(database)).toEqual({ ...applied, latest: hash });
  }, 30_000);

  it('refuses while a later migration is applied', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ('later-than-0014', 9999999999999)",
    );

    const rejected = runRollback(database, hash);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      '0014 rollback refused: 0014 is not the latest applied migration',
    );
    expect(await read(database)).toEqual({
      table: true,
      constraints: 3,
      matching: 1,
      total: 16,
      latest: 'later-than-0014',
    });
  }, 30_000);

  it('refuses a duplicated ledger row without changing the schema or ledger', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query(
      'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, 1794002928472)',
      [hash],
    );

    const rejected = runRollback(database, hash);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('0014 rollback refused: expected exactly one applied 0014');
    expect(await read(database)).toEqual({
      table: true,
      constraints: 3,
      matching: 2,
      total: 16,
      latest: hash,
    });
  }, 30_000);

  it('rolls back the DDL when a later statement in the same transaction fails', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query(`
      create function moyu_refuse_0014_ledger_delete() returns trigger as $$
      begin
        raise exception 'injected 0014 ledger delete failure';
      end $$ language plpgsql;
      create trigger moyu_refuse_0014_ledger_delete
        before delete on drizzle.__drizzle_migrations
        for each row execute function moyu_refuse_0014_ledger_delete();
    `);

    const failed = runRollback(database, hash);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('injected 0014 ledger delete failure');
    // The table, its foreign keys and the 0014 ledger row survive the failed run.
    expect(await read(database)).toEqual({ ...applied, latest: hash });
  }, 30_000);

  it('refuses when 0014 is not applied at all', async () => {
    const database = await createTestDatabaseUpTo(13);
    databases.push(database);

    const rejected = runRollback(database, hash);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('0014 rollback refused: expected exactly one applied 0014');
    expect(await read(database)).toEqual({
      table: false,
      constraints: 0,
      matching: 0,
      total: 14,
      latest: previousHash,
    });
  }, 30_000);
});
