#!/usr/bin/env node
/**
 * Failure cleanup for `stack.sh up`.
 *
 * When startup fails halfway, systemd transient units and bootstrap secrets can
 * be left behind. This module stops the units, removes the run secrets and
 * bridge credentials, then reads the state back and reports every leftover. The
 * command runner is injectable so the cleanup path can be proven without
 * starting the live matrix; the CLI is what stack.sh calls.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { IsolationGuardError, cleanOwnedDir, removeSecuredFile, resolveUser } from './guard.mjs';

export const SECRET_NAMES = ['supervisor-token', 'seed.env', 'state.env'];

export function defaultExec(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
}

function readState(exec, unit) {
  const result = exec('systemctl', ['is-active', unit]);
  return (result.stdout ?? '').trim() || 'unknown';
}

export function cleanupFailedUp({
  units,
  protectedDir,
  credentialsDir,
  instanceEnvDir,
  cgroupRoot,
  exec = defaultExec,
  uid = typeof process.getuid === 'function' ? process.getuid() : -1,
  user,
}) {
  const actions = [];
  const failures = [];
  for (const unit of units) {
    const stop = exec('systemctl', ['stop', unit]);
    actions.push(`stop ${unit} -> exit ${stop.status ?? 'error'}`);
    const reset = exec('systemctl', ['reset-failed', unit]);
    if (reset.status !== 0) actions.push(`reset-failed ${unit} -> exit ${reset.status}`);
  }
  for (const name of SECRET_NAMES) {
    if (!protectedDir || !existsSync(join(protectedDir, name))) continue;
    try {
      removeSecuredFile(protectedDir, name, { uid });
      actions.push(`removed secret ${join(protectedDir, name)}`);
    } catch (error) {
      failures.push(`could not remove ${join(protectedDir, name)}: ${error.message}`);
    }
  }
  if (cgroupRoot && existsSync(cgroupRoot)) {
    for (const entry of readdirSync(cgroupRoot)) {
      const cgroup = join(cgroupRoot, entry);
      try {
        if (statSync(cgroup).isDirectory() && existsSync(join(cgroup, 'cgroup.kill'))) {
          writeFileSync(join(cgroup, 'cgroup.kill'), '1');
          actions.push(`cgroup.kill ${cgroup}`);
        }
      } catch (error) {
        failures.push(`could not kill the instance cgroup ${cgroup}: ${error.message}`);
      }
    }
  }
  for (const [label, dir] of [
    ['bridge credentials', credentialsDir],
    ['instance env', instanceEnvDir],
  ]) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const removed = cleanOwnedDir(dir, { uid: user?.uid, gid: user?.gid });
      actions.push(`cleaned ${removed} ${label} file(s) from ${dir}`);
    } catch (error) {
      failures.push(`could not clean ${label} in ${dir}: ${error.message}`);
    }
  }
  // Read back the final state, including cleanup that silently did nothing.
  for (const unit of units) {
    const state = readState(exec, unit);
    if (state === 'active' || state === 'activating' || state === 'deactivating') {
      failures.push(`unit ${unit} is still ${state} after cleanup`);
    }
  }
  for (const name of SECRET_NAMES) {
    if (protectedDir && existsSync(join(protectedDir, name))) {
      failures.push(`secret ${name} still exists in ${protectedDir}`);
    }
  }
  if (cgroupRoot && existsSync(cgroupRoot)) {
    for (const entry of readdirSync(cgroupRoot)) {
      const cgroup = join(cgroupRoot, entry);
      try {
        const procs = existsSync(join(cgroup, 'cgroup.procs'))
          ? readFileSync(join(cgroup, 'cgroup.procs'), 'utf8').trim()
          : '';
        if (procs.length > 0) failures.push(`instance cgroup ${cgroup} still has processes`);
      } catch {
        failures.push(`could not read ${cgroup}/cgroup.procs`);
      }
    }
  }
  for (const [label, dir] of [
    ['bridge credential', credentialsDir],
    ['instance env', instanceEnvDir],
  ]) {
    if (!dir || !existsSync(dir)) continue;
    const leftover = readdirSync(dir).filter((entry) => {
      try {
        return statSync(join(dir, entry)).isFile();
      } catch {
        return false;
      }
    });
    if (leftover.length > 0) failures.push(`${leftover.length} ${label} file(s) remain in ${dir}`);
  }
  return { actions, failures };
}

function parseArgs(argv) {
  const flags = { unit: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new IsolationGuardError(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (key === 'unit') {
      if (next === undefined) throw new IsolationGuardError('--unit needs a value');
      flags.unit.push(next);
      index += 1;
      continue;
    }
    if (next === undefined || next.startsWith('--')) {
      throw new IsolationGuardError(`--${key} needs a value`);
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'cleanup-failed-up') {
    console.error('usage: node lifecycle.mjs cleanup-failed-up --user NAME --protected DIR ...');
    return 2;
  }
  const flags = parseArgs(rest);
  const user = flags.user ? resolveUser(flags.user) : null;
  const units = flags.unit ?? [];
  const result = cleanupFailedUp({
    units,
    protectedDir: flags.protected,
    credentialsDir: flags.credentials,
    instanceEnvDir: flags['instance-env'],
    cgroupRoot: flags['cgroup-root'],
    user,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  });
  for (const action of result.actions) console.log(`  cleanup: ${action}`);
  for (const failure of result.failures) console.error(`  cleanup FAILED: ${failure}`);
  if (result.failures.length === 0) {
    console.log('  cleanup verified: no unit or bootstrap secret left behind');
    return 0;
  }
  return 1;
}

const self = fileURLToPath(import.meta.url);
if (isAbsolute(process.argv[1] ?? '') && resolve(process.argv[1]) === self) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `lifecycle: ${error instanceof IsolationGuardError ? 'FAIL' : 'ERROR'}: ${error.message}`,
    );
    process.exitCode = 1;
  }
}
