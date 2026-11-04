import { createConnection } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

/** Age of a Linux process in milliseconds from /proc, or Infinity when unknown. */
export function processAgeMs(pid: number): number {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    const startTicks = Number(fields[21]);
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptime)) return Infinity;
    return Math.max(0, uptime * 1000 - startTicks * 10);
  } catch {
    return Infinity;
  }
}

/** Descendants that have lived long enough to be work worth preserving. */
export function retainedDescendants(pid: number, minAgeMs = 5000): number[] {
  return descendants(pid).filter((child) => processAgeMs(child) >= minAgeMs);
}

/** Recursively lists the live descendants of a harness process. */
export function descendants(pid: number): number[] {
  const seen = new Set<number>();
  const visit = (parent: number) => {
    for (const child of childPids(parent)) {
      if (seen.has(child) || !pidAlive(child)) continue;
      seen.add(child);
      visit(child);
    }
  };
  visit(pid);
  return [...seen];
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(150);
  }
  return !pidAlive(pid);
}

/** Stops the detached process group: SIGTERM first, SIGKILL only after the bound. */
export async function stopProcessTree(pid: number, timeoutMs: number): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return !pidAlive(pid);
    }
  }
  if (await waitForExit(pid, timeoutMs)) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Fall through to the final check.
    }
  }
  return waitForExit(pid, 5000);
}

export async function waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await delay(150);
  }
  return portFree(port);
}
