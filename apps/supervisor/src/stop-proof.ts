import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** A supervisor-owned binding to the exact runtime cgroup generation being stopped. */
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
const sameIdentity = (a: StopProofIdentity, b: StopProofIdentity) =>
  a.runtimeId === b.runtimeId &&
  a.generation === b.generation &&
  a.ticketId === b.ticketId &&
  a.assignmentId === b.assignmentId &&
  a.leaseId === b.leaseId &&
  a.fencingToken === b.fencingToken;

async function readProof(
  root: string,
  runtimeId: string,
): Promise<StopProof | undefined | 'unreadable'> {
  try {
    return JSON.parse(await readFile(file(root, runtimeId), 'utf8')) as StopProof;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 'unreadable';
  }
}
async function writeProof(root: string, proof: StopProof): Promise<void> {
  const target = file(root, proof.runtimeId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFileAtomic(temporary, target, JSON.stringify(proof));
}
async function writeFileAtomic(temporary: string, target: string, text: string): Promise<void> {
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

/** Bind before stopping. Only an identical binding is idempotent; a different
 * unproven binding or an unreadable existing record is a conflict. */
export async function bindStopProof(root: string, input: StopProofInput): Promise<StopProof> {
  await mkdir(join(root, 'stop-proof'), { recursive: true });
  const existing = await readProof(root, input.runtimeId);
  if (existing === 'unreadable')
    throw new Error('existing stop proof is unreadable; refusing to overwrite');
  if (existing) {
    if (existing.state === 'unproven' && !sameIdentity(existing, input)) {
      throw new Error('another unproven stop proof is bound to this runtime generation');
    }
    if (sameIdentity(existing, input) && existing.cgroup === input.cgroup) return existing;
  }
  const proof: StopProof = {
    version: 1,
    ...input,
    cgroupInode: (await stat(input.cgroup)).ino,
    state: 'unproven',
    at: new Date().toISOString(),
  };
  await writeProof(root, proof);
  return proof;
}

/** Prove the exact old generation and full Ticket/Assignment/lease/token identity is
 * empty. Missing/unreadable proof, reused inode, changed binding, unreadable events
 * and populated groups refuse. */
export async function verifyStopProof(
  root: string,
  identity: StopProofIdentity,
): Promise<VerifyResult> {
  const proof = await readProof(root, identity.runtimeId);
  if (!proof) return { proven: false, reason: 'stop proof is missing' };
  if (proof === 'unreadable') return { proven: false, reason: 'stop proof is unreadable' };
  if (!sameIdentity(proof, identity))
    return { proven: false, reason: 'stop proof binding does not match' };
  if (!proof.cgroup) return { proven: false, reason: 'cgroup path is missing' };
  let inode: number;
  try {
    inode = (await stat(proof.cgroup)).ino;
  } catch {
    return { proven: false, reason: 'cgroup path is missing' };
  }
  if (inode !== proof.cgroupInode)
    return { proven: false, reason: 'cgroup path was reused by another generation' };
  let events: string;
  try {
    events = await readFile(join(proof.cgroup, 'cgroup.events'), 'utf8');
  } catch {
    return { proven: false, reason: 'cgroup.events is unreadable or permission unknown' };
  }
  if (!/^populated 0$/m.test(events))
    return { proven: false, reason: 'cgroup still has populated descendants' };
  await writeProof(root, { ...proof, state: 'proven', at: new Date().toISOString() });
  return { proven: true };
}
