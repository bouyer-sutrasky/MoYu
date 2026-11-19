import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SupervisorConfig } from '../src/config';
import { instanceProcessEnvironment, prepareInstance } from '../src/provision';

const dynamicRepositoryId = '00000000-0000-4000-8000-000000000001';
const secondDynamicRepositoryId = '00000000-0000-4000-8000-000000000002';
const pinnedRepositoryId = '00000000-0000-4000-8000-000000000003';

interface StoredInstance {
  repositoryId: string;
  state: string;
  desiredState: string;
  reasonCode: string;
  profile?: string | null;
  port?: number | null;
  bridgePort?: number | null;
}

describe('runtime home provisioning', () => {
  let root: string;
  let dshHome: string;
  let config: SupervisorConfig;
  let store: {
    getRepository: (id: string) => Promise<unknown>;
    getInstance: (id: string) => Promise<StoredInstance | null>;
    listInstances: () => Promise<StoredInstance[]>;
    setBridgeBinding: () => Promise<void>;
    createInstance: (
      id: string,
      state: string,
      desiredState: string,
      reasonCode: string,
      fields?: Record<string, unknown>,
    ) => Promise<void>;
    updateInstance: (id: string, fields: Record<string, unknown>) => Promise<void>;
  };
  const repositories = new Map<string, Record<string, unknown>>();
  const instances = new Map<string, StoredInstance>();

  /**
   * The same credential lookup `deploy/bin/gh-agent` performs: it resolves the
   * config from HOME unless GH_CONFIG_DIR is set, then hands it to `gh`. The
   * fixture proves the launched environment can resolve the account; it never
   * talks to GitHub.
   */
  function writeAccountFixture(): string {
    const path = join(root, 'gh-agent-account-check');
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        ': "${HOME:=/nonexistent}"',
        ': "${GH_CONFIG_DIR:=$HOME/.config/gh-agent}"',
        'test -r "$GH_CONFIG_DIR/hosts.yml" || { echo "not logged in" >&2; exit 1; }',
        'grep -q "user: Bouyer12" "$GH_CONFIG_DIR/hosts.yml" || { echo "wrong account" >&2; exit 1; }',
        'echo \'{"login":"Bouyer12"}\'',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return path;
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'moyu-provision-'));
    dshHome = join(root, 'dsh');
    const templateDir = join(root, 'profile-template');
    mkdirSync(join(templateDir, 'node_modules', 'dsh-superagent'), { recursive: true });
    writeFileSync(
      join(templateDir, 'cordis.patch.yml'),
      ['- id: dsh-superagent', '  config:', '    stateDir: __STATE_DIR__', ''].join('\n'),
      { mode: 0o600 },
    );
    // The supervisor's agent GitHub account. A runtime HOME without a copy of
    // this directory is exactly the field failure this test covers.
    mkdirSync(join(root, '.config', 'gh-agent'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, '.config', 'gh-agent', 'hosts.yml'),
      ['github.com:', '    user: Bouyer12', '    oauth_token: test-token', ''].join('\n'),
      { mode: 0o600 },
    );
    mkdirSync(join(root, '.ssh'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, '.ssh', 'config'),
      ['Host github.com', '  IdentityFile ' + join(root, '.ssh', 'id_ed25519'), ''].join('\n'),
      { mode: 0o600 },
    );
    writeFileSync(join(root, '.ssh', 'id_ed25519'), 'test-key', { mode: 0o600 });
    mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(dshHome, '.env'), 'DSH_TEST=1\n', { mode: 0o400 });
    writeFileSync(join(dshHome, '.credentials.yaml'), 'test: true\n', { mode: 0o400 });

    repositories.set(dynamicRepositoryId, {
      id: dynamicRepositoryId,
      ownerId: 'owner',
      fullName: 'Bouyer12/dynamic-one',
      defaultBranch: 'main',
      bridgeUrl: null,
      bridgeCredentialRef: null,
      checkCommands: null,
      status: 'active',
    });
    repositories.set(secondDynamicRepositoryId, {
      ...(repositories.get(dynamicRepositoryId) as Record<string, unknown>),
      id: secondDynamicRepositoryId,
      fullName: 'Bouyer12/dynamic-two',
    });
    repositories.set(pinnedRepositoryId, {
      ...(repositories.get(dynamicRepositoryId) as Record<string, unknown>),
      id: pinnedRepositoryId,
      fullName: 'Bouyer12/pinned-one',
    });

    store = {
      getRepository: async (id) => repositories.get(id) ?? null,
      getInstance: async (id) => instances.get(id) ?? null,
      listInstances: async () => [...instances.values()],
      setBridgeBinding: async () => undefined,
      createInstance: async (id, state, desiredState, reasonCode, fields = {}) => {
        instances.set(id, {
          repositoryId: id,
          state,
          desiredState,
          reasonCode,
          ...(fields as Partial<StoredInstance>),
        });
      },
      updateInstance: async (id, fields) => {
        const current = instances.get(id);
        if (current) Object.assign(current, fields);
      },
    };

    config = {
      dshHome,
      profileTemplateDir: templateDir,
      profilePrefix: 'm6c',
      portRange: { start: 39_000, end: 39_020 },
      credentialsDir: join(root, 'credentials'),
      instanceEnvDir: join(root, 'instances'),
      logDir: join(root, 'logs'),
      worktreeRoot: join(root, 'worktrees'),
      githubConfigDir: join(root, '.config', 'gh-agent'),
      pinned: new Map(),
    } as unknown as SupervisorConfig;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('gives dynamically allocated profiles an isolated home that resolves the GitHub account', async () => {
    const first = await prepareInstance(config, store as never, dynamicRepositoryId);
    const second = await prepareInstance(config, store as never, secondDynamicRepositoryId);

    expect(first.profile).not.toBe(second.profile);
    expect(first.runtimeHome).toBe(join(dshHome, 'homes', first.profile));
    expect(second.runtimeHome).toBe(join(dshHome, 'homes', second.profile));
    expect(first.runtimeHome).not.toBe(second.runtimeHome);

    for (const prepared of [first, second]) {
      const home = prepared.runtimeHome!;
      expect(existsSync(join(home, '.config', 'gh-agent', 'hosts.yml'))).toBe(true);
      expect(existsSync(join(home, '.ssh', 'config'))).toBe(true);
      expect(existsSync(join(home, '.env'))).toBe(true);
      expect(existsSync(join(home, '.credentials.yaml'))).toBe(true);
      expect(lstatSync(join(home, 'profiles')).isSymbolicLink()).toBe(true);
      // The profile patch points the runtime state at this home, not the
      // shared supervisor state.
      const patch = readFileSync(
        join(dshHome, 'profiles', prepared.profile, 'cordis.patch.yml'),
        'utf8',
      );
      expect(patch).toContain(`stateDir: ${join(home, 'state', prepared.profile)}`);

      const environment = instanceProcessEnvironment(prepared, config, { PATH: '/usr/bin:/bin' });
      expect(environment.HOME).toBe(home);
      expect(environment.DSH_HOME).toBe(home);
      expect(environment.TMPDIR).toBe(join(home, 'tmp'));
      expect(environment.XDG_CACHE_HOME).toBe(join(home, 'cache'));
      // `dsh` loads the isolated `$HOME/.env` itself; the supervisor must not
      // silently merge the shared one into the process environment.
      expect(environment.DSH_TEST).toBe(undefined);
      expect(readFileSync(join(home, '.env'), 'utf8')).toContain('DSH_TEST=1');

      const account = execFileSync(writeAccountFixture(), [], { env: environment });
      expect(account.toString().trim()).toBe('{"login":"Bouyer12"}');
    }
  });

  it('keeps the pinned runtime home and identity regression intact', async () => {
    const pinnedHome = join(root, 'homes', 'pinned');
    (config.pinned as Map<string, unknown>).set('Bouyer12/pinned-one', {
      repository: 'Bouyer12/pinned-one',
      profile: 'm6c-pinned',
      dshPort: 39_030,
      bridgePort: 39_031,
      runtimeUid: process.getuid?.(),
      runtimeGid: process.getgid?.(),
      runtimeHome: pinnedHome,
    });

    const prepared = await prepareInstance(config, store as never, pinnedRepositoryId);
    expect(prepared.profile).toBe('m6c-pinned');
    expect(prepared.runtimeHome).toBe(pinnedHome);
    expect(prepared.runtimeUid).toBe(process.getuid?.());
    expect(existsSync(join(pinnedHome, '.config', 'gh-agent', 'hosts.yml'))).toBe(true);
    expect(existsSync(join(pinnedHome, 'profiles'))).toBe(true);
    expect(lstatSync(join(pinnedHome, 'profiles')).isSymbolicLink()).toBe(true);
  });

  it('fails preparation with an actionable error when the supervisor has no GitHub config', async () => {
    const broken = { ...config, githubConfigDir: join(root, 'missing-gh-config') };
    await expect(
      prepareInstance(broken as never, store as never, pinnedRepositoryId),
    ).rejects.toThrow(/GitHub CLI configuration is missing/);
  });
});
