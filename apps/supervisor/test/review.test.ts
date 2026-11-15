import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectChanges,
  locateTicketWorktree,
  resolveCheckCommands,
  runChecks,
  type ReviewService,
} from '../src/review';
import { createReviewService } from '../src/review';
import { pidAlive } from '../src/process';

const directories: string[] = [];

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  directories.push(directory);
  return directory;
}

function git(directory: string, args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

/** A real git repository with one commit, a staged-free working tree. */
function repository(): string {
  const directory = temporary('moyu-review');
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.email', 'review@example.invalid']);
  git(directory, ['config', 'user.name', 'Review Test']);
  writeFileSync(join(directory, 'keep.txt'), 'one\ntwo\n');
  writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\n');
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'nested', 'old.txt'), 'old\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-q', '-m', 'initial commit']);
  return directory;
}

/** Raw kernel state of a pid: null when gone, 'Z' when it only waits to be reaped. */
function processState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] ?? null;
  } catch {
    return null;
  }
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe('supervisor review worktree resolution', () => {
  it('finds the single directory whose name ends with the ticket id prefix', () => {
    const root = temporary('moyu-worktrees');
    const profile = 'probe1';
    const ticketId = 'abcdef1234567890abcdef1234567890';
    const ticketDirectory = join(root, profile, `mp-fix-${ticketId.slice(0, 12)}`);
    mkdirSync(join(ticketDirectory, '.git'), { recursive: true });

    const found = locateTicketWorktree({ worktreeRoot: root, profile, ticketId });
    expect(found.state).toBe('available');
    expect(found.directory).toBe(ticketDirectory);

    const other = locateTicketWorktree({
      worktreeRoot: root,
      profile,
      ticketId: 'ffffffffffffffff',
    });
    expect(other.state).toBe('cleaned');
    expect(other.directory).toBeNull();
    expect(other.reason).toContain('已不存在');
  });

  it('reports a missing instance profile as unavailable, never as an empty diff', () => {
    const root = temporary('moyu-worktrees');
    const result = locateTicketWorktree({ worktreeRoot: root, profile: null, ticketId: 'abc' });
    expect(result.state).toBe('unavailable');
    expect(result.reason).toContain('实例');
  });

  it('refuses to guess when two directories match the same ticket id', () => {
    const root = temporary('moyu-worktrees');
    const profile = 'probe1';
    const ticketId = '0123456789abcdef';
    for (const name of [`one-${ticketId.slice(0, 12)}`, `two-${ticketId.slice(0, 12)}`]) {
      mkdirSync(join(root, profile, name, '.git'), { recursive: true });
    }
    const result = locateTicketWorktree({ worktreeRoot: root, profile, ticketId });
    expect(result.state).toBe('unavailable');
    expect(result.directory).toBeNull();
  });
});

/**
 * `worktreeRoot/<profile>` is the boundary the supervisor configured. A
 * directory the task created cannot redirect it outside that boundary, and a
 * refusal must not have read anything beyond it in the first place.
 */
