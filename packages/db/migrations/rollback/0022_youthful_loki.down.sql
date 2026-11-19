-- Reverse 0022: drop the owner-visible activation timestamps. They only feed
-- the switch-time projection; no task, message, PR, lease or worktree depends
-- on them. Online instances get fresh timestamps on their next transition.
BEGIN;

ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "last_online_at";
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "activation_requested_at";

-- Remove this migration's ledger row so `migrateDatabase` can re-apply 0022
-- after a rollback. The hash is sha256 of the forward migration file.
DELETE FROM drizzle.__drizzle_migrations
 WHERE hash = '058ed2db4b64909246ac345e415522dc0af8a498bc19b11dc408189581b31e8f';

COMMIT;
