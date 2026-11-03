import type pg from 'pg';

import type { RuntimeBridgeClient } from '@moyu/runtime-client';

import { appendEventSql } from './events-sql';
import type { DispatcherLogger } from './logger';
import type { RepositoryBinding } from './runtime';
import { bridgeErrorMessage } from './runtime';
import { stateFromSnapshot, TASK_COLUMNS, taskSummary, type TaskRow } from './tasks';

interface ReportTaskRow extends TaskRow {
  ownerId: string;
}

/**
 * Copies a runtime ticket's terminal report into the conversation. A discuss
 * ticket's ready report is the plan the owner approves, and an execute ticket's
 * ready report is its result; neither is a Channel message by itself, so the
 * platform reads the authoritative snapshot and stores it as a `result` message
 * exactly once per report timestamp.
 */
export async function captureReportsOnce(
  pool: pg.Pool,
  repository: RepositoryBinding,
  bridge: RuntimeBridgeClient,
  logger: DispatcherLogger,
): Promise<boolean> {
  const tasks = await pool.query<ReportTaskRow>(
    `select ${TASK_COLUMNS}, c.owner_id as "ownerId"
       from task_links t
       join conversations c on c.id = t.conversation_id
      where t.repository_id = $1
        and t.upstream_ticket_id is not null
        and t.state::text in ('awaiting_review', 'completed', 'closed_unmerged', 'blocked', 'failed')
      order by t.updated_at desc
      limit 20`,
    [repository.id],
  );
  if (tasks.rows.length === 0) {
    return false;
  }
  let worked = false;
  for (const task of tasks.rows) {
    let snapshot;
    try {
      snapshot = await bridge.ticket(task.upstreamTicketId ?? '');
    } catch (error) {
      logger.warn(
        { event: 'report.capture_failed', taskId: task.id, error: bridgeErrorMessage(error) },
        'could not read the runtime ticket report',
      );
      continue;
    }
    const report = snapshot.report;
    if (!report || !report.summary.trim()) {
      continue;
    }
    const sourceEventId = `report:${task.upstreamTicketId}:${report.at}`;
    const client = await pool.connect();
    try {
      await client.query('begin');
      // A worker may report the same summary twice with different timestamps;
      // the conversation shows one result, not a duplicate per report tick.
      const inserted = await client.query<{ id: string }>(
        `insert into messages
           (conversation_id, direction, kind, body, source, source_event_id, created_at)
         select $1, 'outbound', 'result', $2, 'workspace', $3, now()
          where not exists (
            select 1 from messages
             where conversation_id = $1 and kind = 'result' and body = $2
          )
         on conflict (conversation_id, source_event_id) where source_event_id is not null
         do nothing
         returning id`,
        [task.conversationId, report.summary, sourceEventId],
      );
      const messageId = inserted.rows[0]?.id;
      if (messageId) {
        await appendEventSql(client, {
          type: 'message.created',
          source: 'dispatcher',
          sourceEventId,
          repositoryId: repository.id,
          conversationId: task.conversationId,
          taskId: task.id,
          payload: { messageId, direction: 'outbound' },
        });
        worked = true;
      }
      const state = stateFromSnapshot(snapshot.state);
      if (snapshot.pr && (snapshot.pr.url !== task.prUrl || snapshot.pr.number !== task.prNumber)) {
        await client.query(
          `update task_links set pr_url = $2, pr_number = $3, updated_at = now() where id = $1`,
          [task.id, snapshot.pr.url, snapshot.pr.number],
        );
        worked = true;
      }
      await client.query('commit');
      if (state && state !== task.state) {
        logger.info(
          {
            event: 'report.captured',
            taskId: task.id,
            reportState: report.state,
            taskState: state,
          },
          'captured a runtime report into the conversation',
        );
      }
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      logger.warn(
        { event: 'report.capture_failed', taskId: task.id, error: bridgeErrorMessage(error) },
        'could not store the runtime report',
      );
    } finally {
      client.release();
    }
  }
  return worked;
}

export { taskSummary };
