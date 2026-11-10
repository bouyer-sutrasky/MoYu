#!/usr/bin/env bash
# L117 red/green harness: isolated PostgreSQL + built Web/API, seeded finished
# tasks, and the Playwright create-from-task checks. Never touches 3082 or the
# production database.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PORT=${M6A_L117_PORT:-4634}
DB=${M6A_L117_DB:-moyu_l117_evidence}
RUN=${M6A_L117_RUN:-/tmp/m6a-l117}
DATABASE_URL=${M6A_L117_DATABASE_URL:-postgres://moyu@127.0.0.1:55432/$DB}
OUT=${M6A_OUT:-$REPO/docs/evidence/m6a}
NODE_BIN=${NODE_BIN:-/opt/moyu-node24/bin}
export PATH="$NODE_BIN:$PATH"
rm -rf "$RUN"; mkdir -p "$RUN" "$OUT"
dropdb --if-exists -h 127.0.0.1 -p 55432 -U moyu "$DB" 2>/dev/null || true
createdb -h 127.0.0.1 -p 55432 -U moyu "$DB"
DATABASE_URL="$DATABASE_URL" pnpm --filter @moyu/db db:migrate > "$RUN/migrate.log" 2>&1
SUPERVISOR_TOKEN=$(head -c 40 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'ab' | cut -c1-40)
TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'ef' | cut -c1-43)
DATABASE_URL="$DATABASE_URL" M6A_SESSION_TOKEN="$TOKEN" node "$HERE/l117-seed.mjs" > "$RUN/seed.json"
[ "${M6A_L117_SKIP_BUILD:-}" = "1" ] || pnpm build > "$RUN/build.log" 2>&1
cat > "$RUN/api.env" <<ENV
NODE_ENV=test
API_HOST=127.0.0.1
API_PORT=$PORT
LOG_LEVEL=warn
DATABASE_URL=$DATABASE_URL
WEBAUTHN_RP_ID=127.0.0.1
WEBAUTHN_RP_NAME=MoYu
WEBAUTHN_ORIGIN=http://127.0.0.1:$PORT
AUTH_COOKIE_SECURE=false
ARTIFACT_STORAGE_DIR=$RUN/artifacts
WEB_DIST_DIR=apps/web/dist
SUPERVISOR_URL=http://127.0.0.1:4699
SUPERVISOR_TOKEN=$SUPERVISOR_TOKEN
GITHUB_CLI=gh
ENV
set -a; . "$RUN/api.env"; set +a
node apps/api/dist/server.js > "$RUN/api.log" 2>&1 &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null || { echo 'API did not start'; tail -20 "$RUN/api.log"; exit 1; }
set +e
M6A_AFTER_URL="http://127.0.0.1:$PORT" M6A_SESSION_TOKEN="$TOKEN" M6A_SEED="$RUN/seed.json" \
  M6A_REPOSITORY=Bouyer12/l117-source M6A_OUT="$OUT" \
  node "$HERE/${M6A_L117_CHECK:-l117-new-task-check.mjs}"
EXIT=$?
set -e
kill "$API_PID" 2>/dev/null || true
dropdb --if-exists -h 127.0.0.1 -p 55432 -U moyu "$DB" 2>/dev/null || true
echo "EXIT=$EXIT"
exit "$EXIT"
