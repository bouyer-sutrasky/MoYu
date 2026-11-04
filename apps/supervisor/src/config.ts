import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

const postgresUrlSchema = z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must be a postgres:// or postgresql:// URL',
});

const pinnedInstanceSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    profile: z.string().regex(/^[A-Za-z0-9._-]+$/),
    dshPort: z.number().int().min(1024).max(65_535),
    bridgePort: z.number().int().min(1024).max(65_535),
  })
  .strict();

const instancesFileSchema = z
  .object({
    instances: z.array(pinnedInstanceSchema).default([]),
    portRange: z
      .object({
        start: z.number().int().min(1024).max(65_535).default(3401),
        end: z.number().int().min(1024).max(65_535).default(3499),
      })
      .default({ start: 3401, end: 3499 }),
  })
  .strict();

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SUPERVISOR_HOST: z.string().min(1).default('127.0.0.1'),
  SUPERVISOR_PORT: z.coerce.number().int().min(1).max(65_535).default(4490),
  SUPERVISOR_TOKEN: z.string().min(32),
  DATABASE_URL: postgresUrlSchema,
  INSTANCES_CONFIG: z.string().min(1),
  DSH_BIN: z.string().min(1).default('/usr/bin/dsh'),
  DSH_HOME: z.string().min(1),
  PLATFORM_URL: z.string().url(),
  RUNTIME_CREDENTIALS_DIR: z.string().min(1),
  INSTANCE_ENV_DIR: z.string().min(1),
  INSTANCE_LOG_DIR: z.string().min(1),
  WORKTREE_ROOT: z.string().min(1),
  /** Optional profile template cloned for a repository with no pinned mapping. */
  PROFILE_TEMPLATE_DIR: z.string().min(1).optional(),
  PROFILE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .default('m5'),
  MAX_ONLINE: z.coerce.number().int().min(1).max(8).default(2),
  TICK_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2000),
  START_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600_000).default(120_000),
  STOP_TIMEOUT_MS: z.coerce.number().int().min(2000).max(120_000).default(30_000),
  EXECUTOR_MODEL: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/)
    .default('commandcode/deepseek/deepseek-v4.1-flash'),
  EXECUTOR_REASONING_EFFORT: z.string().min(1).optional(),
  GITHUB_CLI: z.string().min(1).default('/root/.local/bin/gh-agent'),
  GITHUB_ALLOWED_USERS: z.string().min(1).default('sutrasky'),
  GITHUB_ACCOUNT: z.string().min(1).default('Bouyer12'),
  GITHUB_COMMIT_EMAIL: z.string().email().default('202233540+Bouyer12@users.noreply.github.com'),
});

export interface PinnedInstance {
  repository: string;
  profile: string;
  dshPort: number;
  bridgePort: number;
}

export interface SupervisorConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  host: string;
  port: number;
  token: string;
  databaseUrl: string;
  instancesConfigPath: string;
  pinned: Map<string, PinnedInstance>;
  portRange: { start: number; end: number };
  dshBin: string;
  dshHome: string;
  platformUrl: string;
  credentialsDir: string;
  instanceEnvDir: string;
  logDir: string;
  worktreeRoot: string;
  profileTemplateDir?: string;
  profilePrefix: string;
  maxOnline: number;
  tickIntervalMs: number;
  startTimeoutMs: number;
  stopTimeoutMs: number;
  executorModel: string;
  executorReasoningEffort?: string;
  githubCli: string;
  githubAllowedUsers: string[];
  githubAccount: string;
  githubCommitEmail: string;
}

export function loadSupervisorConfig(
  env: Record<string, string | undefined> = process.env,
): SupervisorConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid supervisor configuration: ${details}`);
  }
  const data = parsed.data;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(data.INSTANCES_CONFIG, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read INSTANCES_CONFIG ${data.INSTANCES_CONFIG}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const file = instancesFileSchema.parse(raw);
  const pinned = new Map<string, PinnedInstance>();
  for (const instance of file.instances) {
    if (pinned.has(instance.repository)) {
      throw new Error(`INSTANCES_CONFIG repeats repository ${instance.repository}`);
    }
    if (instance.dshPort === instance.bridgePort) {
      throw new Error(`INSTANCES_CONFIG uses the same port twice for ${instance.repository}`);
    }
    pinned.set(instance.repository, instance);
  }
  if (file.portRange.start >= file.portRange.end) {
    throw new Error('INSTANCES_CONFIG portRange.start must be below portRange.end');
  }
  return {
    nodeEnv: data.NODE_ENV,
    logLevel: data.LOG_LEVEL,
    host: data.SUPERVISOR_HOST,
    port: data.SUPERVISOR_PORT,
    token: data.SUPERVISOR_TOKEN,
    databaseUrl: data.DATABASE_URL,
    instancesConfigPath: resolve(data.INSTANCES_CONFIG),
    pinned,
    portRange: file.portRange,
    dshBin: data.DSH_BIN,
    dshHome: resolve(data.DSH_HOME),
    platformUrl: data.PLATFORM_URL.replace(/\/+$/, ''),
    credentialsDir: resolve(data.RUNTIME_CREDENTIALS_DIR),
    instanceEnvDir: resolve(data.INSTANCE_ENV_DIR),
    logDir: resolve(data.INSTANCE_LOG_DIR),
    worktreeRoot: resolve(data.WORKTREE_ROOT),
    ...(data.PROFILE_TEMPLATE_DIR
      ? { profileTemplateDir: resolve(data.PROFILE_TEMPLATE_DIR) }
      : {}),
    profilePrefix: data.PROFILE_PREFIX,
    maxOnline: data.MAX_ONLINE,
    tickIntervalMs: data.TICK_INTERVAL_MS,
    startTimeoutMs: data.START_TIMEOUT_MS,
    stopTimeoutMs: data.STOP_TIMEOUT_MS,
    executorModel: data.EXECUTOR_MODEL,
    ...(data.EXECUTOR_REASONING_EFFORT
      ? { executorReasoningEffort: data.EXECUTOR_REASONING_EFFORT }
      : {}),
    githubCli: data.GITHUB_CLI,
    githubAllowedUsers: data.GITHUB_ALLOWED_USERS.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    githubAccount: data.GITHUB_ACCOUNT,
    githubCommitEmail: data.GITHUB_COMMIT_EMAIL,
  };
}
