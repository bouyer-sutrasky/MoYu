-- Test-only fixture for the 0015 rollback guard: it simulates a migration that
-- is applied AFTER 0015 (the name does not refer to the real 0016 revoke
-- migration). It is deliberately NOT in
-- packages/db/migrations and never ships in the production migration chain: it
-- creates one table and appends one later ledger row.
BEGIN;
CREATE TABLE IF NOT EXISTS later_guard_fixture (id integer PRIMARY KEY);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('test-later-migration-fixture', (extract(epoch FROM now()) * 1000)::bigint);
COMMIT;
