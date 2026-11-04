-- Reverse 0007_loose_tiger_shark: drop the Web->GitHub merge alias column/index.
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v hash=<sha256 of 0007_loose_tiger_shark.sql>
--   -f packages/db/migrations/rollback/0007_loose_tiger_shark.down.sql
\set ON_ERROR_STOP on
\if :{?hash}
\else
  \set hash __MOYU_0007_HASH_MISSING__
\endif
BEGIN;
SET LOCAL moyu.rollback_hash = :'hash';
DO $$
DECLARE
  expected_hash constant text := 'b950b416ba2d3cb6cd78a37d25889c60f3a8b68aae02eb235378b7d04fae00ae';
  supplied_hash text := current_setting('moyu.rollback_hash', true);
  matching integer;
  latest text;
BEGIN
  IF supplied_hash IS NULL OR supplied_hash = '' OR supplied_hash = '__MOYU_0007_HASH_MISSING__' THEN
    RAISE EXCEPTION '0007 rollback refused: pass -v hash=<sha256 of 0007_loose_tiger_shark.sql>';
  END IF;
  IF supplied_hash <> expected_hash THEN
    RAISE EXCEPTION '0007 rollback refused: supplied hash does not match 0007_loose_tiger_shark.sql';
  END IF;
  SELECT count(*) INTO matching FROM drizzle.__drizzle_migrations WHERE hash = expected_hash;
  IF matching <> 1 THEN RAISE EXCEPTION '0007 rollback refused: expected one applied 0007 migration, found %', matching; END IF;
  SELECT hash INTO latest FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;
  IF latest <> expected_hash THEN RAISE EXCEPTION '0007 rollback refused: 0007 is not the latest applied migration'; END IF;
END $$;
DROP INDEX IF EXISTS "conversations_merged_into_idx";
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_merged_into_conversation_id_conversations_id_fk";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "merged_into_conversation_id";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = 'b950b416ba2d3cb6cd78a37d25889c60f3a8b68aae02eb235378b7d04fae00ae';
COMMIT;
