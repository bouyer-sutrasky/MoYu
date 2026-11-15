import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  runtimeEventDataSchema,
  runtimeEventInputSchema,
  uuidSchema,
  type TaskSummary,
} from '@moyu/contracts';
import {
  artifacts,
  conversations,
  messages,
  repositories,
  taskLinks,
  type Database,
  type TaskLink,
} from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import { sendStoredAttachment } from '../domain/attachments';
import { toTaskSummary } from '../domain/serialize';
import { appendEvent } from '../events/append';
import { eventToWorkspaceEvent } from '../events/format';
import type { AppEventBus } from '../events/bus';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';
import { isUniqueViolation } from '../lib/pg';
import { verifyCallbackToken } from '../runtime/bridge';

export interface RuntimeRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
  machineAuthenticate: Authenticate;
  events: AppEventBus;
}

function taskForTicket(
  database: Database,
  repositoryId: string,
  ticketId: string | null,
): Promise<TaskLink | null> {
  if (!ticketId) {
    return Promise.resolve(null);
  }
  return database
    .select()
    .from(taskLinks)
    .where(and(eq(taskLinks.repositoryId, repositoryId), eq(taskLinks.upstreamTicketId, ticketId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function taskForConversation(
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
 * Machine callback surface for the repository Bridge. The Bridge's workspace
 * Channel only acknowledges a queued outbound message after this route commits,
 * so a platform crash leaves the message pending upstream and it is retried.
 * `(conversation_id, source_event_id)` is the database idempotency boundary.
 */
export function registerRuntimeRoutes(
  app: FastifyInstance,
  dependencies: RuntimeRouteDependencies,
): void {
  const { config, database, machineAuthenticate, events } = dependencies;

  app.post(
    '/api/internal/v1/runtime-events',
    { preHandler: machineAuthenticate },
    async (request, reply) => {
      const input = parseInput(runtimeEventInputSchema, request.body);
      const [conversation] = await database
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1);
      if (!conversation) {
        throw ApiProblem.notFound('Conversation not found');
      }
      const [repository] = await database
        .select()
        .from(repositories)
        .where(eq(repositories.id, conversation.repositoryId))
        .limit(1);
      if (!repository || !verifyCallbackToken(config, repository, request.machineToken ?? '')) {
        throw ApiProblem.unauthorized('Machine token is not valid for this repository');
      }
      const task = await taskForConversation(database, conversation.id);
      if (input.ticketId && task?.upstreamTicketId && task.upstreamTicketId !== input.ticketId) {
        throw ApiProblem.conflict('Ticket does not belong to this conversation');
      }

      try {
        const created = await database.transaction(async (transaction) => {
          const [message] = await transaction
            .insert(messages)
            .values({
              conversationId: conversation.id,
              direction: 'outbound',
              kind: input.messageKind,
              body: input.text,
              source: 'workspace',
              sourceEventId: input.sourceEventId,
            })
            .returning();
          if (!message) {
            throw new Error('message insert returned no row');
          }

          const messageEvent = await appendEvent(transaction, {
            type: 'message.created',
            source: 'bridge',
            repositoryId: conversation.repositoryId,
            conversationId: conversation.id,
            taskId: task?.id ?? null,
            payload: { messageId: message.id, direction: 'outbound' },
          });

          let nextTask: TaskLink | null = task;
          let linkedEvent: Awaited<ReturnType<typeof appendEvent>> = null;
          let questionEvent: Awaited<ReturnType<typeof appendEvent>> = null;
          // The worker's first Channel message can arrive before the dispatcher
          // has projected the Bridge's ticket.linked event. The callback's
          // ticketId is authoritative; linking it here keeps the acknowledgement
          // from being rejected and lets the later projection update it.
          if (input.ticketId && task && !task.upstreamTicketId) {
            const [linked] = await transaction
              .update(taskLinks)
              .set({
                upstreamTicketId: input.ticketId,
                upstreamThreadId: `workspace:${conversation.id}`,
                state: task.state === 'pending_admission' ? 'queued' : task.state,
                version: task.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(taskLinks.id, task.id))
              .returning();
            nextTask = linked ?? task;
            linkedEvent = await appendEvent(transaction, {
              type: 'task.linked',
              source: 'bridge',
              repositoryId: conversation.repositoryId,
              conversationId: conversation.id,
              taskId: task.id,
              payload: { task: toTaskSummary(nextTask) satisfies TaskSummary },
            });
          }
          if (input.messageKind === 'question' && task) {
            const [updated] = await transaction
              .update(taskLinks)
              .set({
                question: input.text,
                questionMessageId: message.id,
                updatedAt: new Date(),
              })
              .where(eq(taskLinks.id, task.id))
              .returning();
            nextTask = updated ?? task;
            questionEvent = await appendEvent(transaction, {
              type: 'task.question',
              source: 'bridge',
              repositoryId: conversation.repositoryId,
              conversationId: conversation.id,
              taskId: task.id,
              payload: { task: toTaskSummary(nextTask) satisfies TaskSummary },
            });
          }
          return { message, linkedEvent, messageEvent, questionEvent, task: nextTask };
        });

        for (const row of [created.linkedEvent, created.messageEvent, created.questionEvent]) {
          const parsed = row ? eventToWorkspaceEvent(row) : null;
          if (parsed) {
            events.publishWorkspaceEvent(parsed);
          }
        }

        return sendData(
          reply,
          request,
          runtimeEventDataSchema.parse({
            messageId: created.message.id,
            duplicate: false,
            task: created.task ? toTaskSummary(created.task) : null,
          }),
        );
      } catch (error) {
        if (!isUniqueViolation(error, 'messages_conversation_source_event_uq')) {
          throw error;
        }
        const [existing] = await database
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              eq(messages.sourceEventId, input.sourceEventId),
            ),
          )
          .limit(1);
        if (!existing) {
          throw error;
        }
        const current = await taskForTicket(database, conversation.repositoryId, input.ticketId);
        return sendData(
          reply,
          request,
          runtimeEventDataSchema.parse({
            messageId: existing.id,
            duplicate: true,
            task: current ? toTaskSummary(current) : null,
          }),
        );
      }
    },
  );

  /**
   * M6-A L113: the repository runtime fetches the bytes of one sent attachment
   * with its machine token. The token is verified against the repository that
   * owns the message's conversation, and the artifact must be bound to that
   * exact message, so a runtime can never read another repository's files or
   * enumerate attachments by id alone. The response always carries
   * `application/octet-stream` and the stored digest, never an inline type.
   */
  app.get(
    '/api/internal/v1/messages/:messageId/attachments/:attachmentId',
    { preHandler: machineAuthenticate },
    async (request, reply) => {
      const params = request.params as { messageId?: string; attachmentId?: string };
      const messageId = parseInput(uuidSchema, params.messageId);
      const attachmentId = parseInput(uuidSchema, params.attachmentId);

      const [message] = await database
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);
      if (!message) {
        throw ApiProblem.notFound('Message not found');
      }
      const [conversation] = await database
        .select()
        .from(conversations)
        .where(eq(conversations.id, message.conversationId))
        .limit(1);
      if (!conversation) {
        throw ApiProblem.notFound('Message not found');
      }
      const [repository] = await database
        .select()
        .from(repositories)
        .where(eq(repositories.id, conversation.repositoryId))
        .limit(1);
      if (!repository || !verifyCallbackToken(config, repository, request.machineToken ?? '')) {
        throw ApiProblem.unauthorized('Machine token is not valid for this repository');
      }

      const [artifact] = await database
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, attachmentId),
            eq(artifacts.type, 'attachment'),
            eq(artifacts.repositoryId, conversation.repositoryId),
            isNull(artifacts.revokedAt),
          ),
        )
        .limit(1);
      if (!artifact) {
        throw ApiProblem.notFound('Attachment not found');
      }
      // An upload that was never sent is not downloadable through a message
      // path; the runtime would otherwise fetch a draft the owner never sent.
      if (!artifact.messageId) {
        throw ApiProblem.conflict('Attachment has not been sent with a message yet');
      }
      // A sent attachment is only reachable through its own message; a missing
      // digest cannot be verified by the runtime, so it is not served either.
      if (artifact.messageId !== messageId || !artifact.sha256) {
        throw ApiProblem.notFound('Attachment not found');
      }
      if (!config.artifactStorageDir) {
        throw ApiProblem.unavailable('Attachment storage is not configured');
      }

      return sendStoredAttachment(reply, config, artifact, {
        contentType: 'application/octet-stream',
        headers: { 'x-moyu-sha256': artifact.sha256 },
      });
    },
  );
}