describe('supervisor worktree boundary', () => {
  const ticketId = 'abcdef0123456789abcdef0123456789';
  const name = `mp-fix-${ticketId.slice(0, 12)}`;

  function ticketRoot(profile: string): string {
    const root = temporary('moyu-worktrees');
    mkdirSync(join(root, profile), { recursive: true });
    return root;
  }

  /** A directory outside the worktree root, with a sentinel and a fake worktree. */
  function outside(): string {
    const directory = temporary('moyu-outside');
    writeFileSync(join(directory, 'outside-sentinel.txt'), 'top secret\n');
    mkdirSync(join(directory, '.git'));
    return directory;
  }

  function expectRefused(result: ReturnType<typeof locateTicketWorktree>): void {
    expect(result.state).toBe('unavailable');
    expect(result.directory).toBeNull();
    expect(result.reason).toContain('边界');
    // The refusal must not have read the outside directory: neither the
    // sentinel name nor its content may surface in the result.
    expect(JSON.stringify(result)).not.toContain('outside-sentinel');
    expect(JSON.stringify(result)).not.toContain('top secret');
  }

  it('refuses a ticket directory symlinked outside the worktree root', () => {
    const root = ticketRoot('probe1');
    const secret = outside();
    symlinkSync(secret, join(root, 'probe1', name), 'dir');

    const result = locateTicketWorktree({ worktreeRoot: root, profile: 'probe1', ticketId });

    expectRefused(result);
    expect(result.reason).toContain(name);
  });

  it('refuses a profile directory symlinked outside the worktree root', () => {
    const root = temporary('moyu-worktrees');
    const secret = outside();
    mkdirSync(join(secret, name, '.git'), { recursive: true });
    symlinkSync(secret, join(root, 'probe1'), 'dir');

    const result = locateTicketWorktree({ worktreeRoot: root, profile: 'probe1', ticketId });

    expectRefused(result);
  });

  it('refuses a profile path that climbs out of the worktree root with ..', () => {
    const secret = outside();
    mkdirSync(join(secret, name, '.git'), { recursive: true });
    const root = temporary('moyu-worktrees');
    const profile = `../${basename(secret)}`;

    const result = locateTicketWorktree({ worktreeRoot: root, profile, ticketId });

    expectRefused(result);
  });

  it('refuses a symlink chain that reaches outside the worktree root', () => {
    const root = ticketRoot('probe1');
    const secret = outside();
    const links = temporary('moyu-links');
    symlinkSync(secret, join(links, 'second'), 'dir');
    symlinkSync(join(links, 'second'), join(links, 'first'), 'dir');
    symlinkSync(join(links, 'first'), join(root, 'probe1', name), 'dir');

    const result = locateTicketWorktree({ worktreeRoot: root, profile: 'probe1', ticketId });

    expectRefused(result);
  });

  it('still locates a real directory inside the worktree root', () => {
    const root = ticketRoot('probe1');
    const directory = join(root, 'probe1', name);
    mkdirSync(join(directory, '.git'), { recursive: true });

    const result = locateTicketWorktree({ worktreeRoot: root, profile: 'probe1', ticketId });

    expect(result.state).toBe('available');
    expect(result.directory).toBe(directory);
    expect(result.reason).toBeNull();
  });
});

describe('supervisor worktree diff', () => {
  it('reads a real git diff, including untracked, modified, deleted and renamed files', async () => {
    const directory = repository();
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(directory, 'keep.txt'), 'one\n');
    writeFileSync(join(directory, 'added.txt'), 'brand new\n');
    writeFileSync(join(directory, 'untracked.txt'), 'not staged yet\n');
    rmSync(join(directory, 'nested', 'old.txt'));
    writeFileSync(join(directory, 'nested', 'new.txt'), 'old\n');
    git(directory, ['add', 'nested/old.txt', 'nested/new.txt']);

    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });
    expect(changes.state).toBe('available');
    expect(changes.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(changes.commitSubject).toBe('initial commit');

    const byPath = new Map(changes.files.map((file) => [file.path, file]));
    expect(byPath.get('changed.txt')?.status).toBe('modified');
    expect(byPath.get('changed.txt')?.additions).toBe(1);
    expect(byPath.get('keep.txt')?.deletions).toBe(1);
    expect(byPath.get('untracked.txt')?.status).toBe('untracked');
    expect(byPath.get('untracked.txt')?.patch).toContain('+not staged yet');
    // numstat has no entry for an untracked file; the panel still reports the
    // real added line count taken from the patch.
    expect(byPath.get('untracked.txt')?.additions).toBe(1);

    // The panel content is exactly what git prints for the same file.
    const raw = git(directory, ['diff', 'HEAD', '--', 'changed.txt']);
    expect(byPath.get('changed.txt')?.patch).toBe(raw);
    expect(raw).toContain('+gamma');
  });

  it('reports no files for a clean worktree instead of inventing changes', async () => {
    const directory = repository();
    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });
    expect(changes.state).toBe('available');
    expect(changes.files).toEqual([]);
    expect(changes.additions).toBe(0);
    expect(changes.deletions).toBe(0);
  });

  it('marks a non-repository directory as unavailable with the git error', async () => {
    const directory = temporary('moyu-not-a-repo');
    const changes = await collectChanges({ directory, maxBytes: 4096, maxFiles: 10 });
    expect(changes.state).toBe('unavailable');
    expect(changes.reason).toContain('HEAD');
  });
});

