-- Reverse 0004_nappy_yellowjacket: drop the composite foreign keys, their
-- supporting unique indexes and the migration row.
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v hash="$(sha256sum packages/db/migrations/0004_nappy_yellowjacket.sql | cut -d' ' -f1)" -f this-file
-- Dropping the constraints only removes the new integrity checks; it does not
-- touch any message or task-link row.
ALTER TABLE IF EXISTS "task_links" DROP CONSTRAINT IF EXISTS "task_links_conversation_repository_fk";
ALTER TABLE IF EXISTS "messages" DROP CONSTRAINT IF EXISTS "messages_reply_same_conversation_fk";
DROP INDEX IF EXISTS "messages_id_conversation_uq";
DROP INDEX IF EXISTS "conversations_id_repository_uq";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = :'hash';
