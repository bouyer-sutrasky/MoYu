#!/usr/bin/env bash
# M5-B matrix item 1c (c2) — a pause that lands while the start is still in flight.
#
# item1-pause-start.sh pauses once, which is enough for a phase the platform accepts at once.
# Pausing as soon as the ticket exists races the dispatcher recording that ticket: the API
# answers 409 because the task version the command carried went stale, which is a fact of the
# harness and not a product answer. This variant only adds a bounded retry of the same pause
# command and prints every attempt, so a captured log shows which attempt the platform accepted
# and what it rejected.
#
# Against a stack this repository's scripts/m5b/matrix/stack.sh just booted:
#
#   M5B_MATRIX_UPSTREAM_BUILD=/root/src/upstream/<build> scripts/m5b/matrix/stack.sh up
#   scripts/m5b/matrix/item1-pause-start-c2.sh
#
# M5B_MATRIX_ROOT must be a built checkout (the stack runs its apps/dispatcher and
# scripts/m5b/local-provider.mjs) and M5B_MATRIX_UPSTREAM_BUILD the runtime package the staged
# profile loads. The artifact lines below measure that package and the dispatcher actually
# running, instead of printing a default that may not be what the stack loaded.
#
# The stack is one enforceable slice: the API, PostgreSQL, the dispatcher, the supervisor, the
# runtime and the test provider. The production 3082 service, the production database and the
# shared 55432 PostgreSQL are never touched.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"
# stack.sh wrote the run's real database, session and Bridge values here; a caller may have
# sourced it already.
[[ -n ${M5B_BRIDGE_URL:-} ]] || { set -a; . "$M5B_MATRIX_STATE"; set +a; }

LIVE="node $M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs"
SESSIONS=$M5B_MATRIX_DSH_HOME/sessions
PROFILE_LINK=$M5B_MATRIX_DSH_HOME/profiles/$M5B_MATRIX_PROFILE/node_modules/dsh-superagent
OPERATIONS=$M5B_MATRIX_DSH_HOME/state/$M5B_MATRIX_PROFILE/bridge/operations.jsonl

ticket_of() { m5b_sql "select coalesce(upstream_ticket_id,'') from task_links where id='$1'"; }
state_of() { m5b_sql "select state from task_links where id='$1'"; }
version_of() { m5b_sql "select version from task_links where id='$1'"; }
leases() { m5b_sql "select state||'|'||holder_id from runtime_leases"; }

snapshot() {
  local task=$1 label=$2 ticket
  ticket=$(ticket_of "$task")
  echo "  [${label}] platform_state=$(state_of "$task") version=$(version_of "$task") ticket=${ticket:-none}"
  if [[ -n $ticket ]]; then
    python3 - "$M5B_BRIDGE_URL" "$M5B_BRIDGE_TOKEN" "$ticket" <<'PYRUN'
import json, sys, urllib.request
url, token, ticket = sys.argv[1], sys.argv[2], sys.argv[3]
request = urllib.request.Request(f'{url}/bridge/v1/tickets/{ticket}',
                                 headers={'authorization': 'Bearer ' + token})
body = json.load(urllib.request.urlopen(request))
print(json.dumps({'runtime_state': body.get('state'),
                  'assignmentId': body.get('assignmentId'),
                  'paused': body.get('paused') and {'stoppedAt': body['paused'].get('stoppedAt')},
                  'report': (body.get('report') or {}).get('state'),
                  'ended': (body.get('ended') or {}).get('outcome')}, sort_keys=True))
PYRUN
    echo "  [${label}] worker_sessions=$(ls -d "$SESSIONS"/*/worker-"$ticket" 2>/dev/null | wc -l) lease_rows=$(leases | tr '\n' ' ')"
  fi
}

echo "# c2 — pause during the start (real Web entrance, fresh isolated stack)"
echo "recorded=$(date -Is)"
echo "runtime_build=${M5B_MATRIX_UPSTREAM_BUILD}"
echo "runtime_loaded=$(readlink -f "$PROFILE_LINK" 2>/dev/null)"
echo "runtime_artifact=$(sha256sum "$(readlink -f "$PROFILE_LINK")/lib/index.js" 2>/dev/null | cut -d' ' -f1)"
echo "dispatcher_artifact=$(sha256sum "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js" | cut -d' ' -f1)"
echo
echo "=============================================================="
echo "## phase: c2-during-start (pause as soon as the ticket exists)"
created=$($LIVE new-task --text "M5-B pause before start: pause during the start." \
  --client-request-id "pause-during-start-$(date +%s)")
task=$(printf '%s' "$created" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
echo "  created_at=$(date -Is) task=${task}"
for _ in $(seq 1 480); do
  [[ -n $(ticket_of "$task") ]] && break
  sleep 0.25
done
echo "  ticket_created_at=$(date -Is) ticket=$(ticket_of "$task")"
echo "  \$ pause while state=$(state_of "$task") version=$(version_of "$task")"
for attempt in 1 2 3 4 5 6 7 8; do
  if out=$($LIVE pause --task "$task" 2>&1); then
    echo "  pause accepted on attempt ${attempt}"
    break
  fi
  echo "  pause attempt ${attempt} rejected: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
  sleep 0.2
done
echo "  paused_at=$(date -Is)"
snapshot "$task" "paused"
sleep 8
snapshot "$task" "after-8s"
echo "  \$ resume (a real delivery)"
$LIVE resume --task "$task" >/dev/null 2>&1 || echo "  resume rejected"
echo "  resumed_at=$(date -Is)"
for _ in $(seq 1 120); do
  [[ $(state_of "$task") == running ]] && break
  sleep 1
done
snapshot "$task" "resumed"
sleep 5
snapshot "$task" "settled"
echo
echo "## the runtime's own record of this pause (bridge/operations.jsonl)"
python3 - "$OPERATIONS" "$(ticket_of "$task")" <<'PYRUN'
import json, sys
path, ticket = sys.argv[1], sys.argv[2]
rows = []
try:
    with open(path) as log:
        for line in log:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get('kind') == 'pause' and row.get('ticketId') == ticket:
                rows.append(row)
except FileNotFoundError:
    pass
for row in rows:
    print(json.dumps({key: row.get(key) for key in ('state', 'error', 'evidence') if row.get(key) is not None},
                     sort_keys=True))
if not rows:
    print('no pause operation recorded')
PYRUN
