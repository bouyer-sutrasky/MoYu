#!/usr/bin/env bash
# P1-B attachment-binding check against a real isolated API, database and browser.
#
# Builds the current checkout, recreates an isolated database, seeds the owner,
# repository and two conversations, starts the API (which serves the built Web
# assets), runs scripts/m6a/p1b-composer-check.mjs with Chromium, and writes the
# network records and screenshots under docs/evidence/m6a/p1b/.
#
# Run it once on the pre-fix build (P1B_SIDE=before: the switch scenario fails and
# the raw upload URL names conversation B) and once on the fixed build
# (P1B_SIDE=after: every check passes). That pair is the red-to-green evidence.
#
# Usage:
#   TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
#   P1B_SIDE=before|after bash scripts/m6a/p1b-composer-check.sh
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
RUN=${P1B_RUN_DIR:-/tmp/p1b-run}
OUT="$REPO/docs/evidence/m6a/p1b"
ADMIN_URL=${TEST_DATABASE_ADMIN_URL:?TEST_DATABASE_ADMIN_URL is required}
DB_NAME=${P1B_DB_NAME:-moyu_p1b_evidence}
DATABASE_URL="$(printf '%s' "$ADMIN_URL" | sed "s#/[^/]*\$#/$DB_NAME#")"
API_PORT=${P1B_API_PORT:-4630}
NODE_BIN=${M6A_NODE_BIN:-/opt/moyu-node24/bin}
SIDE=${P1B_SIDE:?P1B_SIDE=before|after is required}
PATH="$NODE_BIN:$PATH"

mkdir -p "$OUT" "$RUN/logs" "$RUN/artifacts"
TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'ab' | cut -c1-43)

log() { printf '%s\n' "$*"; }

API_PID=''
cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM -- "-$API_PID" 2>/dev/null || kill -TERM "$API_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$API_PID" 2>/dev/null; then
      kill -KILL -- "-$API_PID" 2>/dev/null || kill -KILL "$API_PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

log "==> side=$SIDE head=$(git -C "$REPO" rev-parse HEAD)"
log "==> build this checkout"
(cd "$REPO" && corepack pnpm install --frozen-lockfile >/dev/null && corepack pnpm build >/dev/null)

log "==> recreate isolated database $DB_NAME"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$DB_NAME\""
(cd "$REPO" && DATABASE_URL="$DATABASE_URL" corepack pnpm --filter @moyu/db db:migrate >/dev/null)

log "==> seed owner, repository and two conversations"
seed=$(DATABASE_URL="$DATABASE_URL" M6A_SESSION_TOKEN="$TOKEN" node "$REPO/scripts/m6a/seed-fixture.mjs")
read_json() {
  printf '%s' "$seed" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s)[process.argv[1]] ?? ""))' "$1"
}
CONVERSATION_A=$(read_json conversationId)
CONVERSATION_B=$(read_json cleanedConversationId)
if [[ -z "$CONVERSATION_A" || -z "$CONVERSATION_B" ]]; then
  echo 'seed did not return two conversations'; exit 1
fi
log "conversation A=$CONVERSATION_A"
log "conversation B=$CONVERSATION_B"

cat > "$RUN/api.env" <<ENV
NODE_ENV=test
API_HOST=127.0.0.1
API_PORT=$API_PORT
LOG_LEVEL=info
DATABASE_URL=$DATABASE_URL
WEBAUTHN_RP_ID=127.0.0.1
WEBAUTHN_RP_NAME=MoYu
WEBAUTHN_ORIGIN=http://127.0.0.1:$API_PORT
AUTH_COOKIE_SECURE=false
ARTIFACT_STORAGE_DIR=$RUN/artifacts
WEB_DIST_DIR=apps/web/dist
SUPERVISOR_URL=http://127.0.0.1:4691
SUPERVISOR_TOKEN=$(head -c 40 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'cd' | cut -c1-40)
GITHUB_CLI=gh
ENV

log "==> start the after API on 127.0.0.1:$API_PORT (serves apps/web/dist)"
rm -f "$RUN/api.pid"
setsid bash -c 'cd "$1" || exit 1; set -a; . "$2"; set +a; printf "%s" "$$" > "$3"; exec "$4" apps/api/dist/server.js' \
  _ "$REPO" "$RUN/api.env" "$RUN/api.pid" "$NODE_BIN/node" \
  > "$RUN/logs/api.log" 2>&1 < /dev/null &
for _ in $(seq 1 100); do [[ -s "$RUN/api.pid" ]] && break; sleep 0.05; done
API_PID=$(cat "$RUN/api.pid" 2>/dev/null || true)
if [[ -z "$API_PID" ]]; then echo 'API process did not write its pid'; exit 1; fi
ready=0
for _ in $(seq 1 120); do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$API_PORT/readyz"; then ready=1; break; fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then
  echo 'API did not become ready'; tail -40 "$RUN/logs/api.log"; exit 1
fi

log "==> browser check (side=$SIDE)"
set +e
M6A_AFTER_URL="http://127.0.0.1:$API_PORT" M6A_SESSION_TOKEN="$TOKEN" \
  M6A_CONVERSATION_A="$CONVERSATION_A" M6A_CONVERSATION_B="$CONVERSATION_B" \
  P1B_SIDE="$SIDE" P1B_OUT="$OUT" \
  node "$REPO/scripts/m6a/p1b-composer-check.mjs"
code=$?
set -e
log "browser check exit=$code"
log "records: $OUT/$SIDE-records.json"
exit "$code"
