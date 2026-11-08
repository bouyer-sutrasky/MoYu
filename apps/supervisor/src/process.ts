import { createConnection } from 'node:net';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { readMemorySample } from './resources';

export async function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (free: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(600);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
  });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ProcessIdentity {
  pid: number;
  /** Kernel start time in clock ticks; identifies a PID even after reuse. */
  startTime: string;
  pgid: number;
  sid: number;
  command: string;
}

export interface ProcessOwnershipSnapshot {
  rootPid: number | null;
  pgid: number | null;
  members: ProcessIdentity[];
  /** Ownership cannot be proven for at least one live process boundary. */
  unknown: boolean;
  /** Live members that cannot be tied to the saved identity. */
  unknownMembers: ProcessIdentity[];
  /** State of the saved execution boundary: `none` when no cgroup was ever recorded. */
  cgroup: 'ok' | 'missing' | 'unreadable' | 'none';
  cgroupInode: number | null;
}

export interface StoredOwnership {
  execution?: {
    ticketId: string;
    assignmentId: string;
    leaseId: string;
    fencingToken: string;
  } | null;
  rootPid?: number | null;
  pgid?: number | null;
  cgroup?: string | null;
  /** Inode of the cgroup object that was created for this generation. */
  cgroupInode?: number | null;
  /** Discovery-only callers without a persisted boundary may accept best-effort. */
  allowUnproven?: boolean;
  /** Adopted outside a pre-existing cgroup; historical descendants are unproven. */
  adoptedUnproven?: boolean;
  members?: Array<Partial<ProcessIdentity> & { pid?: number; startTime?: string }>;
}

export interface StopProcessResult {
  stopped: boolean;
  rootPid: number;
  pgid: number | null;
  remaining: ProcessIdentity[];
  /** The saved group still has live members we cannot prove are ours. */
  unknown: boolean;
  /** What the saved execution boundary looked like at the final check. */
  boundary: CgroupBoundaryState | 'none';
}

interface ProcStat {
  startTime: string;
  pgid: number;
  sid: number;
}

function readProcStat(pid: number): ProcStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces and parentheses; fields after the last ')' are stable.
    const tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    const startTime = tail[19];
    const pgid = Number(tail[2]);
    const sid = Number(tail[3]);
    if (!startTime) return null;
    return {
      startTime,
      pgid: Number.isFinite(pgid) ? pgid : pid,
      sid: Number.isFinite(sid) ? sid : pid,
    };
  } catch {
    return null;
  }
}

function readCommand(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.replaceAll('\0', ' ').trim();
  } catch {
    return '';
  }
}

export function identifyProcess(pid: number): ProcessIdentity | null {
  if (!pidAlive(pid)) return null;
  const stat = readProcStat(pid);
  if (!stat) return null;
  return {
    pid,
    startTime: stat.startTime,
    pgid: stat.pgid,
    sid: stat.sid,
    command: readCommand(pid),
  };
}

export function processStartTime(pid: number): string | null {
  return readProcStat(pid)?.startTime ?? null;
}

export function processGroupOf(pid: number): number | null {
  return readProcStat(pid)?.pgid ?? null;
}

/** Reads direct children from /proc; DSH's own workers are sessions, not child processes. */
export function childPids(pid: number): number[] {
  const children: number[] = [];
  try {
    for (const task of readdirSync(`/proc/${pid}/task`)) {
      try {
        const raw = readFileSync(join('/proc', String(pid), 'task', task, 'children'), 'utf8');
        for (const value of raw.trim().split(/\s+/)) {
          if (value) children.push(Number(value));
        }
      } catch {
        // A task exited between readdir and read.
      }
    }
  } catch {
    return [];
  }
  return [...new Set(children)].filter((child) => Number.isInteger(child) && child > 1);
}

function identityKey(identity: Pick<ProcessIdentity, 'pid' | 'startTime'>): string {
  return `${identity.pid}:${identity.startTime}`;
}

function identityAlive(identity: Pick<ProcessIdentity, 'pid' | 'startTime'>): boolean {
  if (!pidAlive(identity.pid)) return false;
  const current = processStartTime(identity.pid);
  return current !== null && current === identity.startTime;
}

