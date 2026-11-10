-- Reverse 0015: artifacts.message_id, which links an uploaded attachment to the
-- message it was sent with. Plain SQL, transactional, and it verifies the ledger
-- row itself so a re-run refuses instead of silently doing nothing.
BEGIN;
DO $$
DECLARE
  expected constant text := 'b50ad051f0dac6e0740722a345b64a0cdb3c0f392042d0858df75a295e729584';
  present integer;
  applied_id integer;
  later integer;
BEGIN
  SELECT count(*) INTO present FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF present <> 1 THEN
    RAISE EXCEPTION '0015 rollback refused: expected exactly one applied 0015 migration, found %', present;
  END IF;
  SELECT id INTO applied_id FROM drizzle.__drizzle_migrations WHERE hash = expected;
  -- The ledger id grows in application order, so any row with a larger id was
  -- applied after 0015. Rolling 0015 back underneath them would leave later
  -- migrations' schema and ledger installed against a missing column.
  SELECT count(*) INTO later FROM drizzle.__drizzle_migrations WHERE id > applied_id;
  IF later <> 0 THEN
    RAISE EXCEPTION '0015 rollback refused: % later migration(s) are already applied; roll them back first', later;
  END IF;
  -- Drop the applied-migration ledger row in the same block so the 64-bit hash
  -- is written once; PL/pgSQL can reference `expected` here (a DO block's
  -- DECLARE scope), while the statements outside cannot.
  DELETE FROM drizzle.__drizzle_migrations WHERE hash = expected;
END $$;
DROP INDEX IF EXISTS "artifacts_message_idx";
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_message_id_messages_id_fk";
ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "message_id";
COMMIT;
