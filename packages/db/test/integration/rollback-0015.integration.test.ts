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
  const state = await database.pool.query<{ column_present: boolean; ledger_present: boolean }>(
    `select exists (
              select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'artifacts' and column_name = 'message_id'
            ) as column_present,
            exists (select 1 from drizzle.__drizzle_migrations where hash = $1) as ledger_present`,
    [hash],
  );
  return state.rows[0];
};

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('0015 rollback script on real PostgreSQL', () => {
  beforeAll(async () => {
    hash = createHash('sha256')
      .update(await readFile(path.join(ROOT, 'packages/db/migrations/0015_late_gateway.sql')))
      .digest('hex');
    downSql = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0015_late_gateway.down.sql'),
      'utf8',
    );
  });

  it('refuses a second rollback instead of silently deleting nothing', async () => {
    const database = await createTestDatabase();
    databases.push(database);

    await database.pool.query(downSql);
    expect(await read(database)).toEqual({ column_present: false, ledger_present: false });

    await expect(database.pool.query(downSql)).rejects.toThrow(/0015 rollback refused/);
    // The refusal is transactional: nothing is half-applied.
    expect(await read(database)).toEqual({ column_present: false, ledger_present: false });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({ column_present: true, ledger_present: true });
  }, 30_000);

  it('re-applies the attachment link and rejects an unknown message id', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    expect(await read(database)).toEqual({ column_present: true, ledger_present: true });

    await database.pool.query(downSql);
    expect(await read(database)).toEqual({ column_present: false, ledger_present: false });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({ column_present: true, ledger_present: true });

    // The recreated foreign key still protects the column.
    await expect(
      database.pool.query(
        `insert into artifacts (repository_id, type, message_id)
         select r.id, 'attachment', '00000000-0000-0000-0000-000000000000'::uuid
           from repositories r limit 1`,
      ),
    ).rejects.toThrow();
  }, 30_000);
});