/** All live processes in a process group, including a child that outlived its parent. */
export function groupMembers(pgid: number): ProcessIdentity[] {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  const members: ProcessIdentity[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const identity = identifyProcess(pid);
    if (identity && identity.pgid === pgid) members.push(identity);
  }
  return members;
}

function normalizeStored(stored: StoredOwnership | undefined): ProcessIdentity[] {
  const result: ProcessIdentity[] = [];
  for (const member of stored?.members ?? []) {
    if (!member || typeof member.pid !== 'number' || typeof member.startTime !== 'string') {
      continue;
    }
    if (!identityAlive({ pid: member.pid, startTime: member.startTime })) continue;
    const current = identifyProcess(member.pid);
    if (current) result.push(current);
  }
  return result;
}

/**
 * Accepts a root only when its saved start time still matches. A live PID with
 * a different start time is a reused PID and must never be signalled.
 */
function verifiedRoot(rootPid: number, stored?: StoredOwnership): ProcessIdentity | null {
  const current = identifyProcess(rootPid);
  if (!current) return null;
  if (!stored) return current;
  const saved = (stored.members ?? []).find(
    (member) => member?.pid === rootPid && typeof member.startTime === 'string',
  );
  if (!saved || saved.startTime !== current.startTime) return null;
  return current;
}

export const CGROUP_ROOT = process.env.MOYU_CGROUP_ROOT ?? '/sys/fs/cgroup/moyu-supervisor';

const CGROUP_MOUNT = '/sys/fs/cgroup';

/** Controllers the per-instance boundary needs: metering, limits and a pid cap. */
const REQUIRED_CONTROLLERS = ['memory', 'pids'] as const;

export type CgroupStep = 'root' | 'controllers' | 'instance' | 'verify';

export interface CgroupSetup {
  ok: boolean;
  /** The root the instance cgroup was created in. */
  root: string;
  /** The per-instance cgroup, only set when `ok` is true. */
  path: string | null;
  inode: number | null;
  controllers: string[];
  /** Which step failed; null on success. */
  step: CgroupStep | null;
  error: string | null;
}

export type CgroupBoundaryState = 'ok' | 'missing' | 'unreadable';

export interface CgroupBoundary {
  state: CgroupBoundaryState;
  path: string;
  inode: number | null;
}

function readCgroupSet(path: string): Set<string> | null {
  try {
    return new Set(readFileSync(path, 'utf8').split(/\s+/).filter(Boolean));
  } catch {
    return null;
  }
}

function controllerSet(path: string): Set<string> | null {
  return readCgroupSet(join(path, 'cgroup.controllers'));
}

function subtreeSet(path: string): Set<string> | null {
  return readCgroupSet(join(path, 'cgroup.subtree_control'));
}

/**
 * Inspects one saved execution boundary. `missing` and `unreadable` are kept
 * apart: a removed boundary object is history that can be proven empty, while
 * an unreadable one is still unknown ownership.
 */
export function cgroupBoundary(path: string | null | undefined): CgroupBoundary {
  if (!path) return { state: 'missing', path: '', inode: null };
  let inode: number | null = null;
  try {
    inode = statSync(path).ino;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      state: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable',
      path,
      inode,
    };
  }
  if (readCgroupSet(join(path, 'cgroup.procs')) == null) {
    return { state: 'unreadable', path, inode };
  }
  return { state: 'ok', path, inode };
}

function cgroupSetupFailure(root: string, step: CgroupStep, error: string): CgroupSetup {
  return { ok: false, root, path: null, inode: null, controllers: [], step, error };
}

/**
 * Enables `wanted` in `dir/cgroup.subtree_control`. The kernel refuses this for
 * a cgroup that still has its own processes (EBUSY), so a successful write also
 * proves the delegated level is empty.
 */
