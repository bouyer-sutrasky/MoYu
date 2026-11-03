import { pgEnum } from 'drizzle-orm/pg-core';

export const authChallengeKind = pgEnum('auth_challenge_kind', ['registration', 'authentication']);

export const repositoryStatus = pgEnum('repository_status', [
  'provisioning',
  'active',
  'sleeping',
  'error',
]);

export const conversationMode = pgEnum('conversation_mode', ['work', 'chat']);

export const executionMode = pgEnum('execution_mode', ['execute', 'discuss']);

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
