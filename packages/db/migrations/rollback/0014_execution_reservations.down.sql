-- Reverse 0014: execution reservations.
-- Only runs when 0014 is the latest applied migration and the caller supplies
-- the exact sha256 of 0014_execution_reservations.sql. This follows the same
-- contract as every sibling rollback (0004-0013): the expected hash, the single
-- matching ledger row, and "0014 is the newest row" are all checked inside the
-- transaction, before any DDL, so a refusal leaves the table, its constraints
-- and drizzle.__drizzle_migrations exactly as they were.
\set ON_ERROR_STOP on
\if :{?hash}
\else
  \set hash __MOYU_0014_HASH_MISSING__
\endif
BEGIN;
SET LOCAL moyu.rollback_hash = :'hash';
DO $$
DECLARE
  expected constant text := '46344e9ba62e570e08f2797c21eaef6aaf194191378fa4860cee28444a01c1d3';
  supplied text := current_setting('moyu.rollback_hash', true);
  matching integer;
  latest text;
BEGIN
  IF supplied IS NULL OR supplied = '' OR supplied = '__MOYU_0014_HASH_MISSING__' THEN
    RAISE EXCEPTION '0014 rollback refused: pass -v hash=<sha256 of 0014_execution_reservations.sql>';
  END IF;
  IF supplied <> expected THEN RAISE EXCEPTION '0014 rollback refused: hash mismatch'; END IF;
  SELECT count(*) INTO matching FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF matching <> 1 THEN
    RAISE EXCEPTION '0014 rollback refused: expected exactly one applied 0014 migration, found %', matching;
  END IF;
  SELECT hash INTO latest FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;
  IF latest <> expected THEN
    RAISE EXCEPTION '0014 rollback refused: 0014 is not the latest applied migration';
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
