import { z } from 'zod';

const postgresUrlSchema = z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must be a postgres:// or postgresql:// URL',
});

const booleanStringSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: postgresUrlSchema.optional(),

    WEBAUTHN_RP_ID: z.string().min(1).default('moyu.sutrasky.com'),
    WEBAUTHN_RP_NAME: z.string().min(1).default('MoYu'),
    WEBAUTHN_ORIGIN: z.string().url().default('https://moyu.sutrasky.com'),

    AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),
    AUTH_BOOTSTRAP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    AUTH_COOKIE_SECURE: booleanStringSchema,

    ARTIFACT_STORAGE_DIR: z.string().min(1).optional(),
    WEB_DIST_DIR: z.string().min(1).optional(),

    // Repository runtime binding (M3). The Bridge is loopback-only; tokens are
    // machine credentials and are never exposed to the browser.
    BRIDGE_REPOSITORY: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/name')
      .optional(),
    BRIDGE_URL: z.string().url().optional(),
    BRIDGE_TOKEN: z.string().min(16).optional(),
    BRIDGE_CALLBACK_TOKEN: z.string().min(16).optional(),
    BRIDGE_CREDENTIAL_REF: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    BRIDGE_DEFAULT_BRANCH: z.string().trim().min(1).max(255).default('main'),
    BRIDGE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),

    // M5 host supervisor and per-repository credentials. The API never accepts
    // a path or command from the browser; it asks the supervisor about a
    // repository id that it has already authorized.
    SUPERVISOR_URL: z.string().url().optional(),
    SUPERVISOR_TOKEN: z.string().min(16).optional(),
    RUNTIME_CREDENTIALS_DIR: z.string().min(1).optional(),
    GITHUB_CLI: z.string().min(1).default('gh'),
  })
  .superRefine((value, context) => {
    if (value.BRIDGE_URL && !value.BRIDGE_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['BRIDGE_TOKEN'],
        message: 'is required when BRIDGE_URL is set',
      });
    }
    let host: string;
    try {
      host = new URL(value.WEBAUTHN_ORIGIN).hostname;
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['WEBAUTHN_ORIGIN'],
        message: 'must be an absolute URL',
      });
      return;
    }
    if (host !== value.WEBAUTHN_RP_ID && !host.endsWith(`.${value.WEBAUTHN_RP_ID}`)) {
      context.addIssue({
        code: 'custom',
        path: ['WEBAUTHN_RP_ID'],
        message: 'must be the origin host or one of its parent domains',
      });
    }
  });

export type ApiConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  apiHost: string;
  apiPort: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  databaseUrl?: string;
  webauthnRpId: string;
  webauthnRpName: string;
  webauthnOrigin: string;
  sessionTtlMs: number;
  bootstrapTtlMs: number;
  challengeTtlMs: number;
  cookieSecure: boolean;
  artifactStorageDir?: string;
  webDistDir?: string;
  bridgeRepository?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  bridgeCallbackToken?: string;
  bridgeCredentialRef?: string;
  bridgeDefaultBranch: string;
  bridgeTimeoutMs: number;
  supervisorUrl?: string;
  supervisorToken?: string;
  runtimeCredentialsDir?: string;
  githubCli: string;
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

  const data = parsed.data;
  const originIsHttps = new URL(data.WEBAUTHN_ORIGIN).protocol === 'https:';

  return {
    nodeEnv: data.NODE_ENV,
    apiHost: data.API_HOST,
    apiPort: data.API_PORT,
    logLevel: data.LOG_LEVEL,
    databaseUrl: data.DATABASE_URL,
    webauthnRpId: data.WEBAUTHN_RP_ID,
    webauthnRpName: data.WEBAUTHN_RP_NAME,
    webauthnOrigin: data.WEBAUTHN_ORIGIN,
    sessionTtlMs: data.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    bootstrapTtlMs: data.AUTH_BOOTSTRAP_TTL_MINUTES * 60 * 1000,
    challengeTtlMs: data.AUTH_CHALLENGE_TTL_SECONDS * 1000,
    cookieSecure: data.AUTH_COOKIE_SECURE ?? originIsHttps,
    artifactStorageDir: data.ARTIFACT_STORAGE_DIR,
    webDistDir: data.WEB_DIST_DIR ?? 'apps/web/dist',
    bridgeRepository: data.BRIDGE_REPOSITORY,
    bridgeUrl: data.BRIDGE_URL,
    bridgeToken: data.BRIDGE_TOKEN,
    bridgeCallbackToken: data.BRIDGE_CALLBACK_TOKEN,
    bridgeCredentialRef: data.BRIDGE_CREDENTIAL_REF,
    bridgeDefaultBranch: data.BRIDGE_DEFAULT_BRANCH,
    bridgeTimeoutMs: data.BRIDGE_TIMEOUT_MS,
    supervisorUrl: data.SUPERVISOR_URL,
    supervisorToken: data.SUPERVISOR_TOKEN,
    runtimeCredentialsDir: data.RUNTIME_CREDENTIALS_DIR,
    githubCli: data.GITHUB_CLI,
  };
}
