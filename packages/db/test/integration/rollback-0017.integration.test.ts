import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/migrate';
import { createTestDatabase, type TestDatabase } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
let hash = '';
let downSql = '';
let downSql0018 = '';
const databases: TestDatabase[] = [];

const read = async (database: TestDatabase) => {
  const state = await database.pool.query<{
    runs_present: boolean;
    items_present: boolean;
    ledger_present: boolean;
  }>(
    `select
       to_regclass('public.cleanup_runs') is not null as runs_present,
       to_regclass('public.cleanup_items') is not null as items_present,
       exists (select 1 from drizzle.__drizzle_migrations where hash = $1) as ledger_present`,
    [hash],
  );
  return state.rows[0];
};

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('0017 rollback script on real PostgreSQL', () => {
  beforeAll(async () => {
    hash = createHash('sha256')
      .update(await readFile(path.join(ROOT, 'packages/db/migrations/0017_workable_cardiac.sql')))
      .digest('hex');
    downSql = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0017_workable_cardiac.down.sql'),
      'utf8',
    );
    downSql0018 = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0018_zippy_warhawk.down.sql'),
      'utf8',
    );
  });

  it('drops the cleanup audit tables, refuses a second rollback, and re-applies cleanly', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    expect(await read(database)).toEqual({
      runs_present: true,
      items_present: true,
      ledger_present: true,
    });

    await database.pool.query(downSql0018);
    await database.pool.query(downSql);
    expect(await read(database)).toEqual({
      runs_present: false,
      items_present: false,
      ledger_present: false,
    });

    await expect(database.pool.query(downSql)).rejects.toThrow(/0017 rollback refused/);
    expect(await read(database)).toEqual({
      runs_present: false,
      items_present: false,
      ledger_present: false,
    });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({
      runs_present: true,
      items_present: true,
      ledger_present: true,
    });
  }, 30_000);

  it('refuses to roll back underneath a later migration and keeps the tables', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ('test-later-migration-fixture-0017', 1)`,
    );
    await expect(database.pool.query(downSql)).rejects.toThrow(/later migration/);
    expect(await read(database)).toEqual({
      runs_present: true,
      items_present: true,
      ledger_present: true,
    });
  }, 30_000);
});
