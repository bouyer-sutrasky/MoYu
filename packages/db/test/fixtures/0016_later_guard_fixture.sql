-- Test-only fixture for the 0015 rollback guard. It is deliberately NOT in
-- packages/db/migrations and never ships in the production migration chain: it
-- simulates "a later migration is already applied" by creating one table and
-- appending one ledger row after 0015.
BEGIN;
CREATE TABLE IF NOT EXISTS later_guard_fixture (id integer PRIMARY KEY);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('test-0016-later-guard-fixture', (extract(epoch FROM now()) * 1000)::bigint);
COMMIT;
