import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  artifactListDataSchema,
  conversationDetailDataSchema,
  conversationListDataSchema,
  createConversationInputSchema,
  createMessageDataSchema,
  createMessageInputSchema,
  messageListDataSchema,
  modelListDataSchema,
  type ConversationSummary,
  type ModelOption,
} from '@moyu/contracts';
import {
  artifacts,
  conversations,
  deliveries,
  messages,
  taskLinks,
  taskOperations,
  type Database,
  type Delivery,
  type Message as MessageRow,
  type TaskLink,
  type TaskOperation,
} from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import { toConversationSummary, toMessage } from '../domain/serialize';
import { ensureConfiguredRepository, findOwnedRepository } from '../domain/repositories';
import { appendEvent, type DatabaseTransaction } from '../events/append';
import { eventToWorkspaceEvent } from '../events/format';
import type { AppEventBus } from '../events/bus';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';
import { isUniqueViolation, postgresError } from '../lib/pg';
import { createBridgeClient } from '../runtime/bridge';

export interface ConversationRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
  events: AppEventBus;
}

const MESSAGE_PAGE_DEFAULT = 100;
const MESSAGE_PAGE_MAX = 200;

function conversationFingerprint(input: {
  repositoryId: string;
  mode: string;
  executionMode: string;
  baseBranch: string;
  model?: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        repositoryId: input.repositoryId,
        mode: input.mode,
        executionMode: input.executionMode,
        baseBranch: input.baseBranch,
        model: input.model ?? null,
      }),
    )
    .digest('hex');
}

function deriveTitle(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 80 ? `${single.slice(0, 79)}…` : single;
}

function encodeModel(model: { provider: string; model: string } | null | undefined): string | null {
  return model ? `${model.provider}/${model.model}` : null;
}

async function loadConversationRow(
  database: Database | DatabaseTransaction,
  ownerId: string,
  conversationId: string,
): Promise<{ conversation: typeof conversations.$inferSelect; task: TaskLink | null }> {
  const [conversation] = await database
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.ownerId, ownerId)))
    .limit(1);
  if (!conversation) {
    throw ApiProblem.notFound('Conversation not found');
  }
  const [task] = await database
    .select()
    .from(taskLinks)
    .where(eq(taskLinks.conversationId, conversation.id))
    .limit(1);
  return { conversation, task: task ?? null };
}

async function taskByConversation(
  database: Database,
  conversationId: string,
): Promise<TaskLink | null> {
  const [task] = await database
    .select()
    .from(taskLinks)
    .where(eq(taskLinks.conversationId, conversationId))
    .limit(1);
  return task ?? null;
}

/**
 * The newest owner command for each task, so a conversation shows a pending
 * stop/start without a second request per row.
 */
async function latestOperations(
  database: Database,
  taskIds: string[],
): Promise<Map<string, TaskOperation>> {
  const result = new Map<string, TaskOperation>();
  if (taskIds.length === 0) {
    return result;
  }
  const rows = await database
    .select()
    .from(taskOperations)
    .where(inArray(taskOperations.taskId, taskIds))
    .orderBy(desc(taskOperations.createdAt), desc(taskOperations.id));
  for (const row of rows) {
    if (!result.has(row.taskId)) {
      result.set(row.taskId, row);
    }
  }
  return result;
}

async function latestOperation(database: Database, taskId: string): Promise<TaskOperation | null> {
  return (await latestOperations(database, [taskId])).get(taskId) ?? null;
}

/**
 * The database enforces that a reply target belongs to the same conversation.
 * Checking here as well lets the API return a deliberate 422 instead of a raw
 * foreign-key error, before any message or delivery row is written.
 */
async function assertReplyTargetBelongsToConversation(
  database: Database,
  conversationId: string,
  replyToMessageId: string | null,
): Promise<void> {
  if (!replyToMessageId) {
    return;
  }
  const [target] = await database
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, replyToMessageId))
    .limit(1);
  if (!target) {
    throw ApiProblem.invalid('replyToMessageId does not reference an existing message');
  }
  if (target.conversationId !== conversationId) {
    throw ApiProblem.invalid('replyToMessageId must reference a message in the same conversation');
  }
}

