ALTER TABLE "execution_reservations" DROP CONSTRAINT IF EXISTS "execution_reservations_delivery_fk";
ALTER TABLE "execution_reservations" DROP CONSTRAINT IF EXISTS "execution_reservations_task_fk";
ALTER TABLE "execution_reservations" DROP CONSTRAINT IF EXISTS "execution_reservations_repository_fk";
DROP TABLE IF EXISTS "execution_reservations";
-- Drop the applied-migration ledger row too. Without it migrateDatabase still
-- believes 0014 is applied and never recreates the table, so the rollback is
-- only half done. This mirrors the ledger delete at the end of the 0013 script.
DELETE FROM drizzle.__drizzle_migrations WHERE hash = '46344e9ba62e570e08f2797c21eaef6aaf194191378fa4860cee28444a01c1d3';

