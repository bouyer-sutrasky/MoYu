import { z } from 'zod';

const postgresUrlSchema = z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must be a postgres:// or postgresql:// URL',
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: postgresUrlSchema.optional(),
});

export type ApiConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  apiHost: string;
  apiPort: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  databaseUrl?: string;
};

/**
 * Parses API configuration without echoing values, so a bad DATABASE_URL cannot
 * leak credentials into logs or a crash report.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = environmentSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid API configuration: ${details}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    apiHost: parsed.data.API_HOST,
    apiPort: parsed.data.API_PORT,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: parsed.data.DATABASE_URL,
  };
}
