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
const databases: TestDatabase[] = [];

const read = async (database: TestDatabase) => {
  const state = await database.pool.query<{ table_present: boolean; ledger_present: boolean }>(
    `select to_regclass('public.execution_reservations') is not null as table_present,
            exists (select 1 from drizzle.__drizzle_migrations where hash = $1) as ledger_present`,
    [hash],
  );
  return state.rows[0];
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
  });

  it('refuses a second rollback instead of silently deleting nothing', async () => {
    const database = await createTestDatabase();
    databases.push(database);

    await database.pool.query(downSql);
    expect(await read(database)).toEqual({ table_present: false, ledger_present: false });

    await expect(database.pool.query(downSql)).rejects.toThrow(/0014 rollback refused/);
    // The refusal is transactional: nothing is half-applied.
    expect(await read(database)).toEqual({ table_present: false, ledger_present: false });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({ table_present: true, ledger_present: true });
  }, 30_000);

  it('removes the reservation schema and re-applies it', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    expect(await read(database)).toEqual({ table_present: true, ledger_present: true });

    await database.pool.query(downSql);
    expect(await read(database)).toEqual({ table_present: false, ledger_present: false });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({ table_present: true, ledger_present: true });
  }, 30_000);
});