function enableAt(
  dir: string,
  wanted: string[],
): { ok: boolean; enabled: string[]; error: string | null } {
  const current = subtreeSet(dir);
  if (current == null)
    return { ok: false, enabled: [], error: `cgroup.subtree_control is not readable: ${dir}` };
  const missing = wanted.filter((controller) => !current.has(controller));
  if (missing.length === 0) return { ok: true, enabled: [], error: null };
  try {
    writeFileSync(
      join(dir, 'cgroup.subtree_control'),
      missing.map((controller) => `+${controller}`).join(' '),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      enabled: [],
      error: `cannot enable ${missing.join('+')} in ${dir}/cgroup.subtree_control: ${message}`,
    };
  }
  const after = subtreeSet(dir) ?? new Set<string>();
  const stillMissing = wanted.filter((controller) => !after.has(controller));
  if (stillMissing.length > 0) {
    return {
      ok: false,
      enabled: [...after],
      error: `${dir}/cgroup.subtree_control still lacks ${stillMissing.join('+')} after enabling`,
    };
  }
  return { ok: true, enabled: missing, error: null };
}

/**
 * Prepares the configured cgroup root on a blank delegated directory and
 * creates one per-instance cgroup inside it.
 *
 * A freshly delegated directory usually has the controllers *available* but not
 * yet enabled in its own `cgroup.subtree_control`; until then a child cgroup
 * gets no `memory.max`, so the instance could neither be metered nor limited.
 * The root therefore has to be created and enabled here instead of depending on
 * an operator (or a fixture) pre-creating it. Enabling is attempted on the root
 * and, when the controller is not yet offered there, on its immediate parent —
 * the delegated unit cgroup. Nothing above the parent is touched, and the kernel
 * refuses a level that still has processes, so no other cgroup is modified.
 */
