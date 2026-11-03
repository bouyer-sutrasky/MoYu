-- Reverse 0002_brief_war_machine: drop M3 indexes, columns and the runtime cursor table,
-- then remove the Drizzle migration row so the migration can be re-applied.
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v hash="$(sha256sum packages/db/migrations/0002_brief_war_machine.sql | cut -d' ' -f1)" -f this-file
DROP INDEX IF EXISTS "conversations_owner_client_request_uq";
DROP INDEX IF EXISTS "messages_conversation_source_event_uq";
ALTER TABLE "task_links" DROP COLUMN IF EXISTS "last_event_seq";
ALTER TABLE "task_links" DROP COLUMN IF EXISTS "pr_number";
ALTER TABLE "task_links" DROP COLUMN IF EXISTS "pr_url";
ALTER TABLE "task_links" DROP COLUMN IF EXISTS "question_message_id";
ALTER TABLE "task_links" DROP COLUMN IF EXISTS "question";
ALTER TABLE "task_links" DROP COLUMN IF EXISTS "model_reasoning_effort";
ALTER TABLE "repositories" DROP COLUMN IF EXISTS "bridge_credential_ref";
ALTER TABLE "repositories" DROP COLUMN IF EXISTS "bridge_url";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "source_event_id";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "evidence";
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "last_attempt_at";
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "read_at";
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "handed_to_worker_at";
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "delivered_at";
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "upstream_trigger_id";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "request_fingerprint";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "client_request_id";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "model_reasoning_effort";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "title";
DROP TABLE IF EXISTS "runtime_cursors" CASCADE;
DELETE FROM drizzle.__drizzle_migrations WHERE hash = :'hash';
