import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Database } from './client';

/**
 * Resolves the committed migration folder from this module. It works both from
 * src (tsx/vitest) and from dist (a built package lives next to migrations/).
 */
export const defaultMigrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrateDatabase(
  database: Database,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  await migrate(database, { migrationsFolder });
}
