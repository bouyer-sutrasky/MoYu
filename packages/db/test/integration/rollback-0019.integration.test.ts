import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/migrate';
import { createTestDatabase, type TestDatabase } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FORWARD = path.join(ROOT, 'packages/db/migrations/0019_event_dedupe_per_repository.sql');
const ROLLBACK = path.join(
  ROOT,
  'packages/db/migrations/rollback/0019_event_dedupe_per_repository.down.sql',
);

let hash = '';
let downSql = '';
let downSql0020 = '';
let downSql0021 = '';
const databases: TestDatabase[] = [];

interface State {
  indexDef: string | null;
  ledgerRows: number;
  ledgerMatches: number;
  events: number;
}

const readState = async (database: TestDatabase): Promise<State> => {
  const index = await database.pool.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'events_source_event_uq'`,
  );
  const ledger = await database.pool.query<{ total: number; matching: number }>(
    `select count(*)::int as total,
            count(*) filter (where hash = $1)::int as matching
       from drizzle.__drizzle_migrations`,
    [hash],
  );
  const events = await database.pool.query<{ count: number }>(
    'select count(*)::int as count from events',
  );
  return {
    indexDef: index.rows[0]?.indexdef ?? null,
    ledgerRows: Number(ledger.rows[0]?.total ?? -1),
    ledgerMatches: Number(ledger.rows[0]?.matching ?? -1),
    events: Number(events.rows[0]?.count ?? -1),
  };
};

const seedRepository = async (database: TestDatabase, label: string): Promise<string> => {
  const owner = await database.pool.query<{ id: string }>(
    'insert into owners (display_name) values ($1) returning id',
    [`0019 rollback ${label}`],
  );
  const ownerId = owner.rows[0]!.id;
  const repository = await database.pool.query<{ id: string }>(
    `insert into repositories (owner_id, full_name)
     values ($1, $2) returning id`,
    [ownerId, `Bouyer12/0019-rollback-${label}`],
  );
  return repository.rows[0]!.id;
};

const insertEvent = async (
  database: TestDatabase,
  repositoryId: string,
  sourceEventId: string,
  source = 'bridge',
): Promise<void> => {
  await database.pool.query(
    `insert into events (type, source, source_event_id, repository_id)
     values ('test.recorded', $1, $2, $3)`,
    [source, sourceEventId, repositoryId],
  );
};

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('0019 rollback script on real PostgreSQL', () => {
  beforeAll(async () => {
    hash = createHash('sha256')
      .update(await readFile(FORWARD))
      .digest('hex');
    downSql = await readFile(ROLLBACK, 'utf8');
    downSql0020 = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0020_worthless_carmella_unuscione.down.sql'),
      'utf8',
    );
    downSql0021 = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0021_task_decision_routing.down.sql'),
      'utf8',
    );
  });

  it('pins the deployed 0019 forward hash and restores the old global index', async () => {
    expect(hash).toBe('e26aa1a486c36303d69dbae6b5f125187738d1c3460184f119e009a95fda7453');

    const database = await createTestDatabase();
    databases.push(database);
    const first = await seedRepository(database, 'roundtrip-a');
    const second = await seedRepository(database, 'roundtrip-b');
    await insertEvent(database, first, 'event-one');
    await insertEvent(database, second, 'event-two');

    expect(await readState(database)).toMatchObject({
      ledgerMatches: 1,
      events: 2,
    });
    expect((await readState(database)).indexDef).toContain(
      '(repository_id, source, source_event_id)',
    );

    await database.pool.query(downSql0021);
    await database.pool.query(downSql0020);
    await database.pool.query(downSql);
    const rolledBack = await readState(database);
    expect(rolledBack).toMatchObject({ ledgerMatches: 0, events: 2 });
    expect(rolledBack.indexDef).toContain('UNIQUE INDEX');
    expect(rolledBack.indexDef).toContain('(source, source_event_id)');
    expect(rolledBack.indexDef).not.toContain('(repository_id, source, source_event_id)');

    // The 0019-only invariant is gone: two repositories may no longer share an
    // event id, and the old code's duplicate protection is back.
    await insertEvent(database, first, 'cross-repository-id');
    await expect(insertEvent(database, second, 'cross-repository-id')).rejects.toThrow(
      /events_source_event_uq/,
    );
    await expect(insertEvent(database, first, 'cross-repository-id')).rejects.toThrow(
      /events_source_event_uq/,
    );

    await migrateDatabase(database.db);
    const reApplied = await readState(database);
    expect(reApplied).toMatchObject({ ledgerMatches: 1, events: 3 });
    expect(reApplied.indexDef).toContain('(repository_id, source, source_event_id)');

    // Re-applying 0019 restores the scoped invariant without losing the row
    // written while the old index was active.
    await insertEvent(database, second, 'cross-repository-id');
    expect(await readState(database)).toMatchObject({ events: 4 });
  }, 30_000);

  it('refuses when the 0019 ledger row is absent and leaves schema and data untouched', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await insertEvent(database, await seedRepository(database, 'missing-ledger'), 'event-missing');
    await database.pool.query('delete from drizzle.__drizzle_migrations where hash = $1', [hash]);

    const before = await readState(database);
    await expect(database.pool.query(downSql)).rejects.toThrow(
      /expected exactly one applied 0019 migration/,
    );
    expect(await readState(database)).toEqual(before);
  }, 30_000);

  it('refuses duplicate 0019 ledger rows and leaves schema and data untouched', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await insertEvent(database, await seedRepository(database, 'duplicate-ledger'), 'event-ledger');
    await database.pool.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, 9999999999999)`,
      [hash],
    );

    const before = await readState(database);
    await expect(database.pool.query(downSql)).rejects.toThrow(
      /expected exactly one applied 0019 migration/,
    );
    expect(await readState(database)).toEqual(before);
  }, 30_000);

  it('refuses to roll back underneath a later migration and keeps the 0019 index', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await insertEvent(database, await seedRepository(database, 'later'), 'event-later');
    await database.pool.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ('test-later-migration-fixture-0019', 9999999999999)`,
    );

    const before = await readState(database);
    await expect(database.pool.query(downSql)).rejects.toThrow(/later migration/);
    expect(await readState(database)).toEqual(before);
  }, 30_000);

  it('refuses a cross-repository duplicate that the old global index cannot represent', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const first = await seedRepository(database, 'conflict-a');
    const second = await seedRepository(database, 'conflict-b');
    await insertEvent(database, first, 'same-event-id');
    await insertEvent(database, second, 'same-event-id');

    await database.pool.query(downSql0021);
    await database.pool.query(downSql0020);
    const before = await readState(database);
    expect(before.events).toBe(2);
    await expect(database.pool.query(downSql)).rejects.toThrow(
      /old global unique index cannot be restored without losing data/,
    );
    expect(await readState(database)).toEqual(before);

    const rows = await database.pool.query<{ count: number }>(
      `select count(*)::int as count from events where source_event_id = 'same-event-id'`,
    );
    expect(Number(rows.rows[0]?.count)).toBe(2);
  }, 30_000);

  it('refuses a drifted index definition instead of guessing at the replacement', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await database.pool.query('drop index events_source_event_uq');
    await database.pool.query(
      `create unique index events_source_event_uq
         on events using btree (source, source_event_id)
        where source_event_id is not null`,
    );

    await database.pool.query(downSql0021);
    await database.pool.query(downSql0020);
    const before = await readState(database);
    await expect(database.pool.query(downSql)).rejects.toThrow(
      /does not have the 0019 repository-scoped definition/,
    );
    expect(await readState(database)).toEqual(before);
  }, 30_000);
});
