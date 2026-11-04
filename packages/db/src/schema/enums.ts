import { pgEnum } from 'drizzle-orm/pg-core';

export const authChallengeKind = pgEnum('auth_challenge_kind', ['registration', 'authentication']);

export const bootstrapCodePurpose = pgEnum('bootstrap_code_purpose', ['initial', 'recovery']);

export const repositoryStatus = pgEnum('repository_status', [
  'provisioning',
  'active',
  'sleeping',
  'error',
]);

/**
 * Host supervisor lifecycle for one repository runtime. `fault` means the
 * supervisor could not start or lost the instance; it is never counted as an
 * online slot and never retried in a loop without an explicit owner action.
 */
export const runtimeInstanceState = pgEnum('runtime_instance_state', [
  'sleeping',
  'starting',
  'online',
  'stopping',
  'fault',
]);

/** What the supervisor should converge to after a restart. */
export const runtimeDesiredState = pgEnum('runtime_desired_state', ['sleeping', 'online']);

export const conversationMode = pgEnum('conversation_mode', ['work', 'chat']);

export const executionMode = pgEnum('execution_mode', ['execute', 'discuss']);

/** Where a Work conversation was started: the web composer, or an imported GitHub ticket. */
export const conversationSource = pgEnum('conversation_source', ['web', 'github']);

export const taskOperationKind = pgEnum('task_operation_kind', [
  'start',
  'pause',
  'resume',
  'retry',
]);

export const taskOperationState = pgEnum('task_operation_state', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);

export const deliveryState = pgEnum('delivery_state', [
  'pending',
  'delivering',
  'delivered',
  'failed',
]);

/**
 * Mirrors the task states in docs/API-CONTRACTS.md. Upstream ticket state stays
 * authoritative in superagent; this is the projection shown by the platform.
 */
export const taskState = pgEnum('task_state', [
  'pending_admission',
  'discussing',
  'queued',
  'running',
  'waiting_input',
  'awaiting_review',
  'stopping',
  'stopped',
  'blocked',
  'failed',
  'completed',
  'closed_unmerged',
  'not_accepted',
]);

export const runtimeLeaseState = pgEnum('runtime_lease_state', ['active', 'released', 'expired']);

export const artifactType = pgEnum('artifact_type', [
  'diff',
  'check_report',
  'pull_request',
  'attachment',
  'log',
  'other',
]);
