import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit generate only reads schema and migration folders. dbCredentials
 * exists for explicit migrate/push commands and never contains a real secret in
 * the repository.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://moyu:CHANGE_ME@127.0.0.1:5432/moyu',
  },
});