async function loadMessages(
  database: Database,
  conversationId: string,
  before: string | undefined,
  limit: number,
): Promise<{ messages: MessageRow[]; deliveriesById: Map<string, Delivery>; hasMore: boolean }> {
  const rows = await database
    .select({ message: messages, delivery: deliveries })
    .from(messages)
    .leftJoin(deliveries, eq(deliveries.messageId, messages.id))
    .where(
      before
        ? and(eq(messages.conversationId, conversationId), lt(messages.createdAt, new Date(before)))
        : eq(messages.conversationId, conversationId),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit).reverse();
  const deliveriesById = new Map<string, Delivery>();
  for (const row of page) {
    if (row.delivery) {
      deliveriesById.set(row.message.id, row.delivery);
    }
  }
  return {
    messages: page.map((row) => row.message),
    deliveriesById,
    hasMore: rows.length > limit,
  };
}

export function registerConversationRoutes(
  app: FastifyInstance,
  dependencies: ConversationRouteDependencies,
): void {
  const { config, database, authenticate, events } = dependencies;

  const publish = (event: unknown) => {
    const parsed = eventToWorkspaceEvent(event as Parameters<typeof eventToWorkspaceEvent>[0]);
    if (parsed) {
      events.publishWorkspaceEvent(parsed);
    }
  };

  app.get('/api/v1/conversations', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    await ensureConfiguredRepository(database, config);
    const query = request.query as { repositoryId?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    const rows = await database
      .select({ conversation: conversations, task: taskLinks })
      .from(conversations)
      .leftJoin(taskLinks, eq(taskLinks.conversationId, conversations.id))
      .where(
        query.repositoryId
          ? and(
              eq(conversations.ownerId, auth.owner.id),
              eq(conversations.repositoryId, query.repositoryId),
            )
          : eq(conversations.ownerId, auth.owner.id),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(limit);

    const operations = await latestOperations(
      database,
      rows.flatMap((row) => (row.task ? [row.task.id] : [])),
    );
    const items: ConversationSummary[] = rows.map((row) =>
      toConversationSummary(
        row.conversation,
        row.task ?? null,
        row.conversation.title,
        row.task ? (operations.get(row.task.id) ?? null) : null,
      ),
    );
    return sendData(reply, request, conversationListDataSchema.parse({ conversations: items }));
  });

  app.post('/api/v1/conversations', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    const input = parseInput(createConversationInputSchema, request.body);
    if (input.mode !== 'work') {
      throw ApiProblem.invalid('Chat conversations are not part of Work');
    }
    await ensureConfiguredRepository(database, config);
    const repository = await findOwnedRepository(database, auth.owner.id, input.repositoryId);
    if (!repository) {
      throw ApiProblem.notFound('Repository not found');
    }
    const fingerprint = conversationFingerprint(input);
    const modelId = encodeModel(input.model);
    const reasoningEffort = input.model?.reasoningEffort ?? null;

    try {
      const created = await database.transaction(async (transaction) => {
        const [conversation] = await transaction
          .insert(conversations)
          .values({
            ownerId: auth.owner.id,
            repositoryId: repository.id,
            mode: 'work',
            executionMode: input.executionMode,
            baseBranch: input.baseBranch,
            modelId,
            modelReasoningEffort: reasoningEffort,
            clientRequestId: input.clientRequestId,
            requestFingerprint: fingerprint,
          })
          .returning();
        if (!conversation) {
          throw new Error('conversation insert returned no row');
        }
        const [task] = await transaction
          .insert(taskLinks)
          .values({
            conversationId: conversation.id,
            repositoryId: repository.id,
            state: 'pending_admission',
            baseBranch: input.baseBranch,
            modelId,
            modelReasoningEffort: reasoningEffort,
            executionMode: input.executionMode,
          })
          .returning();
        if (!task) {
          throw new Error('task link insert returned no row');
        }
        return { conversation, task };
      });

      return sendData(
        reply,
        request,
        conversationDetailDataSchema.parse({
          conversation: toConversationSummary(
            created.conversation,
            created.task,
            created.conversation.title,
          ),
        }),
        201,
      );
    } catch (error) {
      if (!isUniqueViolation(error, 'conversations_owner_client_request_uq')) {
        throw error;
      }
      const [existing] = await database
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, auth.owner.id),
            eq(conversations.clientRequestId, input.clientRequestId),
          ),
        )
        .limit(1);
      if (!existing) {
        throw error;
      }
      if (existing.requestFingerprint !== fingerprint) {
        throw ApiProblem.conflict(
          'clientRequestId was already used for a different conversation request',
        );
      }
      const task = await taskByConversation(database, existing.id);
      const operation = task ? await latestOperation(database, task.id) : null;
      return sendData(
        reply,
        request,
        conversationDetailDataSchema.parse({
          conversation: toConversationSummary(existing, task, existing.title, operation),
        }),
        200,
      );
    }
  });

  app.get('/api/v1/conversations/:id', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    const params = request.params as { id?: string };
    const { conversation, task } = await loadConversationRow(
      database,
      auth.owner.id,
      params.id ?? '',
    );
    const operation = task ? await latestOperation(database, task.id) : null;
    return sendData(
      reply,
      request,
      conversationDetailDataSchema.parse({
        conversation: toConversationSummary(conversation, task, conversation.title, operation),
      }),
    );
  });

  app.get(
    '/api/v1/conversations/:id/messages',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const { conversation } = await loadConversationRow(database, auth.owner.id, params.id ?? '');
      const query = request.query as { before?: string; limit?: string };
      const limit = Math.min(
        Math.max(Number(query.limit ?? MESSAGE_PAGE_DEFAULT) || MESSAGE_PAGE_DEFAULT, 1),
        MESSAGE_PAGE_MAX,
      );
      const page = await loadMessages(database, conversation.id, query.before, limit);
      return sendData(
        reply,
        request,
        messageListDataSchema.parse({
          messages: page.messages.map((row) =>
            toMessage(row, page.deliveriesById.get(row.id) ?? null),
          ),
          nextCursor: page.hasMore ? page.messages[0]?.createdAt.toISOString() : null,
        }),
      );
    },
  );

  app.post(
    '/api/v1/conversations/:id/messages',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const { conversation, task } = await loadConversationRow(
        database,
        auth.owner.id,
        params.id ?? '',
      );
      if (!task) {
        throw ApiProblem.conflict('Conversation has no task');
      }
      // A completed or closed-unmerged task keeps its conversation and worktree,
      // but M4 does not silently reopen it for a new message: the owner starts a
      // linked task or explicitly resumes a stopped one.
      if (
        task.state === 'completed' ||
        task.state === 'closed_unmerged' ||
        task.state === 'not_accepted'
      ) {
        throw ApiProblem.conflict(
          'This conversation has ended; create a linked task or resume it explicitly',
        );
      }
      const input = parseInput(createMessageInputSchema, request.body);
      await assertReplyTargetBelongsToConversation(
        database,
        conversation.id,
        input.replyToMessageId ?? null,
      );

      let created: { message: MessageRow; delivery: Delivery; event: unknown } | null = null;
      try {
        created = await database.transaction(async (transaction) => {
          const [message] = await transaction
            .insert(messages)
            .values({
              conversationId: conversation.id,
              direction: 'inbound',
              kind: 'user',
              clientMessageId: input.clientMessageId,
              body: input.text,
              replyToMessageId: input.replyToMessageId ?? null,
              source: 'web',
            })
            .returning();
          if (!message) {
            throw new Error('message insert returned no row');
          }
          const upstreamTriggerId = `workspace:${message.id}`;
          const [delivery] = await transaction
            .insert(deliveries)
            .values({ messageId: message.id, upstreamTriggerId })
            .returning();
          if (!delivery) {
            throw new Error('delivery insert returned no row');
          }
          await transaction
            .update(conversations)
            .set({
              title: conversation.title ?? deriveTitle(input.text),
              updatedAt: new Date(),
            })
            .where(eq(conversations.id, conversation.id));
          const event = await appendEvent(transaction, {
            type: 'message.created',
            repositoryId: conversation.repositoryId,
            conversationId: conversation.id,
            payload: { messageId: message.id, direction: 'inbound' },
          });
          return { message, delivery, event };
        });
      } catch (error) {
        if (postgresError(error).constraint === 'messages_reply_same_conversation_fk') {
          throw ApiProblem.invalid(
            'replyToMessageId must reference a message in the same conversation',
          );
        }
        if (!isUniqueViolation(error, 'messages_conversation_client_message_uq')) {
          throw error;
        }
        const [existing] = await database
          .select({ message: messages, delivery: deliveries })
          .from(messages)
          .leftJoin(deliveries, eq(deliveries.messageId, messages.id))
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              eq(messages.clientMessageId, input.clientMessageId),
            ),
          )
          .limit(1);
        if (!existing) {
          throw error;
        }
        const samePayload =
          existing.message.body === input.text &&
          (existing.message.replyToMessageId ?? null) === (input.replyToMessageId ?? null);
        if (!samePayload) {
          throw ApiProblem.conflict(
            'clientMessageId was already used for a different message payload',
          );
        }
        return sendData(
          reply,
          request,
          createMessageDataSchema.parse({
            message: toMessage(existing.message, existing.delivery ?? null),
            duplicate: true,
          }),
          200,
        );
      }

      if (created.event) {
        publish(created.event);
      }
      return sendData(
        reply,
        request,
        createMessageDataSchema.parse({
          message: toMessage(created.message, created.delivery),
          duplicate: false,
        }),
        202,
      );
    },
  );

  app.get('/api/v1/tasks/:id/artifacts', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      throw ApiProblem.unauthorized();
    }
    const params = request.params as { id?: string };
    const [task] = await database
      .select({ task: taskLinks, conversation: conversations })
      .from(taskLinks)
      .innerJoin(conversations, eq(taskLinks.conversationId, conversations.id))
      .where(and(eq(taskLinks.id, params.id ?? ''), eq(conversations.ownerId, auth.owner.id)))
      .limit(1);
    if (!task) {
      throw ApiProblem.notFound('Task not found');
    }
    const rows = await database
      .select()
      .from(artifacts)
      .where(eq(artifacts.taskId, task.task.id))
      .orderBy(desc(artifacts.createdAt));
    return sendData(
      reply,
      request,
      artifactListDataSchema.parse({
        artifacts: rows.map((row) => ({
          id: row.id,
          taskId: row.taskId,
          conversationId: row.conversationId,
          type: row.type,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          sha256: row.sha256,
          metadata: row.metadata,
          createdAt: row.createdAt.toISOString(),
        })),
      }),
    );
  });

  app.get(
    '/api/v1/repositories/:id/models',
    { preHandler: authenticate },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const repository = await findOwnedRepository(database, auth.owner.id, params.id ?? '');
      if (!repository) {
        throw ApiProblem.notFound('Repository not found');
      }
      let models: ModelOption[];
      try {
        const bridge = createBridgeClient(config, repository);
        const catalog = await bridge.models();
        models = catalog.models.map((model) => ({
          provider: model.provider,
          model: model.model,
          displayName: model.displayName ?? null,
          reasoningEfforts: model.reasoningEfforts ?? [],
        }));
      } catch (error) {
        request.log.warn(
          { err: error, event: 'bridge.models_unavailable' },
          'model catalog unavailable',
        );
        throw ApiProblem.unavailable('The repository runtime is not reachable');
      }
      return sendData(
        reply,
        request,
        modelListDataSchema.parse({ repositoryId: repository.id, models }),
      );
    },
  );
}
