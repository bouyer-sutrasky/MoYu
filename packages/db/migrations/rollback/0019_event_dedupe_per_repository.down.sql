-- Reverse 0019: the repository-scoped event dedupe index.
--
-- Plain SQL on purpose (no psql meta-commands) so both psql and a plain pg
-- client can execute it, and transactional so a refusal leaves the schema,
-- ledger and business rows untouched. The forward migration is already
-- deployed in production, so its bytes and ledger hash are pinned here:
--   sha256(0019_event_dedupe_per_repository.sql)
--     = e26aa1a486c36303d69dbae6b5f125187738d1c3460184f119e009a95fda7453
--
-- The old index is global on (source, source_event_id). Recreating it is only
-- safe when the current data does not already contain the same event id in two
-- repositories: that data is legal under 0019 but cannot be represented by the
-- old unique index. In that case this script refuses and keeps both the 0019
-- schema and every row; recover with a consistent backup or a forward fix.
BEGIN;

-- events.ts serializes platform event writers with this transaction-level
-- advisory lock. Taking it here makes the duplicate check and the index swap
-- atomic with respect to those writers.
SELECT pg_advisory_xact_lock(918273646);

DO $$
DECLARE
  expected constant text := 'e26aa1a486c36303d69dbae6b5f125187738d1c3460184f119e009a95fda7453';
  present integer;
  applied_id integer;
  later integer;
  conflicting_groups integer;
  current_index text;
BEGIN
  SELECT count(*) INTO present FROM drizzle.__drizzle_migrations WHERE hash = expected;
  IF present <> 1 THEN
    RAISE EXCEPTION '0019 rollback refused: expected exactly one applied 0019 migration, found %', present;
  END IF;

  SELECT id INTO applied_id FROM drizzle.__drizzle_migrations WHERE hash = expected;
  SELECT count(*) INTO later FROM drizzle.__drizzle_migrations WHERE id > applied_id;
  IF later <> 0 THEN
    RAISE EXCEPTION '0019 rollback refused: % later migration(s) are already applied; roll them back first', later;
  END IF;

  -- Verify the index this script is about to replace still has the 0019 shape.
  -- A drifted or partially applied index must be repaired forward, not guessed
  -- at here.
  SELECT indexdef INTO current_index
    FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'events_source_event_uq';
  IF current_index IS NULL
     OR current_index NOT LIKE '%(repository_id, source, source_event_id)%' THEN
    RAISE EXCEPTION '0019 rollback refused: events_source_event_uq does not have the 0019 repository-scoped definition';
  END IF;

  -- Block all event writers (including direct SQL) until this transaction
  -- commits, so no conflicting row can appear between the check and the old
  -- unique index creation.
  LOCK TABLE "events" IN ACCESS EXCLUSIVE MODE;

  SELECT count(*) INTO conflicting_groups
    FROM (
      SELECT 1
        FROM "events"
       WHERE "source_event_id" IS NOT NULL
       GROUP BY "source", "source_event_id"
      HAVING count(*) > 1
    ) duplicates;
  IF conflicting_groups <> 0 THEN
    RAISE EXCEPTION '0019 rollback refused: % (source, source_event_id) group(s) exist in more than one repository; old global unique index cannot be restored without losing data', conflicting_groups;
  END IF;

  DELETE FROM drizzle.__drizzle_migrations WHERE hash = expected;
END $$;

DROP INDEX "events_source_event_uq";
CREATE UNIQUE INDEX "events_source_event_uq"
  ON "events" USING btree ("source", "source_event_id")
  WHERE "events"."source_event_id" is not null;

COMMIT;
