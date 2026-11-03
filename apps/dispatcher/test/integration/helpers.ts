import { randomBytes } from 'node:crypto';

import { Client, Pool } from 'pg';

import { createDatabase, migrateDatabase, type Database } from '@moyu/db';

export interface TestDatabase {
  name: string;
  url: string;
  pool: Pool;
  db: Database;
  drop: () => Promise<void>;
}

function requireAdminUrl(): string {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_ADMIN_URL is required for dispatcher integration tests');
  }
  return url;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = requireAdminUrl();
  const name = `moyu_dispatcher_test_${process.pid}_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  const db = createDatabase(pool);
  await migrateDatabase(db);
  return {
    name,
    url: url.toString(),
    pool,
    db,
    drop: async () => {
      await pool.end();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
