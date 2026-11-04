/** The stop evidence every projection checks, whether it arrived in an event, a poll, or a restart snapshot. */
export interface PauseEvidence {
  stoppedAt?: unknown;
  agentStatus?: unknown;
  jobsAfter?: unknown;
  subagentsAfter?: unknown;
  lingeringPids?: unknown;
  [key: string]: unknown;
}

/**
 * A pause is proven only with a real stop timestamp, an idle or absent worker, no
 * remaining background job and no subagent. A timestamp alone is not enough: the
 * worker may still be running a command when it is written.
 */
export function pauseEvidenceProven(evidence: PauseEvidence | null | undefined): boolean {
  if (!evidence) return false;
  const { stoppedAt, agentStatus, jobsAfter, subagentsAfter, lingeringPids } = evidence;
  return (
    typeof stoppedAt === 'string' &&
    !Number.isNaN(Date.parse(stoppedAt)) &&
    (agentStatus === 'idle' || agentStatus === 'absent') &&
    Array.isArray(jobsAfter) &&
    jobsAfter.length === 0 &&
    (subagentsAfter === undefined || subagentsAfter === 0) &&
    (!Array.isArray(lingeringPids) || lingeringPids.length === 0)
  );
}

/** A short, user-facing reason when the evidence is incomplete; undefined when it is proven. */
export function pauseEvidenceProblem(
  evidence: PauseEvidence | null | undefined,
): string | undefined {
  if (pauseEvidenceProven(evidence)) {
    return undefined;
  }
  if (!evidence) {
    return 'The runtime returned no stop evidence';
  }
  if (typeof evidence.stoppedAt !== 'string' || Number.isNaN(Date.parse(evidence.stoppedAt))) {
    return 'The runtime did not record when the worker stopped';
  }
  if (evidence.agentStatus !== 'idle' && evidence.agentStatus !== 'absent') {
    return `The worker is still ${String(evidence.agentStatus ?? 'unknown')}`;
  }
  if (!Array.isArray(evidence.jobsAfter) || evidence.jobsAfter.length > 0) {
    const count = Array.isArray(evidence.jobsAfter) ? evidence.jobsAfter.length : 'unknown';
    return `${count} background job(s) still running`;
  }
  if (evidence.subagentsAfter !== undefined && evidence.subagentsAfter !== 0) {
    return `${String(evidence.subagentsAfter)} subagent(s) still running`;
  }
  if (Array.isArray(evidence.lingeringPids) && evidence.lingeringPids.length > 0) {
    return `${evidence.lingeringPids.length} process(es) still running`;
  }
  return 'The stop evidence is incomplete';
}
