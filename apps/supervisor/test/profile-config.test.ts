import { describe, expect, it } from 'vitest';

import {
  mergeProfileSettings,
  type PanelSettingsView,
  type ProfileInvariants,
} from '../src/profile-config';

const invariants: ProfileInvariants = {
  repository: 'Bouyer12/m5a-alpha-adf10ad9',
  ownerId: 'owner-1',
  githubAllowedUsers: ['sutrasky'],
  githubCli: '/opt/moyu-m6c/bin/gh-agent',
  worktreeDir: '/var/lib/moyu-m6c/worktrees/m6c-a',
  prepare: 'git clone --no-tags "ssh://example" "$DSH_SUPERAGENT_DIR"',
  model: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
};

/** A runtime view for a brand-new instance: no saved blocks yet. */
function fresh(): PanelSettingsView {
  return {
    blocks: {},
    sources: [
      { id: 'workspace', revision: 0, value: { enabled: false, config: {} } },
      { id: 'github', revision: 0, value: { enabled: false, config: {} } },
    ],
  };
}

/** A runtime view where the owner has edited everything the platform lets them edit. */
function configured(): PanelSettingsView {
  return {
    blocks: {
      policy: {
        revision: 7,
        value: {
          rules: [{ id: 'r1', name: 'keep me', enabled: true, instruction: 'do the thing' }],
          sources: {
            workspace: { allowed: [{ id: 'owner-1' }], admission: { listedUnaddressed: 'auto' } },
            github: {
              allowed: [{ id: 'Bouyer12' }],
              admission: { unlistedAddressed: 'explicit' },
              bots: [{ id: 'dependabot[bot]' }],
            },
          },
        },
      },
      executor: {
        revision: 11,
        value: {
          model: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-pro' },
          maxWorkers: 4,
          directory: '/somewhere/else',
          prepare: 'echo hijacked',
          blockedCommands: ['rm -rf /', 'git push --force'],
        },
      },
      eval: {
        revision: 3,
        value: {
          mode: 'observe',
          timeoutSeconds: 600,
          model: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-max' },
        },
      },
    },
    sources: [
      {
        id: 'workspace',
        revision: 5,
        value: { enabled: true, config: { repository: 'Bouyer12/stale-repository' } },
      },
      {
        id: 'github',
        revision: 6,
        value: {
          enabled: true,
          config: {
            repository: 'Bouyer12/stale-repository',
            cli: '/usr/bin/gh',
            pollSeconds: 900,
            failuresBeforeError: 9,
            observeIssues: true,
            observePulls: true,
            observeComments: true,
            observeCi: true,
          },
        },
      },
    ],
  };
}

const blockOf = (merged: ReturnType<typeof mergeProfileSettings>, name: string) =>
  merged.find((entry) => entry.block === name);

describe('mergeProfileSettings — first run', () => {
  it('seeds the editable defaults once', () => {
    const merged = mergeProfileSettings(fresh(), invariants, true);
    const github = blockOf(merged, 'source:github')!.value as {
      enabled: boolean;
      config: Record<string, unknown>;
    };
    expect(github.enabled).toBe(true);
    expect(github.config).toMatchObject({
      repository: invariants.repository,
      cli: invariants.githubCli,
      pollSeconds: 60,
      failuresBeforeError: 3,
      observeIssues: false,
      observePulls: false,
      observeComments: false,
      observeCi: false,
    });
    const executor = blockOf(merged, 'executor')!.value as Record<string, unknown>;
    expect(executor.maxWorkers).toBe(1);
    expect(executor.directory).toBe(invariants.worktreeDir);
    expect(executor.prepare).toBe(invariants.prepare);
    expect(executor.blockedCommands).toEqual([]);
    expect(executor.model).toEqual({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
    });
    const evaluate = blockOf(merged, 'eval')!.value as Record<string, unknown>;
    expect(evaluate).toMatchObject({ mode: 'auto', timeoutSeconds: 300 });
  });

  it('revision is taken from the runtime block being replaced', () => {
    const merged = mergeProfileSettings(fresh(), invariants, true);
    expect(blockOf(merged, 'source:github')!.revision).toBe(0);
    expect(blockOf(merged, 'policy')!.revision).toBe(0);
  });
});

