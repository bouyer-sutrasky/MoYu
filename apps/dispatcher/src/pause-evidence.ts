/** The stop evidence every projection checks, whether it arrived in an event, a poll, or a restart snapshot. */
export interface PauseEvidence {
  stoppedAt?: unknown;
  agentStatus?: unknown;
  jobsAfter?: unknown;
  subagentsAfter?: unknown;
  lingeringPids?: unknown;
  /** The launch phase the stop bound found: `none`, `aborted`, or `timed-out`. */
  launch?: unknown;
  /** Set by the Executor when this attempt could not settle the stop; a failed proof is never a stop. */
  stopIncomplete?: unknown;
  proven?: unknown;
  [key: string]: unknown;
}

/**
 * A pause is proven only with a real stop timestamp, an idle or absent worker, no
 * remaining background job and no subagent. A timestamp alone is not enough: the
 * worker may still be running a command when it is written, and a launch whose
 * abort did not land within the bound is never a complete stop even if the
 * snapshot looks quiet.
 */
export function pauseEvidenceProven(evidence: PauseEvidence | null | undefined): boolean {
  if (!evidence) return false;
  const {
    stoppedAt,
    agentStatus,
    jobsAfter,
    subagentsAfter,
    lingeringPids,
    launch,
    stopIncomplete,
    proven,
  } = evidence;
  return (
    typeof stoppedAt === 'string' &&
    !Number.isNaN(Date.parse(stoppedAt)) &&
    (agentStatus === 'idle' || agentStatus === 'absent') &&
    Array.isArray(jobsAfter) &&
    jobsAfter.length === 0 &&
    (subagentsAfter === undefined || subagentsAfter === 0) &&
    (!Array.isArray(lingeringPids) || lingeringPids.length === 0) &&
    launch !== 'timed-out' &&
    stopIncomplete === undefined &&
    proven !== false
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
  if (typeof evidence.stopIncomplete === 'string' && evidence.stopIncomplete) {
    return evidence.stopIncomplete;
  }
  if (evidence.launch === 'timed-out') {
    return 'The start in flight did not end within the stop bound';
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

/**
 * The next action the platform shows for a stop whose proof is missing. The
 * recorded pause operation is checked again; nothing is resumed before that.
 */
export const PAUSE_RECHECK_NEXT_STEP = 'recheck-stop';

/** Whether a task's stop evidence asks for a stop check rather than an owner stop. */
export function pauseRecheckRequested(
  evidence: Record<string, unknown> | null | undefined,
): boolean {
  return evidence?.nextStep === PAUSE_RECHECK_NEXT_STEP;
}

export interface PauseRecheckBinding {
  /** The runtime Ticket the pause belongs to. */
  ticketId: string;
  /** The operation that paused the Ticket, which the new evidence must name. */
  pauseOperationId: string;
  /** The stop-check operation whose answer this is. */
  recheckOperationId: string;
  /** The execution lease generation the pause was admitted under. */
  leaseId: string;
  fencingToken: string;
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/**
 * A stop check is only evidence for the ticket, operation and lease generation
 * it was asked for. A mismatch is not a stop: the placeholder stays and the
 * next step is explained, because applying it would settle another generation.
 */
export function pauseRecheckBindingProblem(
  evidence: PauseEvidence | null | undefined,
  expected: PauseRecheckBinding,
): string | undefined {
  if (!evidence) {
    return 'The runtime returned no stop evidence for the stop check';
  }
  if (text(evidence.ticketId) !== expected.ticketId) {
    return 'The stop evidence belongs to another ticket';
  }
  if (text(evidence.operationId) !== expected.pauseOperationId) {
    return 'The stop evidence does not name the original pause operation';
  }
  if (text(evidence.recheckOperationId) !== expected.recheckOperationId) {
    return 'The stop evidence does not name this stop check';
  }
  if (text(evidence.leaseId) !== expected.leaseId) {
    return 'The stop evidence names another execution lease';
  }
  if (text(evidence.fencingToken) !== expected.fencingToken) {
    return 'The stop evidence names another execution generation';
  }
  return undefined;
}

/**
 * The binding a task records when a stop check is requested, read back by every
 * projection that can observe its answer. Only a task that asked for the check
 * has these fields; an ordinary pause never needs them.
 */
export function pauseRecheckBindingFromEvidence(
  previous: Record<string, unknown> | null | undefined,
): PauseRecheckBinding | undefined {
  if (!pauseRecheckRequested(previous)) return undefined;
  const pauseOperationId = text(previous?.pauseOperationId);
  const recheckOperationId = text(previous?.recheckOperationId);
  const leaseId = text(previous?.leaseId);
  const fencingToken = text(previous?.fencingToken);
  const ticketId = text(previous?.recheckTicketId);
  if (!pauseOperationId || !recheckOperationId || !leaseId || !fencingToken || !ticketId) {
    return undefined;
  }
  return { ticketId, pauseOperationId, recheckOperationId, leaseId, fencingToken };
}
