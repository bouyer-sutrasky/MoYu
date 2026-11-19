import type pg from 'pg';

import { appendEventSql } from './events-sql';
import type { RepositoryBinding } from './runtime';

export interface RoutedNoticeTarget {
  id: string;
  /** The target's current PR number and URL, when it delivered one. */
  prNumber: number | null;
  prUrl: string | null;
}

/** Chinese label for the target's delivery, used in the completion notice. */
export function routedTargetLabel(target: RoutedNoticeTarget): string {
  return target.prNumber ? `PR #${target.prNumber}` : '目标工单';
}

/**
 * Sends one Chinese notice to every routed source conversation whose target is
 * `target`. `eventKey` makes the insert idempotent per source conversation, so
 * a repeated report tick, a restarted dispatcher or a duplicate Bridge event
 * never posts the same notice twice. `notBefore` keeps a report that predates
 * the handoff from being announced as its result.
 */
export async function sendRoutedNotice(
  client: pg.PoolClient,
  repository: RepositoryBinding,
  target: RoutedNoticeTarget,
  input: {
    body: string;
    eventKey: string;
    notBefore?: string | null;
    /** Completion receipts must follow this rework's actual worker delivery. */
    requireDelivery?: boolean;
    /** The runtime assignment that produced this report, when known. */
    targetAssignmentId?: string | null;
  },
): Promise<number> {
  const sources = await client.query<{
    id: string;
    conversationId: string;
    handedOffAt: string | null;
    deliveryAt: string | null;
    deliveryState: string | null;
    lastReportAt: string | null;
    targetAssignmentId: string | null;
  }>(
    `select id, conversation_id as "conversationId",
            decision->>'handedOffAt' as "handedOffAt",
            decision->>'deliveryAt' as "deliveryAt",
            decision->>'deliveryState' as "deliveryState",
            decision->>'lastReportAt' as "lastReportAt",
            decision->>'targetAssignmentId' as "targetAssignmentId"
       from task_links
      where repository_id = $1
        and decision->>'outcome' = 'routed'
        and decision->>'targetTaskId' = $2`,
    [repository.id, target.id],
  );
  let sent = 0;
  for (const source of sources.rows) {
    if (input.requireDelivery) {
      // Attribute a report by the worker's real delivery/read of this routed
      // input, not by when the dispatcher recorded handedOffAt: a worker can
      // finish and report before the routing loop catches up. A report that
      // predates delivery belongs to an earlier turn.
      const reportAt = input.notBefore ? Date.parse(input.notBefore) : Number.NaN;
      const deliveredAt = source.deliveryAt ? Date.parse(source.deliveryAt) : Number.NaN;
      const lastReportAt = source.lastReportAt ? Date.parse(source.lastReportAt) : Number.NaN;
      const delivered = source.deliveryState === 'delivered' || source.deliveryState === 'read';
      // A report belongs to one runtime assignment. If both sides recorded the
      // assignment, a source from an older rework must not receive the newer
      // report even when it never observed its own report (e.g. the dispatcher
      // was down for that report tick).
      if (
        source.targetAssignmentId &&
        input.targetAssignmentId &&
        source.targetAssignmentId !== input.targetAssignmentId
      ) {
        continue;
      }
      if (
        !delivered ||
        !Number.isFinite(reportAt) ||
        !Number.isFinite(deliveredAt) ||
        reportAt <= deliveredAt ||
        (Number.isFinite(lastReportAt) && lastReportAt >= deliveredAt)
      ) {
        continue;
      }
    } else if (
      input.notBefore &&
      source.handedOffAt &&
      Date.parse(source.handedOffAt) > Date.parse(input.notBefore)
    ) {
      continue;
    }
    const inserted = await client.query<{ id: string }>(
      `insert into messages (conversation_id, direction, kind, body, source, source_event_id)
       values ($1, 'outbound', 'notice', $2, 'dispatcher', $3)
       on conflict (conversation_id, source_event_id) where source_event_id is not null
       do nothing
       returning id`,
      [source.conversationId, input.body, `routed-notice:${target.id}:${input.eventKey}`],
    );
    const messageId = inserted.rows[0]?.id;
    if (!messageId) continue;
    if (input.requireDelivery && input.notBefore) {
      // Mark which result this source has been told about. A later rework input
      // is newer than this marker and can earn its own notice; a repeated poll
      // of the same report cannot notify this source again.
      await client.query(
        `update task_links
            set decision = decision || jsonb_build_object('lastReportAt', $2::text)
          where id = $1`,
        [source.id, input.notBefore],
      );
    }
    await appendEventSql(client, {
      type: 'message.created',
      source: 'dispatcher',
      sourceEventId: `routed-notice:${target.id}:${input.eventKey}:${source.id}`,
      repositoryId: repository.id,
      conversationId: source.conversationId,
      taskId: source.id,
      payload: { messageId, direction: 'outbound' },
    });
    sent += 1;
  }
  return sent;
}
