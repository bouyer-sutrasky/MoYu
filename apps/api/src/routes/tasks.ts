import { createHash } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  startTaskInputSchema,
  taskCommandDataSchema,
  taskCommandInputSchema,
} from '@moyu/contracts';
import {
  conversations,
  repositories,
  taskLinks,
  taskOperations,
  type Conversation,
  type Database,
  type TaskLink,
  type TaskOperation,
} from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import type { ApiConfig } from '../config';
import { toTaskOperationSummary, toTaskSummary } from '../domain/serialize';
import { wakeRepository } from '../domain/instances';
import { appendEvent } from '../events/append';
import { eventToWorkspaceEvent } from '../events/format';
import type { AppEventBus } from '../events/bus';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';
import { postgresError } from '../lib/pg';

export interface TaskRouteDependencies {
  config: ApiConfig;
  database: Database;
  authenticate: Authenticate;
  events: AppEventBus;
}

type CommandKind = 'start' | 'pause' | 'resume' | 'retry';

interface LoadedTask {
  task: TaskLink;
  conversation: Conversation;
}

interface CommandInput {
  expectedVersion: number;
  clientCommandId: string;
  planRevision?: number;
}

/** States from which a human pause is meaningful; a stopped/terminal task is not paused again. */
const STOPPABLE = new Set(['discussing', 'queued', 'running', 'waiting_input', 'awaiting_review']);

const RETRYABLE = new Set(['failed', 'blocked']);

async function loadTask(database: Database, ownerId: string, taskId: string): Promise<LoadedTask> {
  const [row] = await database
    .select({ task: taskLinks, conversation: conversations })
    .from(taskLinks)
    .innerJoin(conversations, eq(taskLinks.conversationId, conversations.id))
    .where(and(eq(taskLinks.id, taskId), eq(conversations.ownerId, ownerId)))
    .limit(1);
  if (!row) {
    throw ApiProblem.notFound('Task not found');
  }
  return row;
}

/** Hash of the command intent, so a reused clientCommandId with a different payload is a conflict. */
function commandFingerprint(kind: CommandKind, input: CommandInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ kind, ...input }))
    .digest('hex');
}

async function findOperation(
  database: Database,
  taskId: string,
  clientCommandId: string,
): Promise<TaskOperation | null> {
  const [row] = await database
    .select()
    .from(taskOperations)
    .where(
      and(eq(taskOperations.taskId, taskId), eq(taskOperations.clientCommandId, clientCommandId)),
    )
    .limit(1);
  return row ?? null;
}

/** The newest command for a task, which the API returns with the task projection. */
async function latestOperation(database: Database, taskId: string): Promise<TaskOperation | null> {
  const [row] = await database
    .select()
    .from(taskOperations)
    .where(eq(taskOperations.taskId, taskId))
    .orderBy(desc(taskOperations.createdAt), desc(taskOperations.id))
    .limit(1);
  return row ?? null;
}

/** Validates a command against the current task and returns the task mutations it implies. */
function planCommand(
  kind: CommandKind,
  task: TaskLink,
  input: CommandInput,
): { state?: TaskLink['state']; planRevision?: number; stopRequestedAt?: Date } {
  if (input.expectedVersion !== task.version) {
    throw ApiProblem.conflict(`Task version changed (expected ${task.version})`);
  }
  if (kind === 'start') {
    if (task.executionMode !== 'discuss') {
      throw ApiProblem.conflict('Only a read-only discussion can be started');
    }
    if (!task.upstreamTicketId) {
      throw ApiProblem.conflict('The runtime has not accepted this task yet');
    }
    if (!task.baseCommit) {
      throw ApiProblem.conflict('The base commit is not resolved yet');
    }
    const planRevision = input.planRevision;
    if (!planRevision || planRevision < 1) {
      throw ApiProblem.invalid('planRevision must be at least 1');
    }
    if (task.planRevision !== null && planRevision <= task.planRevision) {
      throw ApiProblem.conflict('planRevision must be newer than the approved revision');
    }
    return { planRevision };
  }
  if (!task.upstreamTicketId) {
    throw ApiProblem.conflict('The runtime has not accepted this task yet');
  }
  if (kind === 'pause') {
    if (!STOPPABLE.has(task.state)) {
      throw ApiProblem.conflict('Only an active task can be stopped for later continuation');
    }
    return { state: 'stopping', stopRequestedAt: new Date() };
  }
  if (kind === 'resume') {
    if (task.state !== 'stopped') {
      throw ApiProblem.conflict('Only a stopped task can be resumed');
    }
    return {};
  }
  if (!RETRYABLE.has(task.state)) {
    throw ApiProblem.conflict('Only a failed or blocked task can be retried');
  }
  return {};
}

