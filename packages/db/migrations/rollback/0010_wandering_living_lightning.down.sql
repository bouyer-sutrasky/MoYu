-- Reverse 0010: drop the supervisor lifecycle projection and per-repository
-- callback-token digest. Only runs when 0010 is the latest applied migration and
-- the caller supplies the exact sha256 of 0010_wandering_living_lightning.sql.
\set ON_ERROR_STOP on
\if :{?hash}
\else
  \set hash __MOYU_0010_HASH_MISSING__
\endif
BEGIN;
SET LOCAL moyu.rollback_hash = :'hash';
DO $$
DECLARE
  expected constant text := 'dd09b7b3509bc8174117bd7179b829e9866798d0d8869bdc658eab18f7b56c55';
  supplied text := current_setting('moyu.rollback_hash', true);
  matching integer;
  latest text;
BEGIN
  IF supplied IS NULL OR supplied = '' OR supplied = '__MOYU_0010_HASH_MISSING__' THEN
    RAISE EXCEPTION '0010 rollback refused: pass -v hash=<sha256 of 0010_wandering_living_lightning.sql>';
  END IF;
  IF supplied <> expected THEN RAISE EXCEPTION '0010 rollback refused: hash mismatch'; END IF;
  SELECT count(*) INTO matching FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF matching <> 1 THEN RAISE EXCEPTION '0010 rollback refused: expected one applied 0010 migration, found %', matching; END IF;
  SELECT hash INTO latest FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;
  IF latest <> expected THEN RAISE EXCEPTION '0010 rollback refused: 0010 is not the latest applied migration'; END IF;
END $$;
ALTER TABLE "repositories" DROP COLUMN IF EXISTS "bridge_callback_token_hash";
DROP TABLE IF EXISTS "repository_instances";
DROP TYPE IF EXISTS "runtime_instance_state";
DROP TYPE IF EXISTS "runtime_desired_state";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'dd09b7b3509bc8174117bd7179b829e9866798d0d8869bdc658eab18f7b56c55';
COMMIT;
