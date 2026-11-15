-- Reverse 0017: worktree-cleanup audit runs and items. Plain SQL, transactional,
-- and it refuses when a later migration is applied or when 0017's ledger row is
-- missing. The cleanup audit contains no business data needed to reconstruct a
-- deleted worktree, so dropping the two tables is the complete reversal.
BEGIN;
DO $$
DECLARE
  expected constant text := 'a3a05b5aa426db30d82ecdb377aa35d41a113065b3837e6c76e952372e4498aa';
  present integer;
  applied_id integer;
  later integer;
BEGIN
  SELECT count(*) INTO present FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF present <> 1 THEN
    RAISE EXCEPTION '0017 rollback refused: expected exactly one applied 0017 migration, found %', present;
  END IF;
  SELECT id INTO applied_id FROM drizzle.__drizzle_migrations WHERE hash = expected;
  SELECT count(*) INTO later FROM drizzle.__drizzle_migrations WHERE id > applied_id;
  IF later <> 0 THEN
    RAISE EXCEPTION '0017 rollback refused: % later migration(s) are already applied; roll them back first', later;
  END IF;
  DELETE FROM drizzle.__drizzle_migrations WHERE hash = expected;
END $$;
DROP INDEX IF EXISTS "cleanup_runs_preview_uq";
DROP INDEX IF EXISTS "cleanup_runs_owner_created_idx";
DROP INDEX IF EXISTS "cleanup_items_run_repository_ticket_uq";
DROP TABLE IF EXISTS "cleanup_items";
DROP TABLE IF EXISTS "cleanup_runs";
DROP TYPE IF EXISTS "cleanup_item_state";
DROP TYPE IF EXISTS "cleanup_run_status";
DROP TYPE IF EXISTS "cleanup_run_mode";
COMMIT;
