import { taskStateSchema, type ModelSelection, type TaskSummary } from '@moyu/contracts';

import { decodeModelId } from './runtime';

export interface TaskRow {
  id: string;
  conversationId: string;
  repositoryId: string;
  state: string;
  upstreamTicketId: string | null;
  upstreamThreadId: string | null;
  baseBranch: string;
  baseCommit: string | null;
  modelId: string | null;
  modelReasoningEffort: string | null;
  executionMode: 'execute' | 'discuss';
  question: string | null;
  questionMessageId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const TASK_COLUMNS = `
  t.id, t.conversation_id as "conversationId", t.repository_id as "repositoryId", t.state,
  t.upstream_ticket_id as "upstreamTicketId", t.upstream_thread_id as "upstreamThreadId",
  t.base_branch as "baseBranch", t.base_commit as "baseCommit", t.model_id as "modelId",
  t.model_reasoning_effort as "modelReasoningEffort", t.execution_mode as "executionMode",
  t.question, t.question_message_id as "questionMessageId", t.pr_url as "prUrl", t.pr_number as "prNumber",
  t.version, t.created_at as "createdAt", t.updated_at as "updatedAt"
`;

export function taskModel(row: TaskRow): ModelSelection | null {
  const identity = decodeModelId(row.modelId);
  return identity
    ? {
        provider: identity.provider,
        model: identity.model,
        reasoningEffort: row.modelReasoningEffort,
      }
    : null;
}

export function taskSummary(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    conversationId: row.conversationId,
    repositoryId: row.repositoryId,
    state: taskStateSchema.catch('pending_admission').parse(row.state),
    upstreamTicketId: row.upstreamTicketId,
    upstreamThreadId: row.upstreamThreadId,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    model: taskModel(row),
    executionMode: row.executionMode,
    question: row.question,
    questionMessageId: row.questionMessageId,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Maps an upstream ticket outcome to the platform's projection state. */
export function endedState(outcome: unknown): string {
  switch (outcome) {
    case 'merged':
    case 'completed':
    case 'dropped':
      return 'completed';
    case 'closed':
      return 'closed_unmerged';
    case 'stopped':
      return 'stopped';
    default:
      return 'completed';
  }
}
