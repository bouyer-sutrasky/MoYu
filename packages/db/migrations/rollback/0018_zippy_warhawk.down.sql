-- Reverse 0018: repository check-command override and its audit log. Plain SQL,
-- transactional, and it refuses when a later migration is applied or when 0018's
-- ledger row is missing. Dropping the audit table loses only configuration
-- history; no business row or message is touched.
BEGIN;
DO $$
DECLARE
  expected constant text := 'a3fc0de169de4849dced9df21e230b4f9a66157b98baa80fc8abe0806a7e9858';
  present integer;
  applied_id integer;
  later integer;
BEGIN
  SELECT count(*) INTO present FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF present <> 1 THEN
    RAISE EXCEPTION '0018 rollback refused: expected exactly one applied 0018 migration, found %', present;
  END IF;
  SELECT id INTO applied_id FROM drizzle.__drizzle_migrations WHERE hash = expected;
  SELECT count(*) INTO later FROM drizzle.__drizzle_migrations WHERE id > applied_id;
  IF later <> 0 THEN
    RAISE EXCEPTION '0018 rollback refused: % later migration(s) are already applied; roll them back first', later;
  END IF;
  DELETE FROM drizzle.__drizzle_migrations WHERE hash = expected;
END $$;
DROP INDEX IF EXISTS "repository_audit_events_repository_idx";
DROP TABLE IF EXISTS "repository_audit_events";
ALTER TABLE IF EXISTS "repositories" DROP CONSTRAINT IF EXISTS "repositories_check_commands_shape";
ALTER TABLE IF EXISTS "repositories" DROP COLUMN IF EXISTS "check_commands";
COMMIT;
