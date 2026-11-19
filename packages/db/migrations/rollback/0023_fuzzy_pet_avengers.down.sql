-- Reverse 0023: drop the repository-removal projection. Historical tasks,
-- conversations and their repository foreign keys are untouched; the repository
-- row simply becomes visible again with no removal metadata.
BEGIN;

ALTER TABLE "public"."repositories" DROP CONSTRAINT IF EXISTS "repositories_deletion_state_check";
ALTER TABLE "public"."repositories" DROP COLUMN IF EXISTS "removed_at";
ALTER TABLE "public"."repositories" DROP COLUMN IF EXISTS "deletion_finished_at";
ALTER TABLE "public"."repositories" DROP COLUMN IF EXISTS "deletion_started_at";
ALTER TABLE "public"."repositories" DROP COLUMN IF EXISTS "deletion_attempts";
ALTER TABLE "public"."repositories" DROP COLUMN IF EXISTS "deletion_detail";
ALTER TABLE "public"."repositories" DROP COLUMN IF EXISTS "deletion_state";

-- Remove this migration's ledger row so `migrateDatabase` can re-apply 0023
-- after a rollback. The hash is sha256 of the forward migration file.
DELETE FROM drizzle.__drizzle_migrations
 WHERE hash = '4924b4847968fdb39aa101f6b6692e84a6c7add73f04467f9f0e0b581963406e';

COMMIT;
