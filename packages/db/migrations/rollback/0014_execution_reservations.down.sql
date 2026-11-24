-- Reverse 0014: execution reservations.
--
-- Plain SQL on purpose (no psql meta-commands) so both psql and a plain pg
-- client can execute it, and the sha256 of the forward file is pinned here so
-- the guard needs no caller-supplied variable.
--
-- Safety contract, all inside the transaction and before the first DDL:
--   * take the advisory lock that migrateDatabase holds while it reads and
--     writes drizzle.__drizzle_migrations, so a migration cannot read
--     "0014 applied" while this rollback deletes the table and ledger row;
--   * exactly one ledger row carries the pinned 0014 hash (missing, drifted or
--     duplicated history is refused);
--   * no ledger row has a NULL created_at. Drizzle's ledger allows it, and the
--     migrator's ORDER BY created_at DESC puts NULL first, so a NULL row would
--     silently become "the latest" while the counts below skip it;
--   * 0014 is uniquely the latest applied migration in migrator order. The
--     migrator orders ledger rows by created_at, not by id, so a later
--     migration is refused even when its ledger id is lower.
-- Any refusal rolls the whole transaction back, leaving the table, its three
-- foreign keys and the ledger exactly as they were.
BEGIN;

-- Must stay in sync with MIGRATION_LEDGER_LOCK_KEY in
-- packages/db/src/migrate.ts (918273646 is the platform-events lock).
SELECT pg_advisory_xact_lock(918273647);

DO $$
DECLARE
  expected constant text := '46344e9ba62e570e08f2797c21eaef6aaf194191378fa4860cee28444a01c1d3';
  present integer;
  missing_timestamps integer;
  applied_at bigint;
  later integer;
  latest integer;
BEGIN
  SELECT count(*) INTO present
    FROM drizzle.__drizzle_migrations
   WHERE hash = expected;
  IF present <> 1 THEN
    RAISE EXCEPTION '0014 rollback refused: expected exactly one applied 0014 migration matching the pinned hash, found %', present;
  END IF;

  -- The migrator sorts by created_at DESC, so PostgreSQL would put a NULL row
  -- first and see it as the latest migration. The > and = comparisons below
  -- never match NULL, so refuse the abnormal order explicitly.
  SELECT count(*) INTO missing_timestamps
    FROM drizzle.__drizzle_migrations
   WHERE created_at IS NULL;
  IF missing_timestamps <> 0 THEN
    RAISE EXCEPTION '0014 rollback refused: % ledger row(s) have no created_at, so the migrator''s latest order is undefined; repair the ledger first', missing_timestamps;
  END IF;

  SELECT created_at INTO applied_at
    FROM drizzle.__drizzle_migrations
   WHERE hash = expected;

  -- The migrator decides "already applied" by created_at, so that is the order
  -- this guard must use. A row with a greater created_at would make the
  -- migrator skip 0014 forever after this rollback.
  SELECT count(*) INTO later
    FROM drizzle.__drizzle_migrations
   WHERE created_at > applied_at;
  IF later <> 0 THEN
    RAISE EXCEPTION '0014 rollback refused: % later migration(s) are already applied; roll them back first', later;
  END IF;

  -- Refuse ambiguous order instead of guessing which same-timestamp row the
  -- migrator saw as the latest.
  SELECT count(*) INTO latest
    FROM drizzle.__drizzle_migrations
   WHERE created_at = applied_at;
  IF latest <> 1 THEN
    RAISE EXCEPTION '0014 rollback refused: 0014 is not uniquely the latest applied migration';
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
