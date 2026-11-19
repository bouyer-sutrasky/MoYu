-- Reverse 0024: remove the current-removal-operation marker. A deletion that
-- was interrupted after this rollback is recoverable as failed by the existing
-- 0023 recovery path; late results can no longer be distinguished.
BEGIN;

ALTER TABLE "public"."repositories" DROP COLUMN IF EXISTS "deletion_operation_id";

DELETE FROM drizzle.__drizzle_migrations
 WHERE hash = 'b52d305a529c2fb69ba8c401062120ee2424c9d9afc10953889aec277bfc397a';

COMMIT;
