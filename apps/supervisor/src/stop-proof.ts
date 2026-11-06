import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
  reason?: string;
  at: string;
}

export interface StopProofInput {
  runtimeId: string;
  generation: string;
  cgroup: string;
  ticketId: string;
  assignmentId: string;
  leaseId: string;
  fencingToken: string;
}

export type VerifyResult = { proven: true } | { proven: false; reason: string };

const file = (root: string, runtimeId: string) =>
  join(root, 'stop-proof', `${encodeURIComponent(runtimeId)}.json`);

async function cgroupInode(path: string): Promise<number> {
  return (await stat(path)).ino;
}

/** Bind before stopping; an existing unproven binding for another generation is never overwritten. */
export async function bindStopProof(root: string, input: StopProofInput): Promise<StopProof> {
  await mkdir(join(root, 'stop-proof'), { recursive: true });
  const target = file(root, input.runtimeId);
  const existing = await readFile(target, 'utf8')
    .then((text) => JSON.parse(text) as StopProof)
    .catch(() => undefined);
  if (existing?.state === 'unproven' && existing.generation !== input.generation) return existing;
  const proof: StopProof = {
    version: 1,
    ...input,
    cgroupInode: await cgroupInode(input.cgroup),
    state: 'unproven',
    at: new Date().toISOString(),
  };
  await writeFile(`${target}.tmp`, JSON.stringify(proof), { mode: 0o600 });
  await rename(`${target}.tmp`, target);
  return proof;
}

/** Prove the exact old generation is empty. Missing paths, reused inodes, unreadable
 * events and populated groups all refuse to issue a proof. */
export async function verifyStopProof(
  root: string,
  runtimeId: string,
  generation: string,
): Promise<VerifyResult> {
  let proof: StopProof;
  try {
    proof = JSON.parse(await readFile(file(root, runtimeId), 'utf8')) as StopProof;
  } catch {
    return { proven: false, reason: 'stop proof is missing or unreadable' };
  }
  if (proof.runtimeId !== runtimeId) return { proven: false, reason: 'runtime id mismatch' };
  if (proof.generation !== generation)
    return { proven: false, reason: 'runtime generation changed' };
  if (!proof.cgroup) return { proven: false, reason: 'cgroup path is missing' };
  let inode: number;
  try {
    inode = await cgroupInode(proof.cgroup);
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
  if (!proof.ticketId || !proof.assignmentId || !proof.leaseId || !proof.fencingToken)
    return { proven: false, reason: 'binding fields are missing' };
  const proven = {
    ...proof,
    state: 'proven' as const,
    reason: undefined,
    at: new Date().toISOString(),
  };
  await writeFile(`${file(root, runtimeId)}.tmp`, JSON.stringify(proven), { mode: 0o600 });
  await rename(`${file(root, runtimeId)}.tmp`, file(root, runtimeId));
  return { proven: true };
}
