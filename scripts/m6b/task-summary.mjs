/**
 * Builds the exact `taskSummary` payload the dispatcher writes into SSE events.
 * The SSE consumer validates `workspaceEventSchema`, so a partial `{state}`
 * object would be silently dropped; acceptance fixtures must use a real shape.
 */
export async function taskSummary(client, taskId, overrides = {}) {
  const result = await client.query(
    `select t.*, c.created_at as conversation_created_at
       from task_links t join conversations c on c.id = t.conversation_id
      where t.id = $1`,
    [taskId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`task ${taskId} not found`);
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    repositoryId: row.repository_id,
    state: row.state,
    upstreamTicketId: row.upstream_ticket_id,
    upstreamThreadId: row.upstream_thread_id,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    model: row.model_id
      ? {
          provider: String(row.model_id).split('/')[0] ?? 'commandcode',
          model: String(row.model_id).split('/').slice(1).join('/') || 'unknown',
          reasoningEffort: row.model_reasoning_effort,
        }
      : null,
    executionMode: row.execution_mode,
    question: row.question,
    questionMessageId: row.question_message_id,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    planRevision: row.plan_revision,
    stopRequestedAt: iso(row.stop_requested_at),
    stoppedAt: iso(row.stopped_at),
    stopEvidence: row.stop_evidence ?? {},
    lastOperation: null,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...overrides,
  };
}