/**
 * The task worktree is untrusted input. Its `.git` config and `.gitattributes`
 * belong to the task's own repository, so neither may be able to run a program
 * inside the supervisor, which holds the platform's instance state.
 */
describe('supervisor diff helper isolation', () => {
  /** An executable that records every run by appending to `sentinel`. */
  function helper(scratch: string, name: string, sentinel: string): string {
    const path = join(scratch, name);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf 'ran' >> '${sentinel}'\ncat "$2" 2>/dev/null || true\nexit 0\n`,
      { mode: 0o755 },
    );
    return path;
  }

  it('never runs an external diff command named by the task repository attributes', async () => {
    const directory = repository();
    const scratch = temporary('moyu-diff-helper');
    const sentinel = join(scratch, 'helper-ran');
    const command = helper(scratch, 'attribute-diff.sh', sentinel);
    writeFileSync(join(directory, '.gitattributes'), 'changed.txt diff=m6a-helper\n');
    git(directory, ['config', 'diff.m6a-helper.command', command]);
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');

    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });

    expect(existsSync(sentinel)).toBe(false);
    const changed = changes.files.find((file) => file.path === 'changed.txt');
    expect(changed?.status).toBe('modified');
    expect(changed?.patch).toContain('+gamma');
  });

  it('never runs a textconv command named by the task repository attributes', async () => {
    const directory = repository();
    const scratch = temporary('moyu-diff-helper');
    const sentinel = join(scratch, 'helper-ran');
    const command = helper(scratch, 'textconv.sh', sentinel);
    writeFileSync(join(directory, '.gitattributes'), 'changed.txt diff=m6a-helper\n');
    git(directory, ['config', 'diff.m6a-helper.textconv', command]);
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');

    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });

    expect(existsSync(sentinel)).toBe(false);
    expect(changes.files.find((file) => file.path === 'changed.txt')?.patch).toContain('+gamma');
  });

  it('ignores diff helpers inherited through the supervisor environment', async () => {
    const directory = repository();
    const scratch = temporary('moyu-diff-helper');
    const sentinel = join(scratch, 'helper-ran');
    const command = helper(scratch, 'inherited-diff.sh', sentinel);
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');

    const saved = {
      GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GIT_EXTERNAL_DIFF = command;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'diff.external';
    process.env.GIT_CONFIG_VALUE_0 = command;
    try {
      const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });
      expect(existsSync(sentinel)).toBe(false);
      expect(changes.files.find((file) => file.path === 'changed.txt')?.patch).toContain('+gamma');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('never runs a repository-configured fsmonitor program while reading status', async () => {
    const directory = repository();
    const scratch = temporary('moyu-diff-helper');
    const sentinel = join(scratch, 'helper-ran');
    const command = helper(scratch, 'fsmonitor.sh', sentinel);
    git(directory, ['config', 'core.fsmonitor', command]);
    writeFileSync(join(directory, 'changed.txt'), 'alpha\nbeta\ngamma\n');

    const changes = await collectChanges({ directory, maxBytes: 512 * 1024, maxFiles: 100 });

    expect(existsSync(sentinel)).toBe(false);
    expect(changes.files.find((file) => file.path === 'changed.txt')?.status).toBe('modified');
  });
});

describe('supervisor check runs', () => {
  it('keeps the real exit code, timestamps and output tail of each command', async () => {
    const directory = repository();
    const runs = await runChecks({
      directory,
      commands: [
        'node -e "console.log(\'first\'); process.exit(0)"',
        'node -e "console.error(\'broken type\'); process.exit(2)"',
      ],
      timeoutMs: 30_000,
      totalTimeoutMs: 60_000,
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ exitCode: 0, passed: true, summary: '通过' });
    expect(runs[0]?.output).toContain('first');
    expect(runs[1]).toMatchObject({ exitCode: 2, passed: false });
    expect(runs[1]?.output).toContain('broken type');
    expect(Date.parse(runs[1]!.finishedAt)).toBeGreaterThanOrEqual(Date.parse(runs[1]!.startedAt));
  });

  it('terminates a hung command and records the timeout', async () => {
    const directory = repository();
    const runs = await runChecks({
      directory,
      commands: ['sleep 5'],
      timeoutMs: 300,
      totalTimeoutMs: 60_000,
    });
    expect(runs[0]?.timedOut).toBe(true);
    expect(runs[0]?.passed).toBe(false);
    expect(runs[0]?.summary).toContain('超时');
  });

  it('passes only the documented whitelist to a check command', async () => {
    const directory = repository();
    const home = temporary('moyu-check-home');
    const tmp = temporary('moyu-check-tmp');
    const overrides: Record<string, string> = {
      HOME: home,
      TMPDIR: tmp,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      MOYU_SENTINEL_ALPHA: 'alpha-secret',
      MOYU_SENTINEL_BETA: 'beta-secret',
      MOYU_SENTINEL_GAMMA: 'gamma-secret',
    };
    const saved = new Map<string, string | undefined>();
    for (const key of Object.keys(overrides)) saved.set(key, process.env[key]);
    Object.assign(process.env, overrides);
    try {
      const runs = await runChecks({
        directory,
        commands: ['env'],
        timeoutMs: 30_000,
        totalTimeoutMs: 60_000,
      });
      const output = runs[0]!.output;
      for (const [key, value] of Object.entries(overrides)) {
        if (!key.startsWith('MOYU_SENTINEL_')) continue;
        // Boolean assertions keep the whole environment out of a failing run's
        // output, so a red log does not become a copy of the host environment.
        expect(output.includes(key)).toBe(false);
        expect(output.includes(value)).toBe(false);
      }
      // The whitelist itself must survive, so isolation does not break checks.
      // A login shell may rewrite PATH or LANG from /etc/profile; HOME, TMPDIR
      // and the contents of PATH are what this path controls.
      expect(output).toContain(`HOME=${home}`);
      expect(output).toContain(`TMPDIR=${tmp}`);
      expect(output).toContain(process.env.PATH);
      expect(output).toMatch(/^LANG=/m);
      expect(output).toMatch(/^LC_ALL=/m);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("kills a timed-out check command's whole process group", async () => {
    const directory = repository();
    const pidFile = join(temporary('moyu-check-group'), 'grandchild.pid');
    let pid = 0;
    try {
      const runs = await runChecks({
        directory,
        commands: [`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; sleep 60`],
        timeoutMs: 400,
        totalTimeoutMs: 60_000,
      });
      expect(runs[0]?.timedOut).toBe(true);
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(pid).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // /proc is the raw kernel view: absent or zombie both mean terminated.
      expect([null, 'Z']).toContain(processState(pid));
    } finally {
      if (pid > 0 && pidAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });

  it('bounds the whole run by the total budget, not just each command', async () => {
    const directory = repository();
    const runs = await runChecks({
      directory,
      commands: ['sleep 5', 'printf second'],
      timeoutMs: 60_000,
      totalTimeoutMs: 300,
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ passed: false, timedOut: true });
    expect(runs[1]).toMatchObject({
      passed: false,
      timedOut: true,
      exitCode: null,
      summary: '检查总时限已用完，命令未执行',
    });
    expect(runs[1]?.output).toBe('');
  });
});

describe('supervisor check identity', () => {
  const setpriv = '/usr/bin/setpriv';

  it('refuses root, the supervisor own uid/gid, and a missing setpriv', async () => {
    const directory = repository();
    const ownUid = process.getuid?.() ?? 1;
    const ownGid = process.getgid?.() ?? 1;
    const run = (identity: { uid: number; gid: number; home: string; setpriv: string }) =>
      runChecks({
        directory,
        commands: ['true'],
        timeoutMs: 5_000,
        totalTimeoutMs: 60_000,
        identity,
      });

    await expect(run({ uid: 0, gid: ownGid + 1, home: directory, setpriv })).rejects.toThrow(
      'root',
    );
    // Root already hit the root refusal above; the same-as-supervisor rule is
    // only observable for a non-root test process (CI runners are non-root).
    if (ownUid !== 0) {
      await expect(run({ uid: ownUid, gid: ownGid + 1, home: directory, setpriv })).rejects.toThrow(
        'uid 必须不同',
      );
    }
    if (ownGid !== 0) {
      await expect(run({ uid: 1, gid: ownGid, home: directory, setpriv })).rejects.toThrow(
        'gid 必须不同',
      );
    }
    await expect(
      run({ uid: 1, gid: 1, home: directory, setpriv: '/nonexistent/setpriv' }),
    ).rejects.toThrow('不存在');
  });

  it('refuses to run checks in production without a configured identity', async () => {
    await expect(
      runChecks({
        directory: repository(),
        commands: ['true'],
        timeoutMs: 5_000,
        totalTimeoutMs: 60_000,
        requireIsolated: true,
      }),
    ).rejects.toThrow('身份未配置');
  });

  it.skipIf(process.getuid?.() !== 0)(
    'runs a check as the configured uid and cannot read a root-owned 0600 sentinel',
    async () => {
      const directory = temporary('moyu-check-worktree');
      chmodSync(directory, 0o777);
      const home = temporary('moyu-check-home');
      chownSync(home, 65_534, 65_534);
      const sentinelDirectory = temporary('moyu-check-sentinel');
      chmodSync(sentinelDirectory, 0o755);
      const sentinel = join(sentinelDirectory, 'secret');
      writeFileSync(sentinel, 'supervisor-secret\n', { mode: 0o600 });

      const runs = await runChecks({
        directory,
        commands: [
          `id -u; id -g; grep -E 'CapEff' /proc/self/status; cat '${sentinel}'; echo sentinel-exit=$?`,
        ],
        timeoutMs: 10_000,
        totalTimeoutMs: 60_000,
        identity: { uid: 65_534, gid: 65_534, home, setpriv },
      });

      expect(runs[0]?.output).toMatch(/^65534$/m);
      expect(runs[0]?.output).toMatch(/CapEff:\s*0+\s*$/m);
      expect(runs[0]?.output).toMatch(/sentinel-exit=[1-9]/);
      expect(runs[0]?.output).not.toContain('supervisor-secret');
    },
  );
});

describe('repository check command resolution', () => {
  it('prefers repository commands and reports the source', () => {
    expect(
      resolveCheckCommands({
        repositoryCommands: ['npm test'],
        defaultCommands: ['pnpm check'],
      }),
    ).toEqual({ commands: ['npm test'], source: 'repository' });
  });

  it('falls back to the supervisor default only when the row has no override', () => {
    expect(
      resolveCheckCommands({
        repositoryCommands: null,
        defaultCommands: ['pnpm check'],
      }),
    ).toEqual({ commands: ['pnpm check'], source: 'default' });
    expect(
      resolveCheckCommands({
        repositoryCommands: undefined,
        defaultCommands: ['npm ci && npm test'],
      }),
    ).toEqual({ commands: ['npm ci && npm test'], source: 'default' });
  });

  it('fails closed on empty, malformed, multi-line or oversized repository values', () => {
    const invalid: unknown[] = [
      [],
      ['   '],
      ['echo first\necho second'],
      ['echo \u0000'],
      Array.from({ length: 9 }, (_, index) => `echo ${index}`),
      'npm test',
    ];
    for (const repositoryCommands of invalid) {
      expect(() =>
        resolveCheckCommands({ repositoryCommands, defaultCommands: ['pnpm check'] }),
      ).toThrow(/配置无效/);
    }
    try {
      resolveCheckCommands({ repositoryCommands: [], defaultCommands: ['pnpm check'] });
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(422);
    }
  });
});

describe('review service', () => {
  it('returns a cleaned state when the ticket worktree is gone', async () => {
    const root = temporary('moyu-worktrees');
    const config = {
      worktreeRoot: root,
      reviewDiffMaxBytes: 4096,
      reviewMaxFiles: 10,
      reviewCheckCommands: ['true'],
      reviewCheckTimeoutMs: 5_000,
      reviewCheckTotalTimeoutMs: 60_000,
    };
    const service: ReviewService = createReviewService({
      config: config as never,
      store: {
        getInstance: async () => ({ profile: 'probe1' }),
        getRepository: async () => ({ checkCommands: null }),
      } as never,
      logger: { info: () => undefined },
    });
    const changes = await service.changes('repository', 'deadbeefdeadbeef');
    expect(changes.state).toBe('cleaned');
    expect(changes.files).toEqual([]);
    await expect(service.checks('repository', 'deadbeefdeadbeef')).rejects.toThrow();
  });

  it('rejects a second check for the same repository instead of running two', async () => {
    const root = temporary('moyu-worktrees');
    const profile = 'probe1';
    const ticketId = 'abcdef0123456789';
    const directory = join(root, profile, `mp-fix-${ticketId.slice(0, 12)}`);
    mkdirSync(join(directory, '.git'), { recursive: true });
    const counter = join(temporary('moyu-check-counter'), 'runs.txt');
    const config = {
      worktreeRoot: root,
      reviewDiffMaxBytes: 4096,
      reviewMaxFiles: 10,
      reviewCheckCommands: [`printf x >> '${counter}'; sleep 0.3`],
      reviewCheckTimeoutMs: 5_000,
      reviewCheckTotalTimeoutMs: 60_000,
    };
    const service: ReviewService = createReviewService({
      config: config as never,
      store: {
        getInstance: async () => ({ profile }),
        getRepository: async () => ({ checkCommands: null }),
      } as never,
      logger: { info: () => undefined },
    });

    const first = service.checks('repository', ticketId);
    const second = service.checks('repository', ticketId);
    await expect(second).rejects.toThrow('该仓库已有检查正在运行，请等它结束');
    const runs = await first;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.passed).toBe(true);
    expect(readFileSync(counter, 'utf8')).toBe('x');
  });

  it('runs the repository commands reported by the store, not the global default', async () => {
    const root = temporary('moyu-worktrees');
    const profile = 'probe1';
    const ticketId = '1234567890abcdef';
    const directory = join(root, profile, `mp-repo-${ticketId.slice(0, 12)}`);
    mkdirSync(join(directory, '.git'), { recursive: true });
    const config = {
      worktreeRoot: root,
      reviewDiffMaxBytes: 4096,
      reviewMaxFiles: 10,
      reviewCheckCommands: ['printf global'],
      reviewCheckTimeoutMs: 5_000,
      reviewCheckTotalTimeoutMs: 60_000,
    };
    const service: ReviewService = createReviewService({
      config: config as never,
      store: {
        getInstance: async () => ({ profile }),
        getRepository: async () => ({ checkCommands: ['printf repository'] }),
      } as never,
      logger: { info: () => undefined },
    });

    const runs = await service.checks('repository', ticketId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.command).toBe('printf repository');
    expect(runs[0]?.output).toContain('repository');
  });
});
