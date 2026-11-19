import type pg from 'pg';

import type { RuntimeBridgeClient } from '@moyu/runtime-client';

import { appendEventSql } from './events-sql';
import type { DispatcherLogger } from './logger';
import type { RepositoryBinding } from './runtime';
import { bridgeErrorMessage } from './runtime';
import { stateFromSnapshot, TASK_COLUMNS, taskSummary, type TaskRow } from './tasks';
import { routedTargetLabel, sendRoutedNotice } from './routed-notices';

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
      // The worker reports on the target Ticket's own conversation. A routed
      // source asked in another conversation and needs its own Chinese
      // completion receipt. Evaluate this on every report tick, not only when a
      // new result message was inserted: the delivery/read receipt may land just
      // after this tick, and the notice must then be attributable to this
      // rework rather than to the previous report.
      const state = stateFromSnapshot(snapshot.state);
      if (state && ['awaiting_review', 'completed', 'closed_unmerged'].includes(state)) {
        const label = routedTargetLabel(task);
        const body =
          state === 'awaiting_review'
            ? `已转交的返修已完成，${label} 已更新，等待审阅。`
            : state === 'completed'
              ? `已转交的返修已完成，${label} 已结束。`
              : `已转交的返修的 PR 已关闭但未合并；如需继续，请在目标工单里说明。`;
        await sendRoutedNotice(client, repository, task, {
          body,
          eventKey: `report:${report.at}`,
          notBefore: report.at,
          requireDelivery: true,
          targetAssignmentId: report.assignmentId ?? null,
        });
      }
      // The snapshot names its first followed PR, which can be historical. Only
      // fill an empty pointer here; a later artifact event is the ordering
      // authority for replacing an already current PR, so a replay cannot swap
      // the owner's current link for an older one.
      if (snapshot.pr && task.prNumber === null) {
        // The in-memory task came from a snapshot read before the Bridge event
        // may have written the current PR. Keep the empty check in the UPDATE so
        // this poller cannot overwrite that newer pointer with the old snapshot.
        const updated = await client.query(
          `update task_links
              set pr_url = $2, pr_number = $3, pr_updated_at = now(), updated_at = now()
            where id = $1 and pr_number is null`,
          [task.id, snapshot.pr.url, snapshot.pr.number],
        );
        if ((updated.rowCount ?? 0) > 0) worked = true;
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
