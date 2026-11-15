import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  activityDataSchema,
  activityQuerySchema,
  type ActivityCategory,
  type ActivityItem,
  type ActivityRunningItem,
} from '@moyu/contracts';
import type { Database } from '@moyu/db';

import type { Authenticate } from '../auth/guards';
import { ApiProblem } from '../lib/errors';
import { parseInput, sendData } from '../lib/http';

export interface ActivityRouteDependencies {
  database: Database;
  authenticate: Authenticate;
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

const NOTIFICATION_STATES = [
  'waiting_input',
  'awaiting_review',
  'completed',
  'failed',
  'blocked',
  'closed_unmerged',
] as const;

const RUNNING_STATES = [
  'pending_admission',
  'queued',
  'discussing',
  'running',
  'stopping',
] as const;

function categoryFor(taskState: string): ActivityCategory | null {
  switch (taskState) {
    case 'waiting_input':
      return 'needs_reply';
    case 'awaiting_review':
      return 'review';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'blocked':
    case 'closed_unmerged':
      return 'failed';
    default:
      return null;
  }
}

function summaryFor(type: string, taskState: string, question: string | null): string {
  if (type === 'task.question') {
    const trimmed = question?.trim();
    return trimmed ? trimmed.slice(0, 180) : '执行器正在等待你的回复';
  }
  switch (taskState) {
    case 'waiting_input':
      return '任务等待你的回复';
    case 'awaiting_review':
      return '任务已提交，等待审阅';
    case 'completed':
      return '任务已完成';
    case 'closed_unmerged':
      return 'PR 已关闭但未合并';
    case 'blocked':
      return '任务受阻，需要人工处理';
    default:
      return '任务执行失败';
  }
}

function isoValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function seqString(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  return null;
}

/**
 * Owner-scoped activity feed. It reads only the durable event log, so the same
 * alert shown while a page is open can also be reviewed after a reload. Browser
 * notification delivery and its usage of the event id as dedupe key live in the
 * web client; this route never invents an event.
 */
export function registerActivityRoutes(
  app: FastifyInstance,
  dependencies: ActivityRouteDependencies,
): void {
  const { database, authenticate } = dependencies;

  app.get('/api/v1/activity', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw ApiProblem.unauthorized();
    const query = parseInput(activityQuerySchema, request.query);
    const limit = Math.min(query.limit ?? PAGE_DEFAULT, PAGE_MAX);
    const before = query.beforeSeq ?? null;

    const notificationResult = await database.execute(sql`
      select
        e.id,
        e.seq,
        e.type,
        e.repository_id,
        e.conversation_id,
        e.task_id,
        e.payload,
        e.occurred_at,
        c.title,
        r.full_name as repository_name,
        e.payload -> 'task' ->> 'state' as task_state,
        e.payload -> 'task' ->> 'question' as question
      from events e
      join repositories r on r.id = e.repository_id and r.owner_id = ${auth.owner.id}
      join conversations c on c.id = e.conversation_id
      where e.type in ('task.question', 'task.state_changed')
        and (
          e.type = 'task.question'
          or e.payload -> 'task' ->> 'state' in (${sql.join(
            NOTIFICATION_STATES.map((state) => sql`${state}`),
            sql`, `,
          )})
        )
        and (${before === null ? sql`true` : sql`e.seq < ${before}`})
      order by e.seq desc
      limit ${limit + 1}
    `);

    const rawRows = notificationResult.rows as unknown as Array<Record<string, unknown>>;
    const hasMore = rawRows.length > limit;
    const pageRows = rawRows.slice(0, limit);
    const notifications: ActivityItem[] = [];
    for (const row of pageRows) {
      const id = typeof row.id === 'string' ? row.id : null;
      const seq = seqString(row.seq);
      const type = typeof row.type === 'string' ? row.type : '';
      const repositoryId = typeof row.repository_id === 'string' ? row.repository_id : null;
      const conversationId = typeof row.conversation_id === 'string' ? row.conversation_id : null;
      const repositoryName = typeof row.repository_name === 'string' ? row.repository_name : null;
      const taskState = typeof row.task_state === 'string' ? row.task_state : '';
      const occurredAt = isoValue(row.occurred_at);
      if (!id || !seq || !repositoryId || !conversationId || !repositoryName || !occurredAt) {
        continue;
      }
      const category = categoryFor(taskState);
      if (!category) continue;
      notifications.push({
        id,
        seq,
        category,
        state: taskState as ActivityItem['state'],
        repositoryId,
        repositoryName,
        conversationId,
        taskId: typeof row.task_id === 'string' ? row.task_id : null,
        title: typeof row.title === 'string' ? row.title : null,
        summary: summaryFor(
          type,
          taskState,
          typeof row.question === 'string' ? row.question : null,
        ),
        occurredAt,
      });
    }

    const runningResult = await database.execute(sql`
      select
        t.id as task_id,
        t.conversation_id,
        t.state,
        t.updated_at,
        c.title,
        r.id as repository_id,
        r.full_name as repository_name
      from task_links t
      join conversations c on c.id = t.conversation_id
      join repositories r on r.id = t.repository_id and r.owner_id = ${auth.owner.id}
      where t.state::text in (${sql.join(
        RUNNING_STATES.map((state) => sql`${state}`),
        sql`, `,
      )})
      order by t.updated_at desc
      limit 20
    `);
    const running: ActivityRunningItem[] = [];
    for (const row of runningResult.rows as unknown as Array<Record<string, unknown>>) {
      const updatedAt = isoValue(row.updated_at);
      if (
        typeof row.task_id !== 'string' ||
        typeof row.conversation_id !== 'string' ||
        typeof row.repository_id !== 'string' ||
        typeof row.repository_name !== 'string' ||
        typeof row.state !== 'string' ||
        !updatedAt
      ) {
        continue;
      }
      running.push({
        conversationId: row.conversation_id,
        repositoryId: row.repository_id,
        repositoryName: row.repository_name,
        taskId: row.task_id,
        title: typeof row.title === 'string' ? row.title : null,
        state: row.state as ActivityRunningItem['state'],
        updatedAt,
      });
    }

    const lastRaw = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && lastRaw ? seqString(lastRaw.seq) : null;
    return sendData(
      reply,
      request,
      activityDataSchema.parse({ notifications, running, nextCursor, hasMore }),
    );
  });
}
