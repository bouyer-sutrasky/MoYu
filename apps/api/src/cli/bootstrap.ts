import { createDatabase, createPool } from '@moyu/db';

import { createBootstrapCode } from '../auth/bootstrap';
import { loadConfig } from '../config';

/**
 * Operator-only command that creates a short-lived, one-time binding code.
 *
 * - When no owner exists, the code opens first registration.
 * - When an owner exists but no active passkey remains, it opens recovery.
 * - When an active passkey exists, it refuses: sign in and add a passkey instead.
 *
 * The plaintext code is printed to this terminal once and never logged or stored.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required to create a binding code');
  }

  const pool = createPool(config.databaseUrl, { max: 2 });
  const database = createDatabase(pool);
  try {
    const result = await createBootstrapCode(database, config.bootstrapTtlMs);
    const minutes = Math.round(config.bootstrapTtlMs / 60_000);
    process.stdout.write(
      [
        '',
        `MoYu ${result.purpose === 'initial' ? 'first-registration' : 'recovery'} binding code:`,
        '',
        `    ${result.code}`,
        '',
        `One use only. Expires at ${result.expiresAt.toISOString()} (${minutes} minutes).`,
        result.purpose === 'initial'
          ? 'Enter it in the web setup page to register the first passkey.'
          : 'Enter it in the web recovery page to register a replacement passkey.',
        'Treat this code like a password: do not paste it into issues, chat or logs.',
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `MoYu binding code was not created: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
