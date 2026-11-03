-- Reverse 0003_robust_the_renegades: drop deferred Bridge events and the migration row.
-- Run with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v hash="$(sha256sum packages/db/migrations/0003_robust_the_renegades.sql | cut -d' ' -f1)" -f this-file
DROP TABLE IF EXISTS "deferred_bridge_events" CASCADE;
DELETE FROM drizzle.__drizzle_migrations WHERE hash = :'hash';
