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
let downSql0015 = '';
let downSql0016 = '';
let downSql0017 = '';
const databases: TestDatabase[] = [];

const read = async (database: TestDatabase) => {
  const state = await database.pool.query<{ table_present: boolean; ledger_present: boolean }>(
    `select to_regclass('public.execution_reservations') is not null as table_present,
            exists (select 1 from drizzle.__drizzle_migrations where hash = $1) as ledger_present`,
    [hash],
  );
  return state.rows[0];
};

const messageColumn = async (database: TestDatabase): Promise<boolean> => {
  const state = await database.pool.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'artifacts' and column_name = 'message_id'
     ) as present`,
  );
  return state.rows[0]?.present === true;
};

/**
 * 0015 is now the latest migration, and `migrateDatabase` only replays migrations
 * after the last applied ledger row: rolling 0014 back while 0015 is recorded
 * cannot be re-applied by the migrator. The supported order is 0015 first, then
 * 0014. Refusing a foreign or non-latest 0014 rollback in the script itself is
 * #37's scope, not this ticket's.
 */
async function rollBackThrough0014(database: TestDatabase): Promise<void> {
  await database.pool.query(downSql0017);
  await database.pool.query(downSql0016);
  await database.pool.query(downSql0015);
  await database.pool.query(downSql);
}

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
    downSql0015 = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0015_late_gateway.down.sql'),
      'utf8',
    );
    downSql0016 = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0016_attachment_revoke.down.sql'),
      'utf8',
    );
    downSql0017 = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0017_workable_cardiac.down.sql'),
      'utf8',
    );
  });

  it('refuses a second rollback instead of silently deleting nothing', async () => {
    const database = await createTestDatabase();
    databases.push(database);

    await rollBackThrough0014(database);
    expect(await read(database)).toEqual({ table_present: false, ledger_present: false });

    await expect(database.pool.query(downSql)).rejects.toThrow(/0014 rollback refused/);
    // The refusal is transactional: nothing is half-applied.
    expect(await read(database)).toEqual({ table_present: false, ledger_present: false });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({ table_present: true, ledger_present: true });
  }, 30_000);

  it('removes the reservation schema and re-applies it with 0015', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    expect(await read(database)).toEqual({ table_present: true, ledger_present: true });
    expect(await messageColumn(database)).toBe(true);

    await rollBackThrough0014(database);
    expect(await read(database)).toEqual({ table_present: false, ledger_present: false });
    expect(await messageColumn(database)).toBe(false);

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({ table_present: true, ledger_present: true });
    expect(await messageColumn(database)).toBe(true);
  }, 30_000);
});
