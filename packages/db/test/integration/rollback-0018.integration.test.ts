import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/migrate';
import { createTestDatabase, createTestDatabaseUpTo, type TestDatabase } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
let hash = '';
let downSql = '';
const databases: TestDatabase[] = [];

const read = async (database: TestDatabase) => {
  const state = await database.pool.query<{
    audit_present: boolean;
    column_present: boolean;
    ledger_present: boolean;
  }>(
    `select
       to_regclass('public.repository_audit_events') is not null as audit_present,
       exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'repositories'
            and column_name = 'check_commands'
       ) as column_present,
       exists (select 1 from drizzle.__drizzle_migrations where hash = $1) as ledger_present`,
    [hash],
  );
  return state.rows[0];
};

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('0018 rollback script on real PostgreSQL', () => {
  beforeAll(async () => {
    hash = createHash('sha256')
      .update(await readFile(path.join(ROOT, 'packages/db/migrations/0018_zippy_warhawk.sql')))
      .digest('hex');
    downSql = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0018_zippy_warhawk.down.sql'),
      'utf8',
    );
  });

  it('drops the audit table and the column, refuses a second rollback, and re-applies cleanly', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    expect(await read(database)).toEqual({
      audit_present: true,
      column_present: true,
      ledger_present: true,
    });

    await database.pool.query(downSql);
    expect(await read(database)).toEqual({
      audit_present: false,
      column_present: false,
      ledger_present: false,
    });

    await expect(database.pool.query(downSql)).rejects.toThrow(/0018 rollback refused/);
    expect(await read(database)).toEqual({
      audit_present: false,
      column_present: false,
      ledger_present: false,
    });

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({
      audit_present: true,
      column_present: true,
      ledger_present: true,
    });
  }, 30_000);

  it('refuses to roll back underneath a later migration and keeps the new schema', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ('test-later-migration-fixture-0018', 1)`,
    );
    await expect(database.pool.query(downSql)).rejects.toThrow(/later migration/);
    expect(await read(database)).toEqual({
      audit_present: true,
      column_present: true,
      ledger_present: true,
    });
  }, 30_000);

  it('upgrades an existing database without rewriting repository rows and enforces the shape check', async () => {
    const database = await createTestDatabaseUpTo(17);
    databases.push(database);
    const owner = await database.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('0018 upgrade owner') returning id`,
    );
    const ownerId = owner.rows[0]!.id;
    const repository = await database.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name) values ($1, 'owner/upgrade-0018') returning id`,
      [ownerId],
    );
    const repositoryId = repository.rows[0]!.id;

    await migrateDatabase(database.db);
    expect(await read(database)).toEqual({
      audit_present: true,
      column_present: true,
      ledger_present: true,
    });
    const upgraded = await database.pool.query<{ check_commands: unknown }>(
      `select check_commands from repositories where id = $1`,
      [repositoryId],
    );
    expect(upgraded.rows[0]).toEqual({ check_commands: null });

    await expect(
      database.pool.query(`update repositories set check_commands = '[]'::jsonb where id = $1`, [
        repositoryId,
      ]),
    ).rejects.toThrow(/repositories_check_commands_shape/);
    await expect(
      database.pool.query(
        `update repositories set check_commands = '[${Array.from(
          { length: 9 },
          (_, index) => `"echo ${index}"`,
        ).join(',')}]'::jsonb where id = $1`,
        [repositoryId],
      ),
    ).rejects.toThrow(/repositories_check_commands_shape/);

    await database.pool.query(
      `update repositories set check_commands = '["npm test"]'::jsonb where id = $1`,
      [repositoryId],
    );
    const stored = await database.pool.query<{ check_commands: string[] }>(
      `select check_commands from repositories where id = $1`,
      [repositoryId],
    );
    expect(stored.rows[0]?.check_commands).toEqual(['npm test']);
  }, 30_000);
});
