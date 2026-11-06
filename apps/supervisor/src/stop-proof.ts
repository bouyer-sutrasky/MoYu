import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface StopProof {
  version: 1;
  runtimeId: string;
  generation: string;
  cgroup: string;
  cgroupInode: number;
  ticketId: string;
  assignmentId: string;
  leaseId: string;
  fencingToken: string;
  state: 'unproven' | 'proven';
  at: string;
}

export interface StopProofIdentity {
  runtimeId: string;
  generation: string;
  ticketId: string;
  assignmentId: string;
  leaseId: string;
  fencingToken: string;
}
export interface StopProofInput extends StopProofIdentity {
  cgroup: string;
}
export type VerifyResult = { proven: true } | { proven: false; reason: string };

const file = (root: string, runtimeId: string) =>
  join(root, 'stop-proof', `${encodeURIComponent(runtimeId)}.json`);
const LOCK = '.lock';
const CGROUP2_SUPER_MAGIC = 0x63677270n;
interface LockOwner {
  token: string;
  pid: number;
  startTime: string;
}
const sameIdentity = (a: StopProofIdentity, b: StopProofIdentity) =>
  a.runtimeId === b.runtimeId &&
  a.generation === b.generation &&
  a.ticketId === b.ticketId &&
  a.assignmentId === b.assignmentId &&
  a.leaseId === b.leaseId &&
  a.fencingToken === b.fencingToken;
async function cgroupPath(path: string): Promise<string | undefined> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    return undefined;
  }
  if (!resolved.startsWith('/sys/fs/cgroup/') || resolved === '/sys/fs/cgroup') return undefined;
  try {
    const fs = await statfs(resolved, { bigint: true });
    if (fs.type !== CGROUP2_SUPER_MAGIC) return undefined;
  } catch {
    return undefined;
  }
  return resolved;
}

function valid(value: unknown): value is StopProof {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    p.version === 1 &&
    typeof p.runtimeId === 'string' &&
    typeof p.generation === 'string' &&
    typeof p.cgroup === 'string' &&
    typeof p.cgroupInode === 'number' &&
    typeof p.ticketId === 'string' &&
    typeof p.assignmentId === 'string' &&
    typeof p.leaseId === 'string' &&
    typeof p.fencingToken === 'string' &&
    (p.state === 'unproven' || p.state === 'proven') &&
    typeof p.at === 'string'
  );
}

async function readProof(
  root: string,
  runtimeId: string,
): Promise<StopProof | undefined | 'unreadable'> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(root, runtimeId), 'utf8'));
    return valid(parsed) ? parsed : 'unreadable';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'unreadable';
  }
}
async function writeAtomic(temporary: string, target: string, text: string): Promise<void> {
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await unlink(temporary).catch(() => {});
}

/** Serializes bind/verify across processes; the lock is stolen only from a dead owner. */
function processStart(pid: number): Promise<string | undefined> {
  return readFile(`/proc/${pid}/stat`, 'utf8')
    .then((text) => text.slice(text.lastIndexOf(')') + 2).split(' ')[19])
    .catch(() => undefined);
}
async function lockOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as LockOwner;
  } catch {
    return undefined;
  }
}
async function withLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const dir = join(root, 'stop-proof');
  await mkdir(dir, { recursive: true });
  const lock = join(dir, LOCK);
  const token = randomUUID();
  const pid = process.pid;
  const started = await processStart(pid);
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      await mkdir(lock);
      await writeFile(
        join(lock, 'owner.json'),
        JSON.stringify({ token, pid, startTime: started ?? 'unknown' }),
        { mode: 0o600 },
      );
      try {
        return await work();
      } finally {
        const owner = await lockOwner(lock);
        if (owner?.token === token) await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await lockOwner(lock);
      const alive = owner ? (await processStart(owner.pid)) === owner.startTime : false;
      if (owner && !alive) {
        const again = await lockOwner(lock);
        if (again?.token === owner.token) await rm(lock, { recursive: true, force: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('timed out waiting for the stop-proof lock');
}

/** Bind before stopping. Every dimension is immutable while unproven. */
export async function bindStopProof(root: string, input: StopProofInput): Promise<StopProof> {
  const cgroup = await cgroupPath(input.cgroup);
  if (!cgroup) throw new Error('cgroup must be a live cgroup v2 object');
  return withLock(root, async () => {
    const existing = await readProof(root, input.runtimeId);
    if (existing === 'unreadable')
      throw new Error('existing stop proof is unreadable; refusing to overwrite');
    if (existing) {
      if (sameIdentity(existing, input)) {
        if (existing.cgroup !== input.cgroup)
          throw new Error('cgroup object conflicts with the bound generation');
        if (existing.cgroupInode !== (await stat(input.cgroup)).ino)
          throw new Error('cgroup object inode changed');
        return existing;
      }
      if (existing.state === 'unproven')
        throw new Error('another unproven stop proof is bound to this runtime');
    }
    const proof: StopProof = {
      version: 1,
      ...input,
      cgroupInode: (await stat(input.cgroup)).ino,
      state: 'unproven',
      at: new Date().toISOString(),
    };
    await writeAtomic(
      `${file(root, input.runtimeId)}.${randomUUID()}.tmp`,
      file(root, input.runtimeId),
      JSON.stringify(proof),
    );
    return proof;
  });
}

/** Prove the exact old generation and complete identity is empty in the same cgroup object. */
export async function verifyStopProof(
  root: string,
  identity: StopProofIdentity,
): Promise<VerifyResult> {
  return withLock(root, async () => {
    const proof = await readProof(root, identity.runtimeId);
    if (proof === 'unreadable')
      return { proven: false, reason: 'stop proof is unreadable or malformed' };
    if (!proof) return { proven: false, reason: 'stop proof is missing' };
    if (!sameIdentity(proof, identity))
      return { proven: false, reason: 'stop proof binding does not match' };
    const cgroup = await cgroupPath(proof.cgroup);
    if (!cgroup || cgroup !== proof.cgroup)
      return { proven: false, reason: 'cgroup path is not the original cgroup v2 object' };
    let events: string;
    try {
      const handle = await open(cgroup, 'r');
      try {
        if ((await handle.stat()).ino !== proof.cgroupInode)
          return { proven: false, reason: 'cgroup object was replaced' };
        events = await readFile(`/proc/self/fd/${handle.fd}/cgroup.events`, 'utf8');
      } finally {
        await handle.close();
      }
    } catch {
      return { proven: false, reason: 'cgroup.events is unreadable or permission unknown' };
    }
    if (!/^populated 0$/m.test(events))
      return { proven: false, reason: 'cgroup still has populated descendants' };
    await writeAtomic(
      `${file(root, identity.runtimeId)}.${randomUUID()}.tmp`,
      file(root, identity.runtimeId),
      JSON.stringify({ ...proof, state: 'proven', at: new Date().toISOString() }),
    );
    return { proven: true };
  });
}
