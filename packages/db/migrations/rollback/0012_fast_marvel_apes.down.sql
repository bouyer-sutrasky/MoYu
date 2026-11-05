-- Reverse 0012: drop the allocation uniqueness indexes. Only runs when 0012 is
-- the latest applied migration and the caller supplies the exact sha256 of
-- 0012_fast_marvel_apes.sql.
\set ON_ERROR_STOP on
\if :{?hash}
\else
  \set hash __MOYU_0012_HASH_MISSING__
\endif
BEGIN;
SET LOCAL moyu.rollback_hash = :'hash';
DO $$
DECLARE
  expected constant text := '8777de805622df2910bfdb33fbf8aa4ade4f3f2a73cc90d29f5125a6834e18c3';
  supplied text := current_setting('moyu.rollback_hash', true);
  matching integer;
  latest text;
BEGIN
  IF supplied IS NULL OR supplied = '' OR supplied = '__MOYU_0012_HASH_MISSING__' THEN
    RAISE EXCEPTION '0012 rollback refused: pass -v hash=<sha256 of 0012_fast_marvel_apes.sql>';
  END IF;
  IF supplied <> expected THEN RAISE EXCEPTION '0012 rollback refused: hash mismatch'; END IF;
  SELECT count(*) INTO matching FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF matching <> 1 THEN RAISE EXCEPTION '0012 rollback refused: expected one applied 0012 migration, found %', matching; END IF;
  SELECT hash INTO latest FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;
  IF latest <> expected THEN RAISE EXCEPTION '0012 rollback refused: 0012 is not the latest applied migration'; END IF;
END $$;
DROP INDEX IF EXISTS "repository_instances_profile_uq";
DROP INDEX IF EXISTS "repository_instances_port_uq";
DROP INDEX IF EXISTS "repository_instances_bridge_port_uq";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = '8777de805622df2910bfdb33fbf8aa4ade4f3f2a73cc90d29f5125a6834e18c3';
COMMIT;
