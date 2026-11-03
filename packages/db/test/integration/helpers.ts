import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, Pool } from 'pg';

import { createDatabase, type Database } from '../../src/client';
import { defaultMigrationsFolder, migrateDatabase } from '../../src/migrate';

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

export interface TestDatabaseOptions {
  /** Migration folder to apply; defaults to the committed migrations. */
  migrationsFolder?: string;
}

/**
 * Creates an empty real PostgreSQL database, applies the committed migrations and
 * returns a pool for the suite. The database is dropped afterwards, so a failing
 * test cannot leak state into the next run.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
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
  await migrateDatabase(db, options.migrationsFolder);

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
 * Copies the committed migrations up to and including `upTo` into a temporary
 * folder, so a test can build a database at an older schema revision and then
 * exercise the forward migration against realistic existing rows.
 */
async function createMigrationSubset(upTo: number): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), 'moyu-migrations-'));
  await mkdir(path.join(target, 'meta'), { recursive: true });
  const journal = JSON.parse(
    await readFile(path.join(defaultMigrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((entry) => entry.idx <= upTo);
  await writeFile(
    path.join(target, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    await copyFile(
      path.join(defaultMigrationsFolder, `${entry.tag}.sql`),
      path.join(target, `${entry.tag}.sql`),
    );
    const snapshot = `${String(entry.idx).padStart(4, '0')}_snapshot.json`;
    try {
      await copyFile(
        path.join(defaultMigrationsFolder, 'meta', snapshot),
        path.join(target, 'meta', snapshot),
      );
    } catch {
      // Older migration folders may not have a snapshot for every entry.
    }
  }
  return target;
}

/**
 * Creates an empty database migrated up to (and including) the given migration
 * index, leaving the newest forward migrations unapplied.
 */
export async function createTestDatabaseUpTo(upTo: number): Promise<TestDatabase> {
  const folder = await createMigrationSubset(upTo);
  try {
    return await createTestDatabase({ migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
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