describe('mergeProfileSettings — every later start', () => {
  it('keeps the owner GitHub polling and observation switches', () => {
    const merged = mergeProfileSettings(configured(), invariants, false);
    const github = blockOf(merged, 'source:github')!.value as {
      config: Record<string, unknown>;
    };
    expect(github.config.pollSeconds).toBe(900);
    expect(github.config.failuresBeforeError).toBe(9);
    expect(github.config.observeIssues).toBe(true);
    expect(github.config.observePulls).toBe(true);
    expect(github.config.observeComments).toBe(true);
    expect(github.config.observeCi).toBe(true);
  });

  it('keeps the owner worker model, blocked commands and Eval settings', () => {
    const merged = mergeProfileSettings(configured(), invariants, false);
    const executor = blockOf(merged, 'executor')!.value as Record<string, unknown>;
    expect(executor.model).toEqual({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-pro',
    });
    expect(executor.blockedCommands).toEqual(['rm -rf /', 'git push --force']);
    expect(blockOf(merged, 'eval')).toBeUndefined();
  });

  it('keeps the owner policy rules and admission tables', () => {
    const merged = mergeProfileSettings(configured(), invariants, false);
    const policy = blockOf(merged, 'policy')!.value as {
      rules: unknown[];
      sources: Record<string, Record<string, unknown>>;
    };
    expect(policy.rules).toHaveLength(1);
    expect(policy.sources.workspace!.admission).toEqual({ listedUnaddressed: 'auto' });
    expect(policy.sources.github!.admission).toEqual({ unlistedAddressed: 'explicit' });
    expect(policy.sources.github!.bots).toEqual([{ id: 'dependabot[bot]' }]);
  });

  it('never lets a saved config move the platform invariants', () => {
    const merged = mergeProfileSettings(configured(), invariants, false);
    const executor = blockOf(merged, 'executor')!.value as Record<string, unknown>;
    expect(executor.maxWorkers).toBe(1);
    expect(executor.directory).toBe(invariants.worktreeDir);
    expect(executor.prepare).toBe(invariants.prepare);
    const workspace = blockOf(merged, 'source:workspace')!.value as {
      config: Record<string, unknown>;
    };
    expect(workspace.config.repository).toBe(invariants.repository);
    const github = blockOf(merged, 'source:github')!.value as {
      config: Record<string, unknown>;
    };
    expect(github.config.repository).toBe(invariants.repository);
    expect(github.config.cli).toBe(invariants.githubCli);
  });

  it('re-asserts the platform allow-lists without dropping owner-added ids', () => {
    const merged = mergeProfileSettings(
      configured(),
      { ...invariants, githubAllowedUsers: ['sutrasky', 'new-owner'] },
      false,
    );
    const policy = blockOf(merged, 'policy')!.value as {
      sources: Record<string, { allowed: Array<{ id: string }> }>;
    };
    expect(policy.sources.github!.allowed.map((entry) => entry.id)).toEqual([
      'Bouyer12',
      'sutrasky',
      'new-owner',
    ]);
    expect(policy.sources.workspace!.allowed.map((entry) => entry.id)).toEqual(['owner-1']);
  });

  it('keeps an explicit false GitHub listener on an old profile without a seed marker', () => {
    const view = configured();
    const githubSource = view.sources!.find((source) => source.id === 'github')!;
    githubSource.value = { ...githubSource.value, enabled: false };
    const merged = mergeProfileSettings(view, invariants, false);
    const github = blockOf(merged, 'source:github')!.value as { enabled: boolean };
    expect(github.enabled).toBe(false);
  });

  it('sends no save at all when nothing changed', () => {
    const seeded = mergeProfileSettings(fresh(), invariants, true);
    const applied: PanelSettingsView = {
      blocks: {
        policy: { revision: 1, value: blockOf(seeded, 'policy')!.value },
        executor: { revision: 1, value: blockOf(seeded, 'executor')!.value },
        eval: { revision: 1, value: blockOf(seeded, 'eval')!.value },
      },
      sources: [
        { id: 'workspace', revision: 1, value: blockOf(seeded, 'source:workspace')!.value },
        { id: 'github', revision: 1, value: blockOf(seeded, 'source:github')!.value },
      ],
    };
    expect(mergeProfileSettings(applied, invariants, false)).toEqual([]);
  });
});

describe('mergeProfileSettings — repository isolation', () => {
  it('a second repository never inherits the first one settings', () => {
    const first = mergeProfileSettings(configured(), invariants, false);
    const secondInvariants: ProfileInvariants = {
      ...invariants,
      repository: 'Bouyer12/m5a-beta-adf10ad9',
      worktreeDir: '/var/lib/moyu-m6c/worktrees/m6c-b',
    };
    const second = mergeProfileSettings(fresh(), secondInvariants, true);
    const github = blockOf(second, 'source:github')!.value as {
      config: Record<string, unknown>;
    };
    expect(github.config.repository).toBe('Bouyer12/m5a-beta-adf10ad9');
    expect(github.config.pollSeconds).toBe(60);
    expect(JSON.stringify(second)).not.toContain('deepseek/deepseek-v4.1-pro');
    expect(JSON.stringify(first)).toContain('deepseek/deepseek-v4.1-pro');
  });

  it('re-pointing one instance to a renamed repository keeps the owner config', () => {
    const merged = mergeProfileSettings(
      configured(),
      { ...invariants, repository: 'Bouyer12/renamed-repo' },
      false,
    );
    const workspace = blockOf(merged, 'source:workspace')!.value as {
      config: Record<string, unknown>;
    };
    expect(workspace.config.repository).toBe('Bouyer12/renamed-repo');
    const executor = blockOf(merged, 'executor')!.value as Record<string, unknown>;
    expect(executor.model).toEqual({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-pro',
    });
  });
});
