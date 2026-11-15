/**
 * M5-B cgroup 冷启动与重启归属探针（Issue #41 / M5B-D02F07F-CGROUP-LIFECYCLE）。
 *
 * 只调用 supervisor 的真实实现，不 mock。同一份脚本可以跑在修复前后两个提交上：
 * 修复前缺少的导出（`cgroupBoundary` / `portOwners` / `ownedByRoot`）由本脚本的
 * 兜底实现替代，并如实判为 FAIL，而不是让脚本本身崩溃。
 *
 * 检验内容：
 *   1. 空白委托目录下冷启动：建根、启用 memory/pids、绑定实例并写入限额；
 *   2. 启动器握手后 runtime 与后代都在实例 cgroup 内，`memory.current` 可读；
 *   3. 停止后实例 cgroup 递归为空并被移除，端口释放；
 *   4. 逐代次核对 PID、cgroup inode、存活后代；路径被复用/对象被替换时的归属判定；
 *   5. 权限不足（非 root、未委托）时明确失败且不返回未计量的实例路径。
 */
import { mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const proc = await import('../../apps/supervisor/src/process');
const resources = await import('../../apps/supervisor/src/resources');

const {
  CGROUP_LAUNCHER,
  cgroupEmpty,
  cgroupPids,
  collectOwnership,
  ensureCgroup,
  identifyProcess,
  movePidToCgroup,
  pidAlive,
  portFree,
  removeCgroup,
  stopProcessTree,
} = proc;

const { applyInstanceMemoryLimit, limitsFromConfig, readMemorySample } = resources;

interface SetupResult {
  ok: boolean;
  path: string | null;
  inode: number | null;
  controllers: string[];
  step: string | null;
  error: string | null;
}

interface BoundaryResult {
  state: 'ok' | 'missing' | 'unreadable';
  path: string;
  inode: number | null;
}

const limits = limitsFromConfig({
  memoryTargetMb: 4096,
  memoryBudgetMb: 6144,
  memoryHardLimitMb: 8192,
  memoryReserveMb: 1024,
  memoryHysteresisMb: 256,
  instanceMemoryMaxMb: 512,
  instanceMemoryHighMb: 256,
  memoryPressureAvg10: 10,
});

const profile = `probe-${process.pid}-${Date.now()}`;
let failures = 0;

function emit(key: string, value: unknown): void {
  console.log(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function verdict(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`verdict ${name}=${ok ? 'pass' : 'FAIL'} ${detail}`);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function controllersOf(path: string): string[] {
  return (readText(join(path, 'cgroup.controllers')) ?? '').split(/\s+/).filter(Boolean);
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Normalizes both return shapes: the fix returns a setup object, the baseline a path or null. */
function normalizeSetup(raw: unknown): SetupResult {
  if (typeof raw === 'string') {
    return {
      ok: true,
      path: raw,
      inode: null,
      controllers: controllersOf(raw),
      step: null,
      error: null,
    };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, path: null, inode: null, controllers: [], step: null, error: null };
  }
  const value = raw as SetupResult;
  return { ...value, controllers: value.controllers ?? [] };
}

/** `cgroupBoundary` is part of the fix; the baseline only has the path. */
function boundaryOf(path: string): BoundaryResult {
  if (typeof proc.cgroupBoundary === 'function') return proc.cgroupBoundary(path);
  try {
    readFileSync(join(path, 'cgroup.procs'), 'utf8');
    return { state: 'ok', path, inode: statSync(path).ino };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: code === 'ENOENT' ? 'missing' : 'unreadable', path, inode: null };
  }
}

/** `portOwners`/`ownedByRoot` are part of the fix. */
function portOwnerPids(port: number): Array<{ pid: number; cgroup: string | null }> {
  if (typeof proc.portOwners !== 'function') return [];
  return proc.portOwners(port).map((owner) => ({ pid: owner.pid, cgroup: owner.cgroup }));
}

function isOwned(cgroup: string | null): boolean {
  if (typeof proc.ownedByRoot !== 'function') return false;
  return proc.ownedByRoot({ cgroup });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

/** Launches `sh` through the supervisor's fail-closed launcher and binds it. */
function launchBound(cgroup: string, body: string): { pid: number; release: () => void } {
  const child = spawn('/bin/sh', ['-c', CGROUP_LAUNCHER, 'moyu-probe', '/bin/sh', '-c', body], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const pid = child.pid;
  if (!pid) throw new Error('spawn returned no pid');
  if (!movePidToCgroup(cgroup, pid)) throw new Error('could not move the launcher into its cgroup');
  const release = child.stdio[3];
  if (!release || !('write' in release)) throw new Error('no release pipe');
  child.unref();
  return { pid, release: () => release.end('go\n') };
}

async function coldStart(): Promise<string | null> {
  const root = process.env.MOYU_CGROUP_ROOT ?? '';
  const parent = root.split('/').slice(0, -1).join('/');
  console.log(`## 1. 空白委托目录冷启动（MOYU_CGROUP_ROOT=${root}）`);
  emit('parent.exists_before', exists(parent));
  emit('parent.controllers_before', readText(join(parent, 'cgroup.controllers')));
  emit('parent.subtree_control_before', readText(join(parent, 'cgroup.subtree_control')));
  emit('root.exists_before', exists(root));
  const raw: unknown = ensureCgroup(profile);
  const setup = normalizeSetup(raw);
  emit('setup', raw);
  emit('root.created', exists(root));
  emit('parent.subtree_control_after', readText(join(parent, 'cgroup.subtree_control')));
  verdict('cold_start_ok', setup.ok, setup.error ?? 'root created and instance bound');
  if (!setup.ok || !setup.path) return null;
  const child = setup.path;
  emit('instance.controllers', controllersOf(child));
  verdict(
    'cold_start_enables_controllers',
    controllersOf(child).includes('memory') && controllersOf(child).includes('pids'),
    `controllers=[${controllersOf(child).join(' ')}]`,
  );
  verdict(
    'cold_start_binds_metering',
    readText(join(child, 'memory.current')) !== null &&
      readText(join(child, 'memory.max')) !== null,
    'memory.current and memory.max exist in the instance cgroup',
  );
  const applied = applyInstanceMemoryLimit(child, limits);
  emit('instance.limit_applied', applied);
  verdict('cold_start_applies_limit', applied.ok, applied.error ?? 'memory.max/high written');
  const sibling = join(root, 'sibling-check');
  mkdirSync(sibling, { recursive: true });
  emit('sibling.controllers', controllersOf(sibling));
  verdict(
    'cold_start_hands_controllers_down',
    controllersOf(sibling).includes('memory'),
    'a later sibling cgroup under the created root is metered too',
  );
  rmdirSync(sibling);
  return child;
}

async function generation(label: string, cgroup: string): Promise<void> {
  console.log(`## ${label}（${cgroup}）`);
  const launched = launchBound(
    cgroup,
    'set -e; sleep 300 >/dev/null 2>&1 & echo "child $!"; setsid sleep 300 >/dev/null 2>&1 & echo "setsid $!"; sleep 300',
  );
  const pid = launched.pid;
  launched.release();
  const started = await waitUntil(() => identifyProcess(pid) !== null, 3000);
  emit(`${label}.launched`, { pid, started });
  const identity = identifyProcess(pid);
  if (!identity) throw new Error('launcher did not start');
  const inode = statSync(cgroup).ino;
  const stored = {
    rootPid: pid,
    pgid: identity.pgid,
    cgroup,
    cgroupInode: inode,
    members: [identity],
  };
  await waitUntil(() => cgroupPids(cgroup).length >= 3, 3000);
  const snapshot = collectOwnership(pid, stored);
  const sample = readMemorySample(cgroup);
  emit(`${label}.identity`, {
    pid,
    startTime: identity.startTime,
    cgroup,
    cgroupInode: inode,
    boundary: boundaryOf(cgroup),
  });
  emit(
    `${label}.members`,
    snapshot.members.map((member) => `${member.pid}:${member.startTime}`),
  );
  emit(`${label}.unknown`, snapshot.unknown);
  emit(`${label}.memory_current`, sample.currentBytes);
  const descendants = snapshot.members.filter((member) => member.pid !== pid);
  verdict(
    `${label}_binds_descendants`,
    descendants.length >= 2,
    `descendants inside the instance cgroup: [${descendants.map((m) => m.pid).join(' ')}]`,
  );
  verdict(`${label}_metered`, (sample.currentBytes ?? 0) > 0, 'memory.current > 0');
  verdict(
    `${label}_inode_matches`,
    snapshot.cgroupInode === inode && !snapshot.unknown,
    `recorded inode ${inode} vs boundary ${String(boundaryOf(cgroup).inode)}`,
  );
  // A listener inside the instance cgroup is provably ours.
  const port = await freePort();
  const listener = spawn(
    '/usr/bin/node',
    ['-e', `require('net').createServer((socket) => socket.end()).listen(${port}, '127.0.0.1')`],
    { detached: true, stdio: 'ignore' },
  );
  if (!listener.pid) throw new Error('no listener pid');
  movePidToCgroup(cgroup, listener.pid);
  await waitUntil(() => portOwnerPids(port).length > 0, 3000);
  const owners = portOwnerPids(port);
  emit(`${label}.port_owners`, owners);
  verdict(
    `${label}_port_owner_identified`,
    owners.some((owner) => owner.pid === listener.pid),
    `port ${port} owner resolved from /proc (expected pid ${listener.pid})`,
  );
  verdict(
    `${label}_port_owner_is_managed`,
    owners.some((owner) => owner.pid === listener.pid && isOwned(owner.cgroup)),
    `port ${port} owner is inside the boundary`,
  );
  verdict(
    `${label}_foreign_owner_not_managed`,
    !isOwned('/sys/fs/cgroup/system.slice/unrelated.service'),
    'a listener outside the root is never treated as ours',
  );
  process.kill(listener.pid, 'SIGKILL');
  const result = await stopProcessTree(pid, 5000, stored);
  emit(`${label}.stop`, {
    stopped: result.stopped,
    unknown: result.unknown,
    boundary: result.boundary ?? null,
    remaining: result.remaining.length,
  });
  emit(
    `${label}.remaining_alive`,
    result.remaining.filter((member) => pidAlive(member.pid)).map((member) => member.pid),
  );
  const treeAfter = cgroupEmpty(cgroup);
  const removed = !exists(cgroup);
  emit(`${label}.after_stop`, { pids: cgroupPids(cgroup), tree: treeAfter, removed });
  verdict(
    `${label}_recursive_empty`,
    removed || (treeAfter.ok && treeAfter.empty),
    removed
      ? 'the instance cgroup was removed after the last member exited'
      : `pids=[${cgroupPids(cgroup).join(' ')}]`,
  );
  verdict(`${label}_port_released`, await portFree(port), `port ${port} is free after the stop`);
  const after = collectOwnership(pid, stored);
  emit(`${label}.after_stop_ownership`, { unknown: after.unknown, cgroup: after.cgroup ?? null });
  verdict(
    `${label}_not_wedged`,
    !after.unknown,
    'a dissolved boundary with no live member is not "unknown ownership" that blocks capacity',
  );
}

/** Restart semantics: the recorded inode must match the object, a replacement must not. */
async function restartChecks(): Promise<void> {
  console.log('## 4. 重启后的边界核对（对象仍在 / 路径被复用）');
  const setup = normalizeSetup(ensureCgroup(`restart-${process.pid}-${Date.now()}`));
  if (!setup.ok || !setup.path) {
    verdict('restart_setup', false, setup.error ?? 'no cgroup');
    return;
  }
  const path = setup.path;
  const firstInode = statSync(path).ino;
  const stored = {
    rootPid: 4000000,
    pgid: 4000000,
    cgroup: path,
    cgroupInode: firstInode,
    members: [],
  };
  const matched = collectOwnership(4000000, stored);
  emit('restart.recorded_inode', firstInode);
  emit('restart.boundary', boundaryOf(path));
  verdict(
    'restart_inode_matches',
    matched.cgroupInode === firstInode && !matched.unknown,
    'a restart that finds the same inode keeps the boundary proven',
  );
  // Remove the (empty) object and recreate the same path: the inode changes, so a
  // stale record must not be treated as the same boundary.
  rmdirSync(path);
  mkdirSync(path, { recursive: true });
  const secondInode = statSync(path).ino;
  emit('restart.replacement_inode', secondInode);
  const replaced = collectOwnership(4000000, stored);
  emit('restart.replaced_ownership', {
    unknown: replaced.unknown,
    cgroup: replaced.cgroup ?? null,
  });
  verdict(
    'restart_replacement_detected',
    secondInode !== firstInode && replaced.unknown === true,
    'a different inode at the same path is unknown ownership, never the old boundary',
  );
  removeCgroup(path);
}

async function nonRoot(): Promise<void> {
  console.log('## 权限不足场景（非 root + 未委托目录）');
  const root = process.env.MOYU_CGROUP_ROOT ?? '';
  emit('nonroot.uid', typeof process.getuid === 'function' ? process.getuid() : null);
  const raw: unknown = ensureCgroup(profile);
  const setup = normalizeSetup(raw);
  emit('nonroot.setup', raw);
  verdict(
    'nonroot_no_unmetered_instance',
    !setup.ok && setup.path === null,
    'no instance path is handed back, so nothing can be started outside the boundary',
  );
  verdict(
    'nonroot_actionable_reason',
    !setup.ok && setup.step !== null && typeof setup.error === 'string' && setup.error.length > 0,
    `a failing step and the OS error are reported for ${root} (got step=${String(setup.step)})`,
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'full';
  if (mode === 'nonroot') {
    await nonRoot();
    console.log(`## 判定：${failures === 0 ? '全部通过' : `${failures} 项不通过`}`);
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }
  const cgroup = await coldStart();
  if (cgroup) {
    await generation('gen1', cgroup);
    const second = normalizeSetup(ensureCgroup(`gen2-${process.pid}-${Date.now()}`));
    emit('gen2.setup', second);
    if (second.ok && second.path) await generation('gen2', second.path);
    else verdict('gen2_cold_start', false, second.error ?? 'no cgroup');
    await restartChecks();
  }
  console.log(`## 判定：${failures === 0 ? '全部通过' : `${failures} 项不通过`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