export function ensureCgroup(profile: string, root: string = CGROUP_ROOT): CgroupSetup {
  if (root === CGROUP_MOUNT) {
    return cgroupSetupFailure(
      root,
      'root',
      `refusing to use the cgroup v2 mount root ${CGROUP_MOUNT} as MOYU_CGROUP_ROOT`,
    );
  }
  if (!root.startsWith(`${CGROUP_MOUNT}/`)) {
    return cgroupSetupFailure(
      root,
      'root',
      `MOYU_CGROUP_ROOT ${root} must be inside the cgroup v2 mount ${CGROUP_MOUNT}`,
    );
  }
  try {
    // The root, and any missing delegated ancestor, is created here. A blank
    // delegation therefore works without a pre-created directory.
    mkdirSync(root, { recursive: true, mode: 0o755 });
  } catch (error) {
    return cgroupSetupFailure(
      root,
      'root',
      `cannot create the cgroup root ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parent = dirname(root);
  let offered = controllerSet(root);
  if (offered == null) {
    return cgroupSetupFailure(
      root,
      'controllers',
      `cgroup.controllers is not readable under ${root}`,
    );
  }
  const missing = REQUIRED_CONTROLLERS.filter((controller) => !offered?.has(controller));
  if (missing.length > 0) {
    if (parent === CGROUP_MOUNT || parent === root) {
      return cgroupSetupFailure(
        root,
        'controllers',
        `${root} does not offer ${missing.join('+')} and there is no delegated parent to enable it in`,
      );
    }
    const available = controllerSet(parent);
    const notOffered = missing.filter((controller) => !available?.has(controller));
    if (notOffered.length > 0) {
      return cgroupSetupFailure(
        root,
        'controllers',
        `${parent} does not offer ${notOffered.join('+')}; delegate ${REQUIRED_CONTROLLERS.join('+')} to the supervisor unit (systemd Delegate=yes)`,
      );
    }
    const enabledAtParent = enableAt(parent, missing);
    if (!enabledAtParent.ok) {
      return cgroupSetupFailure(
        root,
        'controllers',
        `${enabledAtParent.error}; a delegated level that still has its own processes cannot hand controllers down (use systemd DelegateSubgroup= so the supervisor does not sit in the delegated cgroup)`,
      );
    }
    offered = controllerSet(root) ?? new Set<string>();
    const stillMissing = REQUIRED_CONTROLLERS.filter((controller) => !offered?.has(controller));
    if (stillMissing.length > 0) {
      return cgroupSetupFailure(
        root,
        'controllers',
        `${parent} accepted the hand-down but ${root} still lacks ${stillMissing.join('+')}`,
      );
    }
  }
  const atRoot = enableAt(root, [...REQUIRED_CONTROLLERS]);
  if (!atRoot.ok) {
    return cgroupSetupFailure(
      root,
      'controllers',
      atRoot.error ?? `cannot enable controllers in ${root}`,
    );
  }

  const path = join(root, profile.replaceAll(/[^a-zA-Z0-9_.-]/g, '-'));
  try {
    mkdirSync(path, { recursive: true, mode: 0o755 });
  } catch (error) {
    return cgroupSetupFailure(
      root,
      'instance',
      `cannot create the instance cgroup ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const controllers = controllerSet(path);
  if (controllers == null) {
    return cgroupSetupFailure(root, 'verify', `the instance cgroup ${path} is not readable`);
  }
  if (!controllers.has('memory')) {
    return cgroupSetupFailure(
      root,
      'verify',
      `the instance cgroup ${path} did not receive the memory controller (controllers: ${[...controllers].join(' ') || 'none'}); its memory could not be measured or limited`,
    );
  }
  // The child only has these pseudo-files when the controllers are really bound.
  for (const file of ['memory.current', 'memory.max', 'pids.current']) {
    if (!existsSync(join(path, file))) {
      return cgroupSetupFailure(
        root,
        'verify',
        `the instance cgroup ${path} is missing ${file}; the controllers are not bound to it`,
      );
    }
  }
  let inode: number | null = null;
  try {
    inode = statSync(path).ino;
  } catch (error) {
    return cgroupSetupFailure(
      root,
      'verify',
      `cannot stat the instance cgroup ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    ok: true,
    root,
    path,
    inode,
    controllers: [...controllers],
    step: null,
    error: null,
  };
}

/** The launcher accepts only the parent's exact positive release; EOF and errors exit before exec. */
export const CGROUP_LAUNCHER =
  'IFS= read -r go <&3 || exit 126; [ "$go" = go ] || exit 127; exec "$@"';

/** True when the cgroup's measured `memory.events` report an OOM kill. */
export function cgroupOomKilled(path: string | null | undefined): boolean {
  return (readMemorySample(path).events.oom_kill ?? 0) > 0;
}

export function movePidToCgroup(path: string, pid: number): boolean {
  try {
    writeFileSync(join(path, 'cgroup.procs'), String(pid));
    return true;
  } catch {
    return false;
  }
}

export function cgroupTree(path: string): { ok: boolean; pids: number[]; populated: boolean } {
  const pids: number[] = [];
  const stack = [path];
  let ok = true;
  let populated = false;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    try {
      const raw = readFileSync(join(dir, 'cgroup.procs'), 'utf8');
      for (const value of raw.split(/\s+/)) {
        const pid = Number(value);
        if (Number.isInteger(pid) && pid > 1) pids.push(pid);
      }
      try {
        const events = readFileSync(join(dir, 'cgroup.events'), 'utf8');
        if (/^populated\s+1$/m.test(events)) populated = true;
      } catch {
        ok = false;
      }
      for (const entry of readdirSync(dir)) {
        const child = join(dir, entry);
        try {
          if (lstatSync(child).isDirectory()) stack.push(child);
        } catch {
          ok = false;
        }
      }
    } catch {
      ok = false;
    }
  }
  const unique = [...new Set(pids)];
  // `populated` covers nested descendants; an unreadable member is not empty.
  if (populated && unique.length === 0) ok = false;
  return { ok, pids: unique, populated };
}

export function cgroupPids(path: string): number[] {
  return cgroupTree(path).pids;
}

export function cgroupEmpty(path: string): { ok: boolean; empty: boolean } {
  const tree = cgroupTree(path);
  return { ok: tree.ok, empty: tree.ok && !tree.populated && tree.pids.length === 0 };
}

export function removeCgroup(path: string | null | undefined): void {
  if (!path) return;
  try {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      try {
        if (statSync(child).isDirectory()) removeCgroup(child);
      } catch {
        // Pseudo-files are expected here.
      }
    }
    if (cgroupPids(path).length === 0) rmdirSync(path);
  } catch {
    // A non-empty or partially removed cgroup is kept for a later retry.
  }
}

/** Processes in the saved session, even when they changed process group with setpgid. */
export function sessionMembers(sid: number): ProcessIdentity[] {
  if (!Number.isInteger(sid) || sid <= 1) return [];
  const members: ProcessIdentity[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const identity = identifyProcess(Number(entry));
    if (identity && identity.sid === sid) members.push(identity);
  }
  return members;
}

/**
 * Captures the root process, its owned process groups, and every descendant.
 * Start times are compared before a PID or PGID is accepted. When the root has
 * already died, a saved root identity lets us find children that were created
 * between snapshots and inherited its session; group members that cannot be
 * tied to that session are reported as unknown instead of being signalled.
 */
export function collectOwnership(
  rootPid: number,
  stored?: StoredOwnership,
): ProcessOwnershipSnapshot {
  const byKey = new Map<string, ProcessIdentity>();
  const add = (identity: ProcessIdentity | null | undefined) => {
    if (!identity) return;
    byKey.set(identityKey(identity), identity);
  };

  const root = verifiedRoot(rootPid, stored);
  const savedRoot = (stored?.members ?? []).find(
    (member) => member?.pid === rootPid && typeof member.startTime === 'string',
  );
  add(root);
  const normalized = normalizeStored(stored);
  for (const member of normalized) add(member);

  const unknownMembers: ProcessIdentity[] = [];
  const cgroup = stored?.cgroup ?? null;
  const boundary = cgroupBoundary(cgroup);
  const tree = boundary.state === 'ok' ? cgroupTree(boundary.path) : null;
  // A readable tree is required: a partially unreadable subtree could hide a
  // member that a stop would then wrongly call gone.
  const cgroupReadable = boundary.state === 'ok' && tree?.ok === true;
  if (cgroupReadable && tree) {
    for (const pid of tree.pids) add(identifyProcess(pid));
  }
  // A cgroup path is reusable: only the recorded inode proves this is still the
  // boundary object created for this generation.
  const boundaryReplaced =
    boundary.state === 'ok' &&
    typeof stored?.cgroupInode === 'number' &&
    boundary.inode !== stored.cgroupInode;
  const ownedGroups = new Set<number>();
  if (root) ownedGroups.add(root.pgid);
  for (const member of normalized) ownedGroups.add(member.pgid);
  const rootReused = !root && pidAlive(rootPid);
  if (!root && !rootReused && savedRoot && typeof savedRoot.pgid === 'number') {
    // The root may have forked a child after the last snapshot and then died.
    // Scan its old group, but only accept members in the root's session; a
    // reused PGID from an unrelated service must not be killed.
    ownedGroups.add(savedRoot.pgid);
  }
  if (rootReused && savedRoot && typeof savedRoot.pgid === 'number') {
    // The root PID has been reused. We cannot prove the old group is ours, so
    // report its members as unknown and never signal them.
    for (const member of groupMembers(savedRoot.pgid)) unknownMembers.push(member);
  }
  if (!stored && rootPid > 1) {
    // Discovery-only calls (tests, descendants()) have no persisted identity.
    ownedGroups.add(rootPid);
  }
  if (savedRoot && typeof savedRoot.sid === 'number' && (!root || !pidAlive(rootPid))) {
    for (const member of sessionMembers(savedRoot.sid)) {
      if (member.pid !== rootPid) add(member);
    }
  }
  if (
    !cgroup &&
    !root &&
    savedRoot &&
    typeof savedRoot.sid === 'number' &&
    pidAlive(rootPid) === false
  ) {
    // Without a cgroup, a setsid child can escape every group/session scan.
    // This is not proof of exit; keep it unknown until the owner clears it.
    unknownMembers.push(
      ...sessionMembers(savedRoot.sid).filter((member) => member.pid !== rootPid),
    );
  }
  const pgid = [...ownedGroups][0] ?? null;
  for (const group of ownedGroups) {
    for (const member of groupMembers(group)) {
      if (!rootReused && (!stored || root || normalized.some((item) => item.pid === member.pid))) {
        add(member);
      } else if (savedRoot && typeof savedRoot.sid === 'number' && member.sid === savedRoot.sid) {
        add(member);
      } else {
        unknownMembers.push(member);
      }
    }
  }

  const visit = (parent: number) => {
    for (const child of childPids(parent)) {
      const identity = identifyProcess(child);
      if (!identity) continue;
      add(identity);
      visit(child);
    }
  };
  if (root) visit(root.pid);
  for (const member of normalized) visit(member.pid);

  const liveUnknown = unknownMembers.filter(identityAlive);
  const liveMembers = [...byKey.values()].filter(identityAlive);
  // A saved boundary that no longer exists is only unknown while something of
  // this generation is still alive: a removed boundary around dead processes is
  // history that can be proven empty, not ownership that must block forever.
  const dissolvedWithLiveProcesses =
    cgroup !== null && boundary.state === 'missing' && (root !== null || liveMembers.length > 0);
  const boundaryUnknown =
    boundary.state === 'unreadable' ||
    (cgroup !== null && boundary.state === 'ok' && !cgroupReadable);
  return {
    rootPid: root?.pid ?? null,
    pgid,
    members: liveMembers,
    unknown:
      boundaryUnknown ||
      boundaryReplaced ||
      dissolvedWithLiveProcesses ||
      stored?.adoptedUnproven === true ||
      liveUnknown.length > 0 ||
      (!cgroup &&
        !stored?.allowUnproven &&
        !root &&
        !!savedRoot &&
        typeof savedRoot.sid === 'number'),
    unknownMembers: liveUnknown,
    cgroup: cgroup === null ? 'none' : cgroupReadable ? 'ok' : boundary.state,
    cgroupInode: boundary.inode,
  };
}

/**
 * A GitHub Source polls by spawning a short-lived `gh` child. That child is the
 * only process class we treat as disposable; every other descendant, including
 * a service started <5s ago, must be preserved until it exits by itself.
 */
export function isTransientPolling(command: string): boolean {
  const normalized = command.trim().replaceAll(/\s+/g, ' ');
  if (!normalized) return false;
  const tokens = normalized.split(' ');
  const binary = basename(tokens[0] ?? '');
  if (binary !== 'gh' && binary !== 'gh-agent') return false;

  const args = tokens.slice(1);
  const methodIndex = args.findIndex((arg) => arg === '-X' || arg === '--method');
  if (methodIndex >= 0) {
    const method = (args[methodIndex + 1] ?? '').toUpperCase();
    if (method !== 'GET') return false;
  }
  if (
    args.some(
      (arg) => arg === '-f' || arg === '--field' || arg === '--raw-field' || arg === '--input',
    )
  ) {
    return false;
  }
  if (args[0] === 'api') {
    // The Source polls with GET requests; pagination/formatting flags are
    // read-only. Any explicit non-GET method or field was rejected above; an
    // unknown flag keeps the process because its effects are not proven.
    const readOnlyFlags = new Set([
      '--paginate',
      '--slurp',
      '--jq',
      '-q',
      '--template',
      '-t',
      '--include',
      '-i',
      '--cache',
      '--hostname',
    ]);
    const apiArgs = args
      .slice(1)
      .filter((_, index) => index !== methodIndex - 1 && index !== methodIndex);
    const flags = apiArgs.filter((arg) => arg.startsWith('-'));
    return flags.every((flag) => readOnlyFlags.has(flag));
  }
  if (args[0] === 'issue' || args[0] === 'pr') {
    const action = args[1] ?? '';
    return (
      action === 'list' ||
      action === 'view' ||
      action === 'status' ||
      action === 'diff' ||
      action === 'checks'
    );
  }
  if (args[0] === 'search') return true;
  if (args[0] === 'repo') return args[1] === 'view';
  if (args[0] === 'auth') return args[1] === 'status';
  // Anything else, including gh pr create / gh api -X POST, may write or have
  // unknown effects and must be retained.
  return false;
}

/** Applies the retention policy to a captured set; only known polling is disposable. */
export function retainedIdentities(members: ProcessIdentity[]): ProcessIdentity[] {
  return members.filter((member) => !isTransientPolling(member.command));
}

/** Descendants that are work worth preserving; only known polling is excluded. */
export function retainedDescendants(pid: number, stored?: StoredOwnership): ProcessIdentity[] {
  return retainedIdentities(
    collectOwnership(pid, stored).members.filter((member) => member.pid !== pid),
  );
}

/** Recursively lists the live descendants of a harness process. */
export function descendants(pid: number): number[] {
  return collectOwnership(pid)
    .members.filter((member) => member.pid !== pid)
    .map((member) => member.pid);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Stops a detached runtime and all of its descendants.
 *
 * The result is only `stopped: true` after every tracked identity (root,
 * stored members, process-group members and newly discovered children) is gone.
 * If a child ignores SIGTERM, SIGKILL is sent and the wait continues; a parent
 * exiting first does not release the stop. Every caller must keep the instance
 * in `stopping` and its capacity occupied when this returns false.
 */
export async function stopProcessTree(
  rootPid: number,
  timeoutMs: number,
  stored?: StoredOwnership,
): Promise<StopProcessResult> {
  if (!stored) {
    const initial = collectOwnership(rootPid);
    stored = { rootPid, pgid: initial.pgid, members: initial.members, allowUnproven: true };
  }
  const merged = new Map<string, ProcessIdentity>();
  let unknown = false;
  const merge = (identity: ProcessIdentity | null | undefined) => {
    if (identity && identityAlive(identity)) merged.set(identityKey(identity), identity);
  };
  /**
   * The boundary settles the question the live process table cannot: an empty,
   * readable cgroup (or one that no longer exists at all) proves nothing of this
   * generation is left, while an unreadable one is still unknown ownership.
   */
  const boundaryProof = (): { proven: boolean; boundary: CgroupBoundaryState | 'none' } => {
    const cgroup = stored?.cgroup ?? null;
    if (!cgroup) return { proven: false, boundary: 'none' };
    const boundary = cgroupBoundary(cgroup);
    if (boundary.state === 'missing') return { proven: true, boundary: 'missing' };
    if (boundary.state === 'unreadable') return { proven: false, boundary: 'unreadable' };
    const tree = cgroupEmpty(cgroup);
    return { proven: tree.ok && tree.empty, boundary: 'ok' };
  };
  const refresh = () => {
    const snapshot = collectOwnership(rootPid, {
      rootPid: stored?.rootPid ?? rootPid,
      pgid: stored?.pgid ?? rootPid,
      cgroup: stored?.cgroup ?? null,
      cgroupInode: stored?.cgroupInode ?? null,
      allowUnproven: stored?.allowUnproven,
      adoptedUnproven: stored?.adoptedUnproven,
      members: [...(stored?.members ?? []), ...merged.values()],
    });
    for (const member of snapshot.members) merge(member);
    if (stored?.cgroup && snapshot.cgroup !== 'missing') {
      const tree = cgroupTree(stored.cgroup);
      for (const pid of tree.pids) merge(identifyProcess(pid));
      if (!tree.ok) unknown = true;
    }
    unknown = unknown || snapshot.unknown;
    return snapshot.pgid;
  };

  let pgid = refresh();
  if (!pidAlive(rootPid) && merged.size === 0) {
    const proof = boundaryProof();
    return {
      stopped: proof.proven || (!unknown && proof.boundary === 'none'),
      rootPid,
      pgid,
      remaining: [],
      // `unknown` reports the residual risk (for example pre-adoption
      // descendants). It no longer vetoes an empty, readable boundary.
      unknown,
      boundary: proof.boundary,
    };
  }

  const startedAt = Date.now();
  const termSent = new Set<string>();
  let killSent = false;
  const send = (signal: NodeJS.Signals) => {
    for (const member of [...merged.values()]) {
      const key = identityKey(member);
      if (signal === 'SIGTERM' && termSent.has(key)) continue;
      // Re-verify immediately before every signal: a process may have exited
      // and its PID/PGID reused since it was recorded. Never signal a group
      // here; an unrelated member could share a reused PGID.
      const current = identifyProcess(member.pid);
      if (!current || current.startTime !== member.startTime) {
        merged.delete(key);
        continue;
      }
      if (signal === 'SIGTERM') termSent.add(key);
      signalPid(member.pid, signal);
    }
  };

  send('SIGTERM');
  const killAt = startedAt + Math.max(500, Math.floor(timeoutMs / 2));
  const deadline = startedAt + timeoutMs;

  for (;;) {
    await delay(100);
    pgid = refresh();
    if (!killSent && Date.now() >= killAt) {
      killSent = true;
      send('SIGKILL');
    }
    const alive = [...merged.values()].filter(identityAlive);
    if (alive.length === 0) {
      // One final scan closes the race where a child forked just before the
      // parent exited and was not observed in the previous iteration.
      refresh();
      const finalAlive = [...merged.values()].filter(identityAlive);
      const proof = boundaryProof();
      if (finalAlive.length === 0 && (proof.proven || proof.boundary === 'none')) {
        // An empty, readable cgroup is the execution boundary's own proof; a
        // boundary object that no longer exists is the same statement about the
        // generation that created it. `unknown` can be a PID/PGID reused outside
        // it, so it must not keep capacity occupied forever. A caller without a
        // cgroup still needs the unknown boundary to block.
        removeCgroup(stored?.cgroup);
        return {
          stopped: proof.proven || (!unknown && proof.boundary === 'none'),
          rootPid,
          pgid,
          remaining: [],
          unknown,
          boundary: proof.boundary,
        };
      }
      if (finalAlive.length === 0) {
        // Nothing within this generation is alive, but the boundary cannot be
        // read; that is unknown ownership and must not release capacity.
        return {
          stopped: false,
          rootPid,
          pgid,
          remaining: [],
          unknown: true,
          boundary: proof.boundary,
        };
      }
      merged.clear();
      for (const member of finalAlive) merged.set(identityKey(member), member);
    }
    if (Date.now() >= deadline) {
      const boundary = cgroupBoundary(stored?.cgroup).state;
      return {
        stopped: false,
        rootPid,
        pgid,
        remaining: [...merged.values()].filter(identityAlive),
        unknown,
        boundary: stored?.cgroup ? boundary : 'none',
      };
    }
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(150);
  }
  return !pidAlive(pid);
}

export async function waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await delay(150);
  }
  return portFree(port);
}

export interface PortOwner {
  pid: number;
  startTime: string;
  pgid: number;
  sid: number;
  uid: number | null;
  /** Cgroup of the listener, used to prove whether it is inside our boundary. */
  cgroup: string | null;
  command: string;
}

/** Cgroup path of a live process, from `/proc/<pid>/cgroup`. */
export function pidCgroup(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^0::(.+)$/.exec(line.trim());
      if (match?.[1]) return `/sys/fs/cgroup${match[1]}`;
    }
  } catch {
    // The process exited or is not ours to read.
  }
  return null;
}

function listeningInodes(port: number): string[] {
  const inodes: string[] = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const local = fields[1] ?? '';
      const state = fields[3] ?? '';
      const inode = fields[9] ?? '';
      const hexPort = local.split(':')[1];
      if (state !== '0A' || !hexPort || !inode) continue;
      if (Number.parseInt(hexPort, 16) === port) inodes.push(inode);
    }
  }
  return [...new Set(inodes)];
}

/**
 * Resolves which processes listen on a port. A leftover runtime and an unrelated
 * service look identical through a TCP connect, so the stop and start paths need
 * the listener's own identity before they touch anything.
 */
export function portOwners(port: number): PortOwner[] {
  const inodes = new Set(listeningInodes(port));
  if (inodes.size === 0) return [];
  const owners: PortOwner[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    let matched = false;
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (target.startsWith('socket:[') && inodes.has(target.slice(8, -1))) {
          matched = true;
          break;
        }
      } catch {
        // The fd was closed while scanning.
      }
    }
    if (!matched) continue;
    const identity = identifyProcess(pid);
    if (!identity) continue;
    let uid: number | null = null;
    try {
      uid = statSync(`/proc/${pid}`).uid;
    } catch {
      uid = null;
    }
    owners.push({ ...identity, uid, cgroup: pidCgroup(pid) });
  }
  return owners;
}

/** True when a process lives inside the supervisor's own instance cgroup root. */
export function ownedByRoot(owner: Pick<PortOwner, 'cgroup'>, root: string = CGROUP_ROOT): boolean {
  if (!owner.cgroup) return false;
  const normalized = root.endsWith('/') ? root : `${root}/`;
  return owner.cgroup === root || owner.cgroup.startsWith(normalized);
}
