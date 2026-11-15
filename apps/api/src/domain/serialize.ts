import type {
  AttachmentSummary,
  ConversationSummary,
  DeliverySummary,
  Message,
  ModelSelection,
  TaskOperationSummary,
  TaskSummary,
} from '@moyu/contracts';
import { decodeModelId } from '@moyu/runtime-client';
import type {
  Conversation,
  Delivery,
  Message as MessageRow,
  TaskLink,
  TaskOperation,
} from '@moyu/db';

export function toDeliverySummary(delivery: Delivery | null): DeliverySummary | null {
  if (!delivery) {
    return null;
  }
  const state = delivery.readAt ? 'read' : delivery.state === 'pending' ? 'stored' : delivery.state;
  return {
    state,
    attemptCount: delivery.attemptCount,
    lastError: delivery.lastError,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    handedToWorkerAt: delivery.handedToWorkerAt?.toISOString() ?? null,
    readAt: delivery.readAt?.toISOString() ?? null,
  };
}

export function toMessage(
  row: MessageRow,
  delivery: Delivery | null,
  attachments: AttachmentSummary[] = [],
): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction,
    kind: row.kind as Message['kind'],
    clientMessageId: row.clientMessageId,
    body: row.body,
    replyToMessageId: row.replyToMessageId,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    delivery: toDeliverySummary(delivery),
    attachments,
  };
}

export function toModelSelection(conversation: Conversation): ModelSelection | null {
  const identity = decodeModelId(conversation.modelId);
  if (!identity) {
    return null;
  }
  return {
    provider: identity.provider,
    model: identity.model,
    reasoningEffort: conversation.modelReasoningEffort,
  };
}

export function toTaskOperationSummary(row: TaskOperation): TaskOperationSummary {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    state: row.state,
    evidence: row.evidence,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTaskSummary(
  task: TaskLink,
  lastOperation: TaskOperation | null = null,
): TaskSummary {
  const identity = decodeModelId(task.modelId);
  return {
    id: task.id,
    conversationId: task.conversationId,
    repositoryId: task.repositoryId,
    state: task.state,
    upstreamTicketId: task.upstreamTicketId,
    upstreamThreadId: task.upstreamThreadId,
    baseBranch: task.baseBranch,
    baseCommit: task.baseCommit,
    model: identity
      ? {
          provider: identity.provider,
          model: identity.model,
          reasoningEffort: task.modelReasoningEffort,
        }
      : null,
    executionMode: task.executionMode,
    question: task.question,
    questionMessageId: task.questionMessageId,
    prUrl: task.prUrl,
    prNumber: task.prNumber,
    planRevision: task.planRevision,
    stopRequestedAt: task.stopRequestedAt?.toISOString() ?? null,
    stoppedAt: task.stoppedAt?.toISOString() ?? null,
    stopEvidence: task.stopEvidence,
    lastOperation: lastOperation ? toTaskOperationSummary(lastOperation) : null,
    version: task.version,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function toConversationSummary(
  conversation: Conversation,
  task: TaskLink | null,
  title: string | null,
  lastOperation: TaskOperation | null = null,
): ConversationSummary {
  return {
    id: conversation.id,
    repositoryId: conversation.repositoryId,
    mode: conversation.mode,
    executionMode: conversation.executionMode,
    source: conversation.source,
    externalKey: conversation.externalKey,
    externalUrl: conversation.externalUrl,
    planRevision: conversation.planRevision,
    baseBranch: conversation.baseBranch,
    baseCommit: conversation.baseCommit,
    model: toModelSelection(conversation),
    title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    task: task ? toTaskSummary(task, lastOperation) : null,
  };
}
