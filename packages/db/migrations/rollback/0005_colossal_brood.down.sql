-- Reverse 0005_colossal_brood: drop the M4 execution-control tables, columns,
-- indexes and enums, and the migration row.
--
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--   -v hash="$(sha256sum packages/db/migrations/0005_colossal_brood.sql | cut -d' ' -f1)" \
--   -f packages/db/migrations/rollback/0005_colossal_brood.down.sql
--
-- Safety contract:
--   * Validation runs before any DDL and refuses to continue when the supplied
--     hash is missing, does not equal the 0005 forward migration hash, or when
--     the single matching 0005 migration record is not the latest applied row.
--   * Validation, DDL and the migration-row delete share one transaction. Any
--     failure rolls the whole rollback back.
--
-- This rollback discards M4 execution-control state: task commands, stop
-- evidence, GitHub import identity and per-task plan revisions. It does not
-- touch conversations, tasks, messages or deliveries themselves.
\set ON_ERROR_STOP on

\if :{?hash}
\else
  \set hash __MOYU_0005_HASH_MISSING__
\endif

BEGIN;

SET LOCAL moyu.rollback_hash = :'hash';

DO $$
DECLARE
  expected_hash constant text := '84ff452d3dd6131ce41b7ac54b6af4924521d3637d0a744b310875aaf9ad862c';
  supplied_hash text := current_setting('moyu.rollback_hash', true);
  matching_records integer;
  latest_hash text;
  latest_record_id integer;
BEGIN
  IF supplied_hash IS NULL
     OR supplied_hash = ''
     OR supplied_hash = '__MOYU_0005_HASH_MISSING__' THEN
    RAISE EXCEPTION '0005 rollback refused: pass -v hash=<sha256 of 0005_colossal_brood.sql>';
  END IF;

  IF supplied_hash <> expected_hash THEN
    RAISE EXCEPTION '0005 rollback refused: supplied hash does not match 0005_colossal_brood.sql';
  END IF;

  SELECT count(*) INTO matching_records
    FROM drizzle.__drizzle_migrations
   WHERE hash = expected_hash;
  IF matching_records <> 1 THEN
    RAISE EXCEPTION '0005 rollback refused: expected exactly one applied 0005 migration record, found %',
      matching_records;
  END IF;

  SELECT hash, id INTO latest_hash, latest_record_id
    FROM drizzle.__drizzle_migrations
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  IF latest_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION '0005 rollback refused: 0005 is not the latest applied migration (latest record id %)',
      latest_record_id;
  END IF;
END
$$;

DROP TABLE IF EXISTS "task_operations";
ALTER TABLE IF EXISTS "task_links"
  DROP CONSTRAINT IF EXISTS "task_links_runtime_lease_id_runtime_leases_id_fk";
DROP INDEX IF EXISTS "conversations_repository_external_uq";
ALTER TABLE IF EXISTS "task_links"
  DROP COLUMN IF EXISTS "runtime_lease_id",
  DROP COLUMN IF EXISTS "stop_evidence",
  DROP COLUMN IF EXISTS "stopped_at",
  DROP COLUMN IF EXISTS "stop_requested_at",
  DROP COLUMN IF EXISTS "plan_revision";
ALTER TABLE IF EXISTS "conversations"
  DROP COLUMN IF EXISTS "plan_revision",
  DROP COLUMN IF EXISTS "external_url",
  DROP COLUMN IF EXISTS "external_key",
  DROP COLUMN IF EXISTS "source";
DROP TYPE IF EXISTS "task_operation_state";
DROP TYPE IF EXISTS "task_operation_kind";
DROP TYPE IF EXISTS "conversation_source";
DELETE FROM drizzle.__drizzle_migrations WHERE hash = :'hash';

COMMIT;