export function registerTaskRoutes(
  app: FastifyInstance,
  dependencies: TaskRouteDependencies,
): void {
  const { config, database, authenticate, events } = dependencies;

  const publish = (event: unknown) => {
    const parsed = event
      ? eventToWorkspaceEvent(event as Parameters<typeof eventToWorkspaceEvent>[0])
      : null;
    if (parsed) {
      events.publishWorkspaceEvent(parsed);
    }
  };

  const wakeForCommand = async (repositoryId: string, kind: CommandKind): Promise<void> => {
    if (kind === 'pause' || !config.supervisorUrl) return;
    const [repository] = await database
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!repository) return;
    await wakeRepository(
      database,
      config,
      repository,
      kind === 'retry' ? 'retry' : kind === 'resume' ? 'reply' : 'new_task',
    );
  };

  const command =
    (kind: CommandKind, schema: z.ZodType<Record<string, unknown>>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        throw ApiProblem.unauthorized();
      }
      const params = request.params as { id?: string };
      const taskId = params.id ?? '';
      const input = parseInput(schema, request.body) as unknown as CommandInput;
      const loaded = await loadTask(database, auth.owner.id, taskId);
      const fingerprint = commandFingerprint(kind, input);

      // Idempotent replay of the same command returns the first operation, even
      // after the task moved on; a different payload under the same key conflicts.
      const existing = await findOperation(database, taskId, input.clientCommandId);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw ApiProblem.conflict(
            'clientCommandId was already used for a different task command',
          );
        }
        const current = await loadTask(database, auth.owner.id, taskId);
        await wakeForCommand(loaded.conversation.repositoryId, kind);
        return sendData(
          reply,
          request,
          taskCommandDataSchema.parse({
            operation: toTaskOperationSummary(existing),
            task: toTaskSummary(current.task, existing),
          }),
          200,
        );
      }

      const planned = planCommand(kind, loaded.task, input);

      let result: {
        operation: TaskOperation;
        task: TaskLink;
        event: unknown;
      };
      try {
        result = await database.transaction(async (transaction) => {
          const [current] = await transaction
            .select()
            .from(taskLinks)
            .where(eq(taskLinks.id, taskId))
            .for('update');
          if (!current) {
            throw ApiProblem.notFound('Task not found');
          }
          // Re-check under the row lock so two concurrent commands cannot both
          // pass the version check; the active-operation index rejects the rest.
          if (input.expectedVersion !== current.version) {
            throw ApiProblem.conflict(`Task version changed (expected ${current.version})`);
          }
          const [operation] = await transaction
            .insert(taskOperations)
            .values({
              taskId,
              repositoryId: current.repositoryId,
              kind,
              clientCommandId: input.clientCommandId,
              requestFingerprint: fingerprint,
            })
            .returning();
          if (!operation) {
            throw new Error('task operation insert returned no row');
          }

          const now = new Date();
          const [updated] = await transaction
            .update(taskLinks)
            .set({
              ...(planned.state ? { state: planned.state, version: current.version + 1 } : {}),
              ...(planned.stopRequestedAt !== undefined
                ? { stopRequestedAt: planned.stopRequestedAt, stopEvidence: {} }
                : {}),
              ...(planned.planRevision !== undefined ? { planRevision: planned.planRevision } : {}),
              updatedAt: now,
            })
            .where(eq(taskLinks.id, taskId))
            .returning();
          if (!updated) {
            throw new Error('task update returned no row');
          }
          if (planned.planRevision !== undefined) {
            await transaction
              .update(conversations)
              .set({
                planRevision: planned.planRevision,
                baseCommit: loaded.conversation.baseCommit ?? current.baseCommit,
                updatedAt: now,
              })
              .where(eq(conversations.id, current.conversationId));
          }

          const event = await appendEvent(transaction, {
            type: 'task.state_changed',
            repositoryId: current.repositoryId,
            conversationId: current.conversationId,
            taskId,
            payload: { task: toTaskSummary(updated, operation) },
          });
          return { operation, task: updated, event };
        });
      } catch (error) {
        if (postgresError(error).constraint === 'task_operations_active_task_uq') {
          throw ApiProblem.conflict('Another task command is still being processed');
        }
        throw error;
      }

      await wakeForCommand(loaded.conversation.repositoryId, kind);
      publish(result.event);
      return sendData(
        reply,
        request,
        taskCommandDataSchema.parse({
          operation: toTaskOperationSummary(result.operation),
          task: toTaskSummary(result.task, result.operation),
        }),
        202,
      );
    };

  app.post(
    '/api/v1/tasks/:id/start',
    { preHandler: authenticate },
    command('start', startTaskInputSchema as unknown as z.ZodType<Record<string, unknown>>),
  );
  app.post(
    '/api/v1/tasks/:id/stop',
    { preHandler: authenticate },
    command('pause', taskCommandInputSchema as unknown as z.ZodType<Record<string, unknown>>),
  );
  app.post(
    '/api/v1/tasks/:id/resume',
    { preHandler: authenticate },
    command('resume', taskCommandInputSchema as unknown as z.ZodType<Record<string, unknown>>),
  );
  app.post(
    '/api/v1/tasks/:id/retry',
    { preHandler: authenticate },
    command('retry', taskCommandInputSchema as unknown as z.ZodType<Record<string, unknown>>),
  );
}

export { latestOperation };
