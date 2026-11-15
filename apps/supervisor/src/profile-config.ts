/**
 * Per-repository runtime settings merge.
 *
 * A managed instance is configured through the runtime's own settings blocks.
 * The supervisor owns a small set of *platform invariants* (the repository the
 * Source watches, the execution capacity, the worktree directory and the clone
 * command, and the identity allow-lists). Everything else is the owner's
 * configuration and must survive a sleep/wake/restart cycle.
 *
 * Before this module the supervisor re-sent a full default block on every
 * start, which silently overwrote owner edits (GitHub polling and observation
 * switches, the worker model, blocked commands, the Eval mode/timeout and the
 * Policy rules). `mergeProfileSettings` is the pure function that fixes it:
 * invariants are always re-asserted, first-run defaults are applied only when
 * the instance has never been initialised, and every other field keeps the
 * value the runtime already reports.
 */

export interface SettingsBlock {
  revision: number;
  value: Record<string, unknown>;
}

export interface PanelSettingsView {
  blocks: Record<string, SettingsBlock | undefined>;
  sources?: Array<{ id: string; revision: number; value?: Record<string, unknown> }>;
  policyVersion?: number;
}

export interface ProfileInvariants {
  repository: string;
  ownerId: string;
  githubAllowedUsers: string[];
  githubCli: string;
  worktreeDir: string;
  prepare: string;
  model: { provider: string; model: string; reasoningEffort?: string };
}

/** First-run defaults for fields the owner may edit afterwards. */
const GITHUB_DEFAULTS = {
  pollSeconds: 60,
  failuresBeforeError: 3,
  observeIssues: false,
  observePulls: false,
  observeComments: false,
  observeCi: false,
} as const;

const EVAL_DEFAULTS = {
  mode: 'auto',
  timeoutSeconds: 300,
} as const;

export interface MergedBlock {
  block: string;
  revision: number;
  value: Record<string, unknown>;
  /** True when the merged value differs from the runtime's current value. */
  changed: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function sourceValue(settings: PanelSettingsView, id: string): Record<string, unknown> {
  const entry = settings.sources?.find((source) => source.id === id);
  return record(entry?.value);
}

function sourceRevision(settings: PanelSettingsView, id: string): number {
  return settings.sources?.find((source) => source.id === id)?.revision ?? 0;
}

function blockRevision(settings: PanelSettingsView, block: string): number {
  return settings.blocks?.[block]?.revision ?? 0;
}

function blockValue(settings: PanelSettingsView, block: string): Record<string, unknown> {
  return record(settings.blocks?.[block]?.value);
}

/**
 * Fill only the keys the owner has never set. An explicit `false`/`0` the owner
 * chose is kept, so "off" is not mistaken for "unset".
 */
function seedDefaults(
  current: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(defaults)) {
    if (next[key] === undefined || next[key] === null) next[key] = value;
  }
  return next;
}

function keyedIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const id = record(item).id;
        return typeof id === 'string' ? [id] : [];
      })
    : [];
}

/** Union of the ids the owner already had and the platform's required ones. */
function allowList(current: unknown, required: string[]): Array<{ id: string }> {
  const ids = [...new Set([...keyedIds(current), ...required])];
  return ids.map((id) => ({ id }));
}

/**
 * Merge the platform invariants and (on first run only) the defaults into the
 * runtime's current settings. Returns only the blocks that actually change, so
 * a no-op start does not bump revisions or send restart-triggering saves.
 */
export function mergeProfileSettings(
  settings: PanelSettingsView,
  invariants: ProfileInvariants,
  seed: boolean,
): MergedBlock[] {
  const merged: MergedBlock[] = [];
  const push = (
    block: string,
    revision: number,
    current: Record<string, unknown>,
    next: Record<string, unknown>,
  ): void => {
    if (same(current, next)) return;
    merged.push({ block, revision, value: next, changed: true });
  };

  // --- Source: workspace (repository identity is a platform invariant) ---
  {
    const current = sourceValue(settings, 'workspace');
    const config = record(current.config);
    const next = {
      ...current,
      enabled: true,
      config: { ...config, repository: invariants.repository },
    };
    push('source:workspace', sourceRevision(settings, 'workspace'), current, next);
  }

  // --- Source: github (repository + CLI are invariants, switches are owner's) ---
  {
    const current = sourceValue(settings, 'github');
    const config = record(current.config);
    const base = seed ? seedDefaults(config, GITHUB_DEFAULTS) : config;
    const next = {
      ...current,
      // First run turns the Source on; afterwards the owner's on/off choice wins,
      // so a deliberately disabled GitHub listener is not silently re-enabled.
      enabled: seed ? true : (current.enabled ?? true),
      config: { ...base, repository: invariants.repository, cli: invariants.githubCli },
    };
    push('source:github', sourceRevision(settings, 'github'), current, next);
  }

  // --- Policy (rules and admission are the owner's; allow-lists are platform) ---
  {
    const current = blockValue(settings, 'policy');
    const rules = Array.isArray(current.rules) ? current.rules : [];
    const sources = record(current.sources);
    const workspace = record(sources.workspace);
    const github = record(sources.github);
    const next = {
      ...current,
      rules,
      sources: {
        ...sources,
        workspace: {
          ...workspace,
          allowed: allowList(workspace.allowed, [invariants.ownerId]),
        },
        github: {
          ...github,
          allowed: allowList(github.allowed, invariants.githubAllowedUsers),
        },
      },
    };
    push('policy', blockRevision(settings, 'policy'), current, next);
  }

  // --- Executor (capacity, directory and prepare are platform; model is the owner's) ---
  {
    const current = blockValue(settings, 'executor');
    const base = seed
      ? {
          ...current,
          model: current.model ?? {
            provider: invariants.model.provider,
            model: invariants.model.model,
            ...(invariants.model.reasoningEffort
              ? { reasoningEffort: invariants.model.reasoningEffort }
              : {}),
          },
          blockedCommands: Array.isArray(current.blockedCommands) ? current.blockedCommands : [],
        }
      : current;
    const next = {
      ...base,
      maxWorkers: 1,
      directory: invariants.worktreeDir,
      prepare: invariants.prepare,
    };
    push('executor', blockRevision(settings, 'executor'), current, next);
  }

  // --- Eval (never overwritten after the first run) ---
  {
    const current = blockValue(settings, 'eval');
    if (seed) {
      const next = {
        ...current,
        ...seedDefaults(
          {
            mode: current.mode,
            timeoutSeconds: current.timeoutSeconds,
            model: current.model,
          },
          {
            ...EVAL_DEFAULTS,
            model: {
              provider: invariants.model.provider,
              model: invariants.model.model,
              reasoningEffort: 'low',
            },
          },
        ),
      };
      push('eval', blockRevision(settings, 'eval'), current, next);
    }
  }

  return merged;
}
