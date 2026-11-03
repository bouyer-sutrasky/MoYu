-- Reverse 0004_nappy_yellowjacket: drop the composite foreign keys, their
-- supporting unique indexes and the migration row.
--
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--   -v hash="$(sha256sum packages/db/migrations/0004_nappy_yellowjacket.sql | cut -d' ' -f1)" \
--   -f packages/db/migrations/rollback/0004_nappy_yellowjacket.down.sql
--
-- Safety contract:
--   * Validation runs before any DDL and refuses to continue when the supplied
--     hash is missing, does not equal the 0004 forward migration hash, or when
--     the single matching 0004 migration record is not the latest applied row.
--   * Validation, DDL and the migration-row delete share one transaction. Any
--     failure rolls the whole rollback back, leaving the foreign keys, indexes,
--     migration history and business data exactly as they were.
-- Dropping the constraints only removes the new integrity checks; it does not
-- touch any message or task-link row.
\set ON_ERROR_STOP on

\if :{?hash}
\else
  \set hash __MOYU_0004_HASH_MISSING__
\endif

BEGIN;

SET LOCAL moyu.rollback_hash = :'hash';

DO $$
DECLARE
  expected_hash constant text := 'dc79e301b2b62a77d594ee9a08ec9c14a82ca6ab068d12427dbcf20f824b8d4a';
  supplied_hash text := current_setting('moyu.rollback_hash', true);
  matching_records integer;
  latest_hash text;
  latest_record_id integer;
BEGIN
  IF supplied_hash IS NULL
     OR supplied_hash = ''
     OR supplied_hash = '__MOYU_0004_HASH_MISSING__' THEN
    RAISE EXCEPTION '0004 rollback refused: pass -v hash=<sha256 of 0004_nappy_yellowjacket.sql>';
  END IF;

  IF supplied_hash <> expected_hash THEN
    RAISE EXCEPTION '0004 rollback refused: supplied hash does not match 0004_nappy_yellowjacket.sql';
  END IF;

  SELECT count(*) INTO matching_records
    FROM drizzle.__drizzle_migrations
   WHERE hash = expected_hash;
  IF matching_records <> 1 THEN
    RAISE EXCEPTION '0004 rollback refused: expected exactly one applied 0004 migration record, found %',
      matching_records;
  END IF;

  SELECT hash, id INTO latest_hash, latest_record_id
    FROM drizzle.__drizzle_migrations
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  IF latest_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION '0004 rollback refused: 0004 is not the latest applied migration (latest record id %)',
      latest_record_id;
  END IF;
END
$$;

ALTER TABLE IF EXISTS "task_links" DROP CONSTRAINT IF EXISTS "task_links_conversation_repository_fk";
ALTER TABLE IF EXISTS "messages" DROP CONSTRAINT IF EXISTS "messages_reply_same_conversation_fk";
DROP INDEX IF EXISTS "messages_id_conversation_uq";
DROP INDEX IF EXISTS "conversations_id_repository_uq";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = :'hash';

COMMIT;
