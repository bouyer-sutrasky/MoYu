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
  input: { body: string; eventKey: string; notBefore?: string | null },
): Promise<number> {
  const sources = await client.query<{
    id: string;
    conversationId: string;
    handedOffAt: string | null;
  }>(
    `select id, conversation_id as "conversationId", decision->>'handedOffAt' as "handedOffAt"
       from task_links
      where repository_id = $1
        and decision->>'outcome' = 'routed'
        and decision->>'targetTaskId' = $2`,
    [repository.id, target.id],
  );
  let sent = 0;
  for (const source of sources.rows) {
    if (
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
