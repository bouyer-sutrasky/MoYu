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
    throw new Error(
      'TEST_DATABASE_ADMIN_URL is required for API integration tests. Point it at an isolated ' +
        'PostgreSQL server (for example postgres://moyu@127.0.0.1:55432/postgres).',
    );
  }
  return url;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = requireAdminUrl();
  const name = `moyu_api_test_${process.pid}_${randomBytes(6).toString('hex')}`;

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

export function cookiePair(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) {
    return '';
  }
  return header.split(';', 1)[0] ?? '';
}
