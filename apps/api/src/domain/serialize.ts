import type {
  ConversationSummary,
  DeliverySummary,
  Message,
  ModelSelection,
  TaskSummary,
} from '@moyu/contracts';
import { decodeModelId } from '@moyu/runtime-client';
import type { Conversation, Delivery, Message as MessageRow, TaskLink } from '@moyu/db';

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

export function toMessage(row: MessageRow, delivery: Delivery | null): Message {
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

export function toTaskSummary(task: TaskLink): TaskSummary {
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
    version: task.version,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function toConversationSummary(
  conversation: Conversation,
  task: TaskLink | null,
  title: string | null,
): ConversationSummary {
  return {
    id: conversation.id,
    repositoryId: conversation.repositoryId,
    mode: conversation.mode,
    executionMode: conversation.executionMode,
    baseBranch: conversation.baseBranch,
    baseCommit: conversation.baseCommit,
    model: toModelSelection(conversation),
    title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    task: task ? toTaskSummary(task) : null,
  };
}
