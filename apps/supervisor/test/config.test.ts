import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSupervisorConfig } from '../src/config';

const directories: string[] = [];

function configFile(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'moyu-supervisor-'));
  directories.push(directory);
  const path = join(directory, 'instances.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function env(path: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    SUPERVISOR_TOKEN: 'token-0123456789-token-0123456789',
    DATABASE_URL: 'postgres://moyu@127.0.0.1:55432/moyu_test',
    INSTANCES_CONFIG: path,
    DSH_HOME: '/tmp/moyu-supervisor-home',
    PLATFORM_URL: 'http://127.0.0.1:4500',
    RUNTIME_CREDENTIALS_DIR: '/tmp/moyu-supervisor-home/credentials',
    INSTANCE_ENV_DIR: '/tmp/moyu-supervisor-home/instances',
    INSTANCE_LOG_DIR: '/tmp/moyu-supervisor-home/logs',
    WORKTREE_ROOT: '/tmp/moyu-supervisor-home/worktrees',
  };
}

describe('supervisor config', () => {
  it('loads pinned repositories and the fixed port range', () => {
    const path = configFile({
      instances: [
        {
          repository: 'acme/a',
          profile: 'm5a',
          dshPort: 3402,
          bridgePort: 3401,
        },
      ],
      portRange: { start: 3411, end: 3499 },
    });
    const config = loadSupervisorConfig(env(path));
    expect(config.pinned.get('acme/a')).toMatchObject({
      profile: 'm5a',
      dshPort: 3402,
      bridgePort: 3401,
    });
    expect(config.maxOnline).toBe(2);
    expect(config.portRange).toEqual({ start: 3411, end: 3499 });
  });

  it('rejects a duplicate repository and a shared port', () => {
    const duplicate = configFile({
      instances: [
        { repository: 'acme/a', profile: 'm5a', dshPort: 3402, bridgePort: 3401 },
        { repository: 'acme/a', profile: 'm5b', dshPort: 3404, bridgePort: 3403 },
      ],
    });
    expect(() => loadSupervisorConfig(env(duplicate))).toThrow(/repeats repository/);

    const shared = configFile({
      instances: [{ repository: 'acme/a', profile: 'm5a', dshPort: 3401, bridgePort: 3401 }],
    });
    expect(() => loadSupervisorConfig(env(shared))).toThrow(/same port/);
  });

  it('rejects a missing supervisor token', () => {
    const path = configFile({ instances: [] });
    const values = env(path);
    delete values.SUPERVISOR_TOKEN;
    expect(() => loadSupervisorConfig(values)).toThrow(/SUPERVISOR_TOKEN/);
  });

  it('loads the review check identity only when all three values are present', () => {
    const path = configFile({ instances: [] });
    const values = {
      ...env(path),
      REVIEW_CHECK_UID: '1002',
      REVIEW_CHECK_GID: '1003',
      REVIEW_CHECK_HOME: '/var/lib/moyu-check/home',
    };
    const config = loadSupervisorConfig(values);
    expect(config.reviewCheckUid).toBe(1002);
    expect(config.reviewCheckGid).toBe(1003);
    expect(config.reviewCheckHome).toBe('/var/lib/moyu-check/home');
    expect(config.reviewCheckSetpriv).toBe('/usr/bin/setpriv');

    const partial: Record<string, string> = { ...values };
    delete partial.REVIEW_CHECK_GID;
    expect(() => loadSupervisorConfig(partial)).toThrow(/set together/);

    expect(() =>
      loadSupervisorConfig({ ...values, REVIEW_CHECK_HOME: 'relative/check-home' }),
    ).toThrow(/absolute/);
  });

  it('rejects a per-command timeout larger than the total budget', () => {
    const path = configFile({ instances: [] });
    expect(() =>
      loadSupervisorConfig({
        ...env(path),
        REVIEW_CHECK_TIMEOUT_MS: '901000',
        REVIEW_CHECK_TOTAL_TIMEOUT_MS: '900000',
      }),
    ).toThrow(/REVIEW_CHECK_TIMEOUT_MS/);

    const config = loadSupervisorConfig({
      ...env(path),
      REVIEW_CHECK_TIMEOUT_MS: '600000',
      REVIEW_CHECK_TOTAL_TIMEOUT_MS: '900000',
    });
    expect(config.reviewCheckTimeoutMs).toBe(600000);
    expect(config.reviewCheckTotalTimeoutMs).toBe(900000);
  });
});
