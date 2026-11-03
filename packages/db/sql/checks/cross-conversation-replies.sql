-- Read-only check: messages whose reply target belongs to another conversation.
--
-- Run against the target database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/sql/checks/cross-conversation-replies.sql
--
-- The transaction is READ ONLY, so this check cannot change data. It returns one
-- row: violation_count plus a JSON array of the offending record ids.
BEGIN TRANSACTION READ ONLY;

WITH violations AS (
  SELECT
    reply.id AS message_id,
    reply.conversation_id AS message_conversation_id,
    target.id AS reply_to_message_id,
    target.conversation_id AS reply_to_conversation_id
  FROM messages AS reply
  JOIN messages AS target ON target.id = reply.reply_to_message_id
  WHERE reply.conversation_id <> target.conversation_id
)
SELECT
  (SELECT count(*) FROM violations) AS violation_count,
  coalesce(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'message_id', message_id,
          'message_conversation_id', message_conversation_id,
          'reply_to_message_id', reply_to_message_id,
          'reply_to_conversation_id', reply_to_conversation_id
        )
        ORDER BY message_id
      )
      FROM violations
    ),
    '[]'::jsonb
  ) AS violations;

COMMIT;
