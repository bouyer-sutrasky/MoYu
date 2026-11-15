#!/usr/bin/env bash
# Proves the 0015 rollback guard: with a later migration applied the rollback
# must refuse and leave the schema untouched; with 0015 as the newest applied
# migration it must still roll back. Uses two disposable databases on the
# isolated PostgreSQL instance; never touches the production database.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
NODE_BIN=${NODE_BIN:-/opt/moyu-node24/bin}
export PATH="$NODE_BIN:$PATH"
DOWN="$REPO/packages/db/migrations/rollback/0015_late_gateway.down.sql"
FIXTURE="$REPO/packages/db/test/fixtures/later_migration_fixture.sql"
HASH=b50ad051f0dac6e0740722a345b64a0cdb3c0f392042d0858df75a295e729584
PG="psql -X -v ON_ERROR_STOP=1 postgres://moyu@127.0.0.1:55432"

schema() {
  local db=$1
  echo "\$ psql $db -c '\\d artifacts'"
  psql -X "postgres://moyu@127.0.0.1:55432/$db" -c '\d artifacts' 2>&1
  echo "\$ select message_id column / fk / index"
  psql -X -tA "postgres://moyu@127.0.0.1:55432/$db" -c "select column_name||':'||data_type from information_schema.columns where table_schema='public' and table_name='artifacts' and column_name='message_id'" -c "select conname from pg_constraint where conrelid='artifacts'::regclass and conname like '%message_id%'" -c "select indexname from pg_indexes where schemaname='public' and tablename='artifacts' and indexname='artifacts_message_idx'" 2>&1
  echo "\$ select count(*) ledger where hash = $HASH"
  psql -X -tA "postgres://moyu@127.0.0.1:55432/$db" -c "select count(*) from drizzle.__drizzle_migrations where hash = '$HASH'" 2>&1
}

prepare() {
  local db=$1
  dropdb --if-exists -h 127.0.0.1 -p 55432 -U moyu "$db" >/dev/null 2>&1
  createdb -h 127.0.0.1 -p 55432 -U moyu "$db"
  echo "\$ DATABASE_URL=.../$db pnpm --filter @moyu/db db:migrate"
  DATABASE_URL="postgres://moyu@127.0.0.1:55432/$db" pnpm --filter @moyu/db db:migrate 2>&1 | tail -1
}

echo '### RED: a later migration is applied, then the 0015 rollback runs'
prepare moyu_0015_guard_red
echo "\$ psql .../moyu_0015_guard_red -f packages/db/test/fixtures/later_migration_fixture.sql"
psql -X -v ON_ERROR_STOP=1 "postgres://moyu@127.0.0.1:55432/moyu_0015_guard_red" -f "$FIXTURE" 2>&1
echo "\$ ledger after fixture (id desc)"
psql -X -tA "postgres://moyu@127.0.0.1:55432/moyu_0015_guard_red" -c "select id||'|'||hash from drizzle.__drizzle_migrations order by id desc limit 2" 2>&1
echo '$ before rollback: schema + ledger'
schema moyu_0015_guard_red
echo "\$ psql ... -f $DOWN"
psql -X -v ON_ERROR_STOP=1 "postgres://moyu@127.0.0.1:55432/moyu_0015_guard_red" -f "$DOWN" 2>&1
echo "down exit code: $?"
echo '$ after rollback: schema + ledger'
schema moyu_0015_guard_red

echo
echo '### LEGAL: 0015 is the newest applied migration, rollback must still succeed'
prepare moyu_0015_guard_legal
echo '$ before rollback: schema + ledger'
schema moyu_0015_guard_legal
echo "\$ psql ... -f $DOWN"
psql -X -v ON_ERROR_STOP=1 "postgres://moyu@127.0.0.1:55432/moyu_0015_guard_legal" -f "$DOWN" 2>&1
echo "down exit code: $?"
echo '$ after rollback: schema + ledger'
schema moyu_0015_guard_legal

dropdb --if-exists -h 127.0.0.1 -p 55432 -U moyu moyu_0015_guard_red >/dev/null 2>&1
dropdb --if-exists -h 127.0.0.1 -p 55432 -U moyu moyu_0015_guard_legal >/dev/null 2>&1
