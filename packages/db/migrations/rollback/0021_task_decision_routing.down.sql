-- Reverse 0021: persist the ignored Trigger's decision and the current PR
-- pointer's order. Both are projections: dropping them loses the owner-facing
-- "未接单/已转交" explanation and the history-ordering guard, but no task,
-- message, PR or worktree. A later forward migration records new decisions.
BEGIN;

ALTER TABLE "task_links" DROP COLUMN IF EXISTS "pr_updated_at";
ALTER TABLE "task_links" DROP COLUMN IF EXISTS "decision";

-- Remove this migration's ledger row so `migrateDatabase` can re-apply 0021
-- after a rollback. The hash is sha256 of the forward migration file.
DELETE FROM drizzle.__drizzle_migrations
 WHERE hash = '45072a4ec846a8417672a26379b823738cafce6bcbd854cad342f80dc375b768';

COMMIT;
