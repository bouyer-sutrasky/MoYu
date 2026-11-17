-- Reverse 0020: repository-level Git preparation status.
--
-- These columns are a projection owned by the supervisor; dropping them loses
-- only the "last preparation" explanation, not a repository or a task. The
-- mirrored Git copy under WORKTREE_ROOT is not touched by this rollback, and a
-- later forward migration prepares it again (or reports it failed).
BEGIN;

ALTER TABLE "repository_instances" DROP CONSTRAINT IF EXISTS "repository_instances_git_attempts_check";
ALTER TABLE "repository_instances" DROP CONSTRAINT IF EXISTS "repository_instances_git_phase_check";
ALTER TABLE "repository_instances" DROP CONSTRAINT IF EXISTS "repository_instances_git_progress_check";
ALTER TABLE "repository_instances" DROP CONSTRAINT IF EXISTS "repository_instances_git_state_check";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "git_head";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "git_attempts";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "git_finished_at";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "git_started_at";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "git_detail";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "git_progress";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "git_phase";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "git_state";

-- Remove this migration's ledger row so `migrateDatabase` can re-apply 0020
-- after a rollback. The hash is sha256 of the forward migration file.
DELETE FROM drizzle.__drizzle_migrations
 WHERE hash = '723cde556b3e2b4b2fbdd9f6941e6eeeff5c9eca2b35087d5b6b52f1a4359e61';

COMMIT;
