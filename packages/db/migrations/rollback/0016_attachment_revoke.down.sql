-- Reverse 0016: artifacts.revoked_at. Plain SQL, transactional, and it refuses
-- when a later migration is applied or when 0016's own ledger row is missing.
-- The 64-bit ledger hash appears both in the guard and in the final DELETE:
-- the down script must stay self-contained plain SQL (psql and plain clients,
-- no variables or meta-commands), so the literal is deliberately repeated here
-- rather than factored out; see 0015's down script for the same pattern.
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
END $$;
ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "revoked_at";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'ae9d04d5ebb0361124314e79e931bfcfda57237ca4508ee58820204c31701dbb';
COMMIT;
