-- Reverse 0009: drop per-repository preferences and the keyset message index.
-- Only runs when 0009 is the latest applied migration and the caller supplies the
-- exact sha256 of 0009_far_typhoid_mary.sql.
\set ON_ERROR_STOP on
\if :{?hash}
\else
  \set hash __MOYU_0009_HASH_MISSING__
\endif
BEGIN;
SET LOCAL moyu.rollback_hash = :'hash';
DO $$
DECLARE
  expected constant text := 'd6c25e128e03bf6286eaa8eb701dd572a063a75a4ebcceea40b2648dfaa8e29f';
  supplied text := current_setting('moyu.rollback_hash', true);
  matching integer;
  latest text;
BEGIN
  IF supplied IS NULL OR supplied = '' OR supplied = '__MOYU_0009_HASH_MISSING__' THEN
    RAISE EXCEPTION '0009 rollback refused: pass -v hash=<sha256 of 0009_far_typhoid_mary.sql>';
  END IF;
  IF supplied <> expected THEN RAISE EXCEPTION '0009 rollback refused: hash mismatch'; END IF;
  SELECT count(*) INTO matching FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF matching <> 1 THEN RAISE EXCEPTION '0009 rollback refused: expected one applied 0009 migration, found %', matching; END IF;
  SELECT hash INTO latest FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;
  IF latest <> expected THEN RAISE EXCEPTION '0009 rollback refused: 0009 is not the latest applied migration'; END IF;
END $$;
DROP INDEX IF EXISTS "messages_conversation_created_id_idx";
DROP TABLE IF EXISTS "repository_preferences";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'd6c25e128e03bf6286eaa8eb701dd572a063a75a4ebcceea40b2648dfaa8e29f';
COMMIT;
