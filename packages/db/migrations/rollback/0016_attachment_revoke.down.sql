-- Reverse 0016: artifacts.revoked_at. Plain SQL, transactional, and it refuses
-- when a later migration is applied or when 0016's own ledger row is missing.
BEGIN;
DO $$
DECLARE
  expected constant text := 'ae9d04d5ebb0361124314e79e931bfcfda57237ca4508ee58820204c31701dbb';
  present integer;
  applied_id integer;
  later integer;
BEGIN
  SELECT count(*) INTO present FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF present <> 1 THEN
    RAISE EXCEPTION '0016 rollback refused: expected exactly one applied 0016 migration, found %', present;
  END IF;
  SELECT id INTO applied_id FROM drizzle.__drizzle_migrations WHERE hash = expected;
  SELECT count(*) INTO later FROM drizzle.__drizzle_migrations WHERE id > applied_id;
  IF later <> 0 THEN
    RAISE EXCEPTION '0016 rollback refused: % later migration(s) are already applied; roll them back first', later;
  END IF;
  -- Delete the ledger row inside the block: PL/pgSQL can reference `expected`,
  -- so the 64-bit hash literal appears only once in this file.
  DELETE FROM drizzle.__drizzle_migrations WHERE hash = expected;
END $$;
ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "revoked_at";
COMMIT;
