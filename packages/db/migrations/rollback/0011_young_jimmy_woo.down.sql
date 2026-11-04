-- Reverse 0011: drop the process-ownership snapshot. Only runs when 0011 is the
-- latest applied migration and the caller supplies the exact sha256 of
-- 0011_young_jimmy_woo.sql.
\set ON_ERROR_STOP on
\if :{?hash}
\else
  \set hash __MOYU_0011_HASH_MISSING__
\endif
BEGIN;
SET LOCAL moyu.rollback_hash = :'hash';
DO $$
DECLARE
  expected constant text := '1e105e7ab0046ea9e568d056a212aff400df9427dd4e755cf9393b029f4227b0';
  supplied text := current_setting('moyu.rollback_hash', true);
  matching integer;
  latest text;
BEGIN
  IF supplied IS NULL OR supplied = '' OR supplied = '__MOYU_0011_HASH_MISSING__' THEN
    RAISE EXCEPTION '0011 rollback refused: pass -v hash=<sha256 of 0011_young_jimmy_woo.sql>';
  END IF;
  IF supplied <> expected THEN RAISE EXCEPTION '0011 rollback refused: hash mismatch'; END IF;
  SELECT count(*) INTO matching FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF matching <> 1 THEN RAISE EXCEPTION '0011 rollback refused: expected one applied 0011 migration, found %', matching; END IF;
  SELECT hash INTO latest FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;
  IF latest <> expected THEN RAISE EXCEPTION '0011 rollback refused: 0011 is not the latest applied migration'; END IF;
END $$;
ALTER TABLE "repository_instances" DROP COLUMN IF EXISTS "ownership";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = '1e105e7ab0046ea9e568d056a212aff400df9427dd4e755cf9393b029f4227b0';
COMMIT;
