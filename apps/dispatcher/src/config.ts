import { z } from 'zod';

const postgresUrlSchema = z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must be a postgres:// or postgresql:// URL',
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: postgresUrlSchema,
});

export type DispatcherConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  databaseUrl: string;
};

/**
 * The dispatcher owns delivery polling and runtime admission. M1 wires the
 * process, database connection and structured logging; the delivery loop is part
 * of the M3 message path, so this config only parses what M1 needs.
 */
export function loadDispatcherConfig(
  env: Record<string, string | undefined> = process.env,
): DispatcherConfig {
  const parsed = environmentSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid dispatcher configuration: ${details}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: parsed.data.DATABASE_URL,
  };
}
