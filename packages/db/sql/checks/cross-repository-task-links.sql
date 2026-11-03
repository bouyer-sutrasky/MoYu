-- Read-only check: task links whose repository differs from the repository of
-- their conversation.
--
-- Run against the target database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/sql/checks/cross-repository-task-links.sql
--
-- The transaction is READ ONLY, so this check cannot change data. It returns one
-- row: violation_count plus a JSON array of the offending record ids.
BEGIN TRANSACTION READ ONLY;

WITH violations AS (
  SELECT
    task.id AS task_link_id,
    task.conversation_id,
    task.repository_id AS task_repository_id,
    conversation.repository_id AS conversation_repository_id,
    task.upstream_ticket_id,
    task.state::text AS state
  FROM task_links AS task
  JOIN conversations AS conversation ON conversation.id = task.conversation_id
  WHERE task.repository_id <> conversation.repository_id
)
SELECT
  (SELECT count(*) FROM violations) AS violation_count,
  coalesce(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'task_link_id', task_link_id,
          'conversation_id', conversation_id,
          'task_repository_id', task_repository_id,
          'conversation_repository_id', conversation_repository_id,
          'upstream_ticket_id', upstream_ticket_id,
          'state', state
        )
        ORDER BY task_link_id
      )
      FROM violations
    ),
    '[]'::jsonb
  ) AS violations;

COMMIT;
