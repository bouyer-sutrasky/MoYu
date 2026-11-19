import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/migrate';
import { createTestDatabase, type TestDatabase } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FORWARD = path.join(ROOT, 'packages/db/migrations/0021_task_decision_routing.sql');
const ROLLBACK = path.join(
  ROOT,
  'packages/db/migrations/rollback/0021_task_decision_routing.down.sql',
);

let hash = '';
let downSql = '';
let downSql0022 = '';
const databases: TestDatabase[] = [];

interface State {
  decisionColumn: boolean;
  prUpdatedColumn: boolean;
  ledgerMatches: number;
  tasks: number;
}

async function readState(database: TestDatabase): Promise<State> {
  const columns = await database.pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'task_links'
        and column_name in ('decision', 'pr_updated_at')`,
  );
  const ledger = await database.pool.query<{ matching: number }>(
    'select count(*) filter (where hash = $1)::int as matching from drizzle.__drizzle_migrations',
    [hash],
  );
  const tasks = await database.pool.query<{ count: number }>(
    'select count(*)::int as count from task_links',
  );
  return {
    decisionColumn: columns.rows.some((row) => row.column_name === 'decision'),
    prUpdatedColumn: columns.rows.some((row) => row.column_name === 'pr_updated_at'),
    ledgerMatches: Number(ledger.rows[0]?.matching ?? -1),
    tasks: Number(tasks.rows[0]?.count ?? -1),
  };
}

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('0021 rollback script on real PostgreSQL', () => {
  beforeAll(async () => {
    hash = createHash('sha256')
      .update(await readFile(FORWARD))
      .digest('hex');
    downSql = await readFile(ROLLBACK, 'utf8');
    downSql0022 = await readFile(
      path.join(ROOT, 'packages/db/migrations/rollback/0022_youthful_loki.down.sql'),
      'utf8',
    );
  });

  it('drops only the decision and PR-order projections and can be re-applied', async () => {
    expect(hash).toBe('45072a4ec846a8417672a26379b823738cafce6bcbd854cad342f80dc375b768');

    const database = await createTestDatabase();
    databases.push(database);
    const owner = await database.pool.query<{ id: string }>(
      `insert into owners (display_name) values ('0021 rollback') returning id`,
    );
    const ownerId = owner.rows[0]!.id;
    const repository = await database.pool.query<{ id: string }>(
      `insert into repositories (owner_id, full_name) values ($1, 'Bouyer12/0021-rollback') returning id`,
      [ownerId],
    );
    const repositoryId = repository.rows[0]!.id;
    const conversation = await database.pool.query<{ id: string }>(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, base_branch)
       values ($1, $2, 'work', 'execute', 'main') returning id`,
      [ownerId, repositoryId],
    );
    await database.pool.query(
      `insert into task_links (conversation_id, repository_id, state, base_branch, decision, pr_updated_at)
       values ($1, $2, 'not_accepted', 'main', '{"kind":"ignore","code":"said"}'::jsonb, now())`,
      [conversation.rows[0]!.id, repositoryId],
    );

    expect(await readState(database)).toMatchObject({
      decisionColumn: true,
      prUpdatedColumn: true,
      ledgerMatches: 1,
      tasks: 1,
    });

    // 0022 is newer than 0021, so it is rolled back first.
    await database.pool.query(downSql0022);
    await database.pool.query(downSql);
    expect(await readState(database)).toMatchObject({
      decisionColumn: false,
      prUpdatedColumn: false,
      ledgerMatches: 0,
      tasks: 1,
    });

    await migrateDatabase(database.db);
    expect(await readState(database)).toMatchObject({
      decisionColumn: true,
      prUpdatedColumn: true,
      ledgerMatches: 1,
      tasks: 1,
    });
  }, 30_000);
});
