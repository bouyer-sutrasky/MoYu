#!/usr/bin/env node
/**
 * Baseline reproduction for M6-C A: the current task prepare command clones the
 * whole repository from the remote once per ticket, and an interrupted launch
 * can leave a non-empty task directory that the next launch treats as already
 * prepared (the Executor only removes an empty directory after a failure).
 *
 * The transport is a local bare repository so no GitHub credentials or network
 * are involved. The interrupted clone is killed hard (SIGKILL) during checkout:
 * that is the worst case an AbortSignal timeout can leave behind, and the
 * directory it leaves is what the baseline retry path sees.
 *
 *   node scripts/m6c/repo-prepare-repro.mjs [workdir]
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'moyu-repo-prepare-repro-'));
const origin = join(workdir, 'origin.git');
const seed = join(workdir, 'seed');
const run = (cwd, argv) => execFileSync('git', argv, { cwd, encoding: 'utf8' }).trim();
const timed = (started) => Number(process.hrtime.bigint() - started) / 1e6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(workdir, { recursive: true });
run(workdir, ['init', '--bare', '--initial-branch=main', origin]);
run(workdir, ['init', '--initial-branch=main', seed]);
run(seed, ['config', 'user.name', 'MoYu Repro']);
run(seed, ['config', 'user.email', 'repro@example.invalid']);
// Large enough that checkout is still running when the interruption lands.
for (let commit = 1; commit <= 20; commit += 1) {
  for (let file = 0; file < 60; file += 1) {
    writeFileSync(
      join(seed, `payload-${commit}-${file}.txt`),
      `commit ${commit} file ${file}\n${'x'.repeat(16 * 1024)}\n`,
    );
  }
  run(seed, ['add', '.']);
  run(seed, ['commit', '-m', `seed ${commit}`]);
}
run(seed, ['remote', 'add', 'origin', origin]);
run(seed, ['push', '-q', 'origin', 'main']);
const commit = run(seed, ['rev-parse', 'HEAD']);

/** What the baseline prepare command does for one task: a fresh full clone, then the frozen commit. */
function baselineTaskClone(name) {
  const dest = join(workdir, name);
  const started = process.hrtime.bigint();
  run(workdir, ['clone', '--no-tags', origin, dest]);
  run(dest, ['-c', 'advice.detachedHead=false', 'checkout', commit]);
  const durationMs = timed(started);
  return {
    name,
    durationMs: Math.round(durationMs),
    bytes: Number(statSync(dest).size),
    objects: run(dest, ['count-objects', '-v']),
    head: run(dest, ['rev-parse', 'HEAD']),
  };
}

const first = baselineTaskClone('task-a');
const second = baselineTaskClone('task-b');

/**
 * Interrupt a third full clone once Git has started writing the checkout, as a
 * launch timeout can. `timeout`/AbortSignal normally sends SIGTERM first; the
 * hard kill proves the directory is not safe to reuse even then.
 */
const interruptedDir = join(workdir, 'task-timeout');
const child = spawn('git', ['clone', '--no-tags', origin, interruptedDir], { stdio: 'ignore' });
let sawFiles = 0;
const started = process.hrtime.bigint();
for (let wait = 0; wait < 500; wait += 1) {
  try {
    sawFiles = readdirSync(interruptedDir).length;
  } catch {
    sawFiles = 0;
  }
  if (sawFiles > 0) break;
  await sleep(2);
}
child.kill('SIGKILL');
await new Promise((resolve) => child.once('exit', resolve));
const interruptedMs = Math.round(timed(started));
const leftBehind = (() => {
  try {
    return statSync(interruptedDir).isDirectory();
  } catch {
    return false;
  }
})();
let leftFiles = 0;
try {
  leftFiles = readdirSync(interruptedDir).length;
} catch {
  leftFiles = 0;
}
let usable = false;
try {
  usable = run(interruptedDir, ['rev-parse', 'HEAD']) === commit;
} catch {
  usable = false;
}

const report = {
  workdir,
  origin,
  commit,
  tasks: [first, second],
  duplicateFullClone:
    first.objects === second.objects && first.bytes === second.bytes && first.bytes > 0,
  interruptedClone: {
    durationMs: interruptedMs,
    filesWrittenBeforeKill: sawFiles,
    directoryLeftBehind: leftBehind,
    filesLeftBehind: leftFiles,
    usableGitCheckout: usable,
    // DshExecutor only removes an empty directory after a failed prepare and
    // otherwise treats any existing directory as prepared, so this leftover is
    // handed to the next worker as though the workspace were complete.
    retryWouldTreatItAsPrepared: leftBehind && leftFiles > 0 && !usable,
  },
};

console.log(JSON.stringify(report, null, 2));
if (!process.argv[2]) rmSync(workdir, { recursive: true, force: true });
