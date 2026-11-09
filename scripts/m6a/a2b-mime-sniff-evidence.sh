#!/usr/bin/env bash
# A2b MIME sniff harness: isolated PostgreSQL + built API, one seeded conversation,
# and the upload matrix from a2b-mime-sniff-check.mjs.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PORT=${M6A_A2B_PORT:-4635}
DB=${M6A_A2B_DB:-moyu_a2b_evidence}
RUN=${M6A_A2B_RUN:-/tmp/m6a-a2b}
NODE_BIN=${NODE_BIN:-/opt/moyu-node24/bin}
export PATH="$NODE_BIN:$PATH"
DATABASE_URL=postgres://moyu@127.0.0.1:55432/$DB
rm -rf "$RUN"; mkdir -p "$RUN/artifacts"
dropdb --if-exists -h 127.0.0.1 -p 55432 -U moyu "$DB" >/dev/null 2>&1 || true
createdb -h 127.0.0.1 -p 55432 -U moyu "$DB"
DATABASE_URL="$DATABASE_URL" pnpm --filter @moyu/db db:migrate > "$RUN/migrate.log" 2>&1
TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'ef' | cut -c1-43)
DATABASE_URL="$DATABASE_URL" M6A_SESSION_TOKEN="$TOKEN" node "$HERE/a2b-seed.mjs" > "$RUN/seed.json"
[ "${M6A_A2B_SKIP_BUILD:-}" = "1" ] || pnpm build > "$RUN/build.log" 2>&1
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
SUPERVISOR_TOKEN=a2b-supervisor-token
GITHUB_CLI=gh
ENV
set -a; . "$RUN/api.env"; set +a
node apps/api/dist/server.js > "$RUN/api.log" 2>&1 &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null || { echo 'API did not start'; tail -20 "$RUN/api.log"; exit 1; }
CONVERSATION=$(node -e "process.stdout.write(require(process.argv[1]).conversationId)" "$RUN/seed.json")
set +e
M6A_AFTER_URL="http://127.0.0.1:$PORT" M6A_SESSION_TOKEN="$TOKEN" M6A_CONVERSATION_ID="$CONVERSATION" \
  DATABASE_URL="$DATABASE_URL" M6A_STORAGE_DIR="$RUN/artifacts" node "$HERE/a2b-mime-sniff-check.mjs"
EXIT=$?
set -e
kill "$API_PID" 2>/dev/null || true
dropdb --if-exists -h 127.0.0.1 -p 55432 -U moyu "$DB" >/dev/null 2>&1 || true
echo "EXIT=$EXIT"
exit "$EXIT"
