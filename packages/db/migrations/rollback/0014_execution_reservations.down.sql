-- Reverse 0014: execution reservations.
-- Plain SQL on purpose (no psql meta-commands) so both psql and a plain pg
-- client can execute it, and transactional so a refusal leaves the schema
-- untouched. 0013 requires the caller to supply the hash; 0014 verifies the
-- ledger row itself instead, which keeps the same drift protection without
-- needing a variable.
BEGIN;
DO $$
DECLARE
  expected constant text := '46344e9ba62e570e08f2797c21eaef6aaf194191378fa4860cee28444a01c1d3';
  present integer;
BEGIN
  SELECT count(*) INTO present FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF present <> 1 THEN
    RAISE EXCEPTION '0014 rollback refused: expected exactly one applied 0014 migration, found %', present;
  END IF;
END $$;
ALTER TABLE "execution_reservations" DROP CONSTRAINT IF EXISTS "execution_reservations_delivery_fk";
ALTER TABLE "execution_reservations" DROP CONSTRAINT IF EXISTS "execution_reservations_task_fk";
ALTER TABLE "execution_reservations" DROP CONSTRAINT IF EXISTS "execution_reservations_repository_fk";
DROP TABLE IF EXISTS "execution_reservations";
-- Drop the applied-migration ledger row too. Without it migrateDatabase still
-- believes 0014 is applied and never recreates the table, so the rollback is
-- only half done.
DELETE FROM drizzle.__drizzle_migrations WHERE hash = '46344e9ba62e570e08f2797c21eaef6aaf194191378fa4860cee28444a01c1d3';
COMMIT;
