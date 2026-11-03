import { randomBytes } from 'node:crypto';

import { Client, Pool } from 'pg';

import { createDatabase, type Database } from '../../src/client';
import { migrateDatabase } from '../../src/migrate';

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
      'TEST_DATABASE_ADMIN_URL is required. Point it at an isolated PostgreSQL database ' +
        '(for example postgres://moyu:...@127.0.0.1:5432/postgres); the integration suite ' +
        'creates and drops its own databases and never uses mocks.',
    );
  }
  return url;
}

function databaseUrlFor(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Creates an empty real PostgreSQL database, applies the committed migrations and
 * returns a pool for the suite. The database is dropped afterwards, so a failing
 * test cannot leak state into the next run.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = requireAdminUrl();
  const name = `moyu_test_${process.pid}_${randomBytes(6).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = databaseUrlFor(adminUrl, name);
  const pool = new Pool({ connectionString: url, max: 4 });
  const db = createDatabase(pool);
  await migrateDatabase(db);

  return {
    name,
    url,
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

/**
 * Extracts the PostgreSQL SQLSTATE from a Drizzle-wrapped error.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') {
    return candidate.code;
  }
  if (typeof candidate.cause === 'object' && candidate.cause !== null) {
    const cause = candidate.cause as { code?: unknown };
    if (typeof cause.code === 'string') {
      return cause.code;
    }
  }
  return undefined;
}

export async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}
