-- Reverse 0015: artifacts.message_id, which links an uploaded attachment to the
-- message it was sent with. Plain SQL, transactional, and it verifies the ledger
-- row itself so a re-run refuses instead of silently doing nothing.
BEGIN;
DO $$
DECLARE
  expected constant text := 'b50ad051f0dac6e0740722a345b64a0cdb3c0f392042d0858df75a295e729584';
  present integer;
BEGIN
  SELECT count(*) INTO present FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF present <> 1 THEN
    RAISE EXCEPTION '0015 rollback refused: expected exactly one applied 0015 migration, found %', present;
  END IF;
END $$;
DROP INDEX IF EXISTS "artifacts_message_idx";
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_message_id_messages_id_fk";
ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "message_id";
-- Drop the applied-migration ledger row too; without it migrateDatabase still
-- believes 0015 is applied and never recreates the column.
DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'b50ad051f0dac6e0740722a345b64a0cdb3c0f392042d0858df75a295e729584';
COMMIT;
