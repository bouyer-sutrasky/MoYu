import { z } from 'zod';

const postgresUrlSchema = z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must be a postgres:// or postgresql:// URL',
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: postgresUrlSchema,
  BRIDGE_REPOSITORY: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/name')
    .optional(),
  BRIDGE_URL: z.string().url().optional(),
  BRIDGE_TOKEN: z.string().min(16).optional(),
  BRIDGE_CREDENTIAL_REF: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
  DELIVERY_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  DELIVERY_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  DELIVERY_RETRY_CAP_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  EVENT_SYNC_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  // M4 owner commands (start/pause/resume/retry) and runtime leases.
  OPERATION_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  OPERATION_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  OPERATION_LEASE_TTL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  OPERATION_RETRY_CAP_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  RECONCILE_ON_START: z.enum(['true', 'false']).default('true'),
  REPORT_CAPTURE_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2000),
});

export type DispatcherConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  databaseUrl: string;
  bridgeRepository?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  bridgeCredentialRef?: string;
  deliveryIntervalMs: number;
  deliveryLeaseMs: number;
  deliveryRetryCapMs: number;
  eventSyncIntervalMs: number;
  operationIntervalMs: number;
  operationLeaseMs: number;
  operationLeaseTtlMs: number;
  operationRetryCapMs: number;
  reconcileOnStart: boolean;
  reportCaptureIntervalMs: number;
};

/**
 * The dispatcher owns durable delivery and Bridge event catch-up. All Bridge
 * settings are optional overrides; a repository row supplies its own loopback
 * endpoint and credential reference, so secrets stay out of the database.
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
    bridgeRepository: parsed.data.BRIDGE_REPOSITORY,
    bridgeUrl: parsed.data.BRIDGE_URL,
    bridgeToken: parsed.data.BRIDGE_TOKEN,
    bridgeCredentialRef: parsed.data.BRIDGE_CREDENTIAL_REF,
    deliveryIntervalMs: parsed.data.DELIVERY_INTERVAL_MS,
    deliveryLeaseMs: parsed.data.DELIVERY_LEASE_MS,
    deliveryRetryCapMs: parsed.data.DELIVERY_RETRY_CAP_MS,
    eventSyncIntervalMs: parsed.data.EVENT_SYNC_INTERVAL_MS,
    operationIntervalMs: parsed.data.OPERATION_INTERVAL_MS,
    operationLeaseMs: parsed.data.OPERATION_LEASE_MS,
    operationLeaseTtlMs: parsed.data.OPERATION_LEASE_TTL_MS,
    operationRetryCapMs: parsed.data.OPERATION_RETRY_CAP_MS,
    reconcileOnStart: parsed.data.RECONCILE_ON_START === 'true',
    reportCaptureIntervalMs: parsed.data.REPORT_CAPTURE_INTERVAL_MS,
  };
}
