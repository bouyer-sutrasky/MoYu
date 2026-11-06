import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
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
const sameIdentity = (a: StopProofIdentity, b: StopProofIdentity) =>
  a.runtimeId === b.runtimeId &&
  a.generation === b.generation &&
  a.ticketId === b.ticketId &&
  a.assignmentId === b.assignmentId &&
  a.leaseId === b.leaseId &&
  a.fencingToken === b.fencingToken;
const isCgroup = (path: string) => path.startsWith('/sys/fs/cgroup/') && path !== '/sys/fs/cgroup';

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

/** Serializes bind/verify across processes; a lock older than 30s is stale. */
async function withLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const dir = join(root, 'stop-proof');
  await mkdir(dir, { recursive: true });
  const lock = join(dir, LOCK);
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      try {
        return await work();
      } finally {
        await handle.close();
        await unlink(lock).catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await stat(lock)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (age > 30_000) await unlink(lock).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('timed out waiting for the stop-proof lock');
}

/** Bind before stopping. Every dimension is immutable while unproven. */
export async function bindStopProof(root: string, input: StopProofInput): Promise<StopProof> {
  if (!isCgroup(input.cgroup)) throw new Error('cgroup must be an authorized cgroup v2 path');
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
    if (!isCgroup(proof.cgroup))
      return { proven: false, reason: 'cgroup path is not an authorized cgroup v2 object' };
    let inode: number;
    try {
      inode = (await stat(proof.cgroup)).ino;
    } catch {
      return { proven: false, reason: 'cgroup path is missing' };
    }
    if (inode !== proof.cgroupInode) return { proven: false, reason: 'cgroup object was replaced' };
    let events: string;
    try {
      events = await readFile(join(proof.cgroup, 'cgroup.events'), 'utf8');
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
