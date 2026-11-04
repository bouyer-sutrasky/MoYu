import { createConnection } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
}

export interface StoredOwnership {
  rootPid?: number | null;
  pgid?: number | null;
  members?: Array<Partial<ProcessIdentity> & { pid?: number; startTime?: string }>;
}

export interface StopProcessResult {
  stopped: boolean;
  rootPid: number;
  pgid: number | null;
  remaining: ProcessIdentity[];
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
  return !current || current === identity.startTime;
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
 * Captures the root process, its process group, and every descendant. The
 * snapshot keeps start times so a reused PID is never mistaken for the old
 * worker. When the root has already died, stored members and processes still in
 * its old process group are used to find survivors.
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

  const root = identifyProcess(rootPid);
  add(root);
  for (const member of normalizeStored(stored)) add(member);

  const pgid = root?.pgid ?? stored?.pgid ?? rootPid;
  for (const member of groupMembers(pgid)) add(member);

  const visit = (parent: number) => {
    for (const child of childPids(parent)) {
      add(identifyProcess(child));
      visit(child);
    }
  };
  if (root) visit(root.pid);
  for (const member of [...byKey.values()]) visit(member.pid);

  return {
    rootPid: root?.pid ?? null,
    pgid,
    members: [...byKey.values()].filter(identityAlive),
  };
}

/**
 * A GitHub Source polls by spawning a short-lived `gh` child. That child is the
 * only process class we treat as disposable; every other descendant, including
 * a service started <5s ago, must be preserved until it exits by itself.
 */
export function isTransientPolling(command: string): boolean {
  const first = command.trim().split(/\s+/, 1)[0] ?? '';
  return basename(first) === 'gh' || basename(first) === 'gh-agent';
}

/** Descendants that are work worth preserving; only known polling is excluded. */
export function retainedDescendants(pid: number, stored?: StoredOwnership): ProcessIdentity[] {
  return collectOwnership(pid, stored).members.filter(
    (member) => member.pid !== pid && !isTransientPolling(member.command),
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

function signalGroup(pgid: number | null, signal: NodeJS.Signals): void {
  if (!pgid || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is empty or not ours; individual PIDs are still signalled.
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
  const merged = new Map<string, ProcessIdentity>();
  const merge = (identity: ProcessIdentity | null | undefined) => {
    if (identity && identityAlive(identity)) merged.set(identityKey(identity), identity);
  };
  const refresh = () => {
    const snapshot = collectOwnership(rootPid, {
      rootPid: stored?.rootPid ?? rootPid,
      pgid: stored?.pgid ?? rootPid,
      members: [...(stored?.members ?? []), ...merged.values()],
    });
    for (const member of snapshot.members) merge(member);
    for (const member of groupMembers(snapshot.pgid ?? rootPid)) merge(member);
    return snapshot.pgid;
  };

  let pgid = refresh();
  if (!pidAlive(rootPid) && merged.size === 0) {
    return { stopped: true, rootPid, pgid, remaining: [] };
  }

  const startedAt = Date.now();
  const termSent = new Set<string>();
  let killSent = false;
  const send = (signal: NodeJS.Signals) => {
    signalGroup(pgid, signal);
    if (pidAlive(rootPid)) signalPid(rootPid, signal);
    for (const member of merged.values()) {
      const key = identityKey(member);
      if (signal === 'SIGTERM' && termSent.has(key)) continue;
      if (signal === 'SIGTERM') termSent.add(key);
      signalGroup(member.pgid, signal);
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
      if (finalAlive.length === 0) {
        return { stopped: true, rootPid, pgid, remaining: [] };
      }
      merged.clear();
      for (const member of finalAlive) merged.set(identityKey(member), member);
    }
    if (Date.now() >= deadline) {
      return {
        stopped: false,
        rootPid,
        pgid,
        remaining: [...merged.values()].filter(identityAlive),
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
