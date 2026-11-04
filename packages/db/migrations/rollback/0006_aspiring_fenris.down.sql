-- Reverse 0006_aspiring_fenris: drop the durable duplicate-Ticket queue.
--
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--   -v hash="$(sha256sum packages/db/migrations/0006_aspiring_fenris.sql | cut -d' ' -f1)" \
--   -f packages/db/migrations/rollback/0006_aspiring_fenris.down.sql
--
-- Refuses a missing/wrong hash or when 0006 is not the latest applied migration.
\set ON_ERROR_STOP on

\if :{?hash}
\else
  \set hash __MOYU_0006_HASH_MISSING__
\endif

BEGIN;

SET LOCAL moyu.rollback_hash = :'hash';

DO $$
DECLARE
  expected_hash constant text := '05c93a08aa0eab78e0ec21242bc07809ecb08a49c005a1a5a17c71935cfa039c';
  supplied_hash text := current_setting('moyu.rollback_hash', true);
  matching_records integer;
  latest_hash text;
BEGIN
  IF supplied_hash IS NULL OR supplied_hash = '' OR supplied_hash = '__MOYU_0006_HASH_MISSING__' THEN
    RAISE EXCEPTION '0006 rollback refused: pass -v hash=<sha256 of 0006_aspiring_fenris.sql>';
  END IF;
  IF supplied_hash <> expected_hash THEN
    RAISE EXCEPTION '0006 rollback refused: supplied hash does not match 0006_aspiring_fenris.sql';
  END IF;
  SELECT count(*) INTO matching_records FROM drizzle.__drizzle_migrations WHERE hash = expected_hash;
  IF matching_records <> 1 THEN
    RAISE EXCEPTION '0006 rollback refused: expected one applied 0006 migration, found %', matching_records;
  END IF;
  SELECT hash INTO latest_hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;
  IF latest_hash <> expected_hash THEN
    RAISE EXCEPTION '0006 rollback refused: 0006 is not the latest applied migration';
  END IF;
END
$$;

DROP TABLE IF EXISTS "duplicate_tickets";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = '05c93a08aa0eab78e0ec21242bc07809ecb08a49c005a1a5a17c71935cfa039c';

COMMIT;
