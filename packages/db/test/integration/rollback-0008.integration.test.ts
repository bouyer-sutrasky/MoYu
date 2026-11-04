import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../../src/migrate';
import { createTestDatabase, type TestDatabase } from './helpers';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FORWARD = path.join(ROOT, 'packages/db/migrations/0008_defer_reply_fk.sql');
const ROLLBACK = path.join(ROOT, 'packages/db/migrations/rollback/0008_defer_reply_fk.down.sql');
let hash = '';
const databases: TestDatabase[] = [];

const createDatabase = async (): Promise<TestDatabase> => {
  const database = await createTestDatabase();
  databases.push(database);
  return database;
};

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
  const fk = await database.pool.query(
    `select condeferrable as deferrable, condeferred as deferred
       from pg_constraint where conname = 'messages_reply_same_conversation_fk'`,
  );
  const ledger = await database.pool.query(
    'select count(*)::int as count from drizzle.__drizzle_migrations where hash = $1',
    [hash],
  );
  return {
    deferrable: fk.rows[0]?.deferrable as boolean | undefined,
    deferred: fk.rows[0]?.deferred as boolean | undefined,
    count: Number(ledger.rows[0]?.count ?? -1),
  };
};

const seedReplyGraph = async (
  database: TestDatabase,
): Promise<{ parent: string; child: string; target: string }> => {
  const owner = await database.db.execute(
    sql`insert into owners (display_name) values (${`Rollback 8 ${randomUUID()}`}) returning id`,
  );
  const ownerId = String(owner.rows[0]?.id);
  const repo = await database.db.execute(
    sql`insert into repositories (owner_id, full_name, status) values (${ownerId}, ${`Bouyer12/rb8-${randomUUID()}`}, 'active') returning id`,
  );
  const repositoryId = String(repo.rows[0]?.id);
  const a = await database.db.execute(
    sql`insert into conversations (owner_id, repository_id, mode, base_branch) values (${ownerId}, ${repositoryId}, 'work', 'main') returning id`,
  );
  const b = await database.db.execute(
    sql`insert into conversations (owner_id, repository_id, mode, base_branch) values (${ownerId}, ${repositoryId}, 'work', 'main') returning id`,
  );
  const source = String(a.rows[0]?.id),
    target = String(b.rows[0]?.id);
  const parent = await database.db.execute(
    sql`insert into messages (conversation_id, direction, kind, body) values (${source}, 'inbound', 'user', 'parent') returning id`,
  );
  const parentId = String(parent.rows[0]?.id);
  const child = await database.db.execute(
    sql`insert into messages (conversation_id, direction, kind, body, reply_to_message_id) values (${source}, 'inbound', 'user', 'child', ${parentId}) returning id`,
  );
  return { parent: parentId, child: String(child.rows[0]?.id), target };
};

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('0008 rollback script on real PostgreSQL', () => {
  beforeAll(async () => {
    hash = createHash('sha256')
      .update(await readFile(FORWARD))
      .digest('hex');
  });

  it('deletes exactly the 0008 ledger row and restores immediate FKs, then re-applies deferred FKs', async () => {
    const database = await createDatabase();
    expect(await read(database)).toMatchObject({ deferrable: true, deferred: true, count: 1 });

    const rollback = runRollback(database, hash);
    expect(rollback.stderr).toBe('');
    expect(rollback.status).toBe(0);
    expect(await read(database)).toMatchObject({ deferrable: false, deferred: false, count: 0 });

    await migrateDatabase(database.db);
    expect(await read(database)).toMatchObject({ deferrable: true, deferred: true, count: 1 });
  }, 30_000);

  it('moves a reply graph between conversations after re-apply, proving deferred checking', async () => {
    const database = await createDatabase();
    const graph = await seedReplyGraph(database);
    await database.pool.query('begin');
    try {
      await database.pool.query(
        'update messages set conversation_id = $1 where conversation_id = (select id from conversations where id <> $1 order by created_at limit 1)',
        [graph.target],
      );
      await database.pool.query('commit');
    } catch (error) {
      await database.pool.query('rollback');
      throw error;
    }
    const rows = await database.db.execute(
      sql`select id, conversation_id, reply_to_message_id from messages where id in (${graph.parent}, ${graph.child}) order by body`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) expect(String(row.conversation_id)).toBe(graph.target);
    const child = rows.rows.find((row) => String(row.id) === graph.child);
    expect(String(child?.reply_to_message_id)).toBe(graph.parent);
  }, 30_000);

  it('refuses wrong, missing and non-latest hashes without changing schema or ledger', async () => {
    const wrong = await createDatabase();
    expect(runRollback(wrong, '0'.repeat(64)).status).not.toBe(0);
    expect(await read(wrong)).toMatchObject({ deferrable: true, deferred: true, count: 1 });
    expect(runRollback(wrong).status).not.toBe(0);
    expect(await read(wrong)).toMatchObject({ deferrable: true, deferred: true, count: 1 });

    const newer = await createDatabase();
    await newer.pool.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ('newer-than-0008', 9999999999999)",
    );
    const rejected = runRollback(newer, hash);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('not the latest applied migration');
    expect(await read(newer)).toMatchObject({ deferrable: true, deferred: true, count: 1 });
  }, 30_000);
});
