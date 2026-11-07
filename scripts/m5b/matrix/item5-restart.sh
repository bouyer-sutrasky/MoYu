#!/usr/bin/env bash
# M5-B matrix item 5 — a full restart of both stores while a ticket sits in
# paused / waiting_input / awaiting_review, comparing every field before and
# after.
#
#   scripts/m5b/matrix/item5-restart.sh <paused|waiting_input|awaiting_review>
#
# The script prints every command it runs and its raw output; the caller commits
# that output as docs/evidence/m5b/matrix/item5-<state>-restart.log.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

STATE=${1:-paused}
RUN=$M5B_MATRIX_RUN
REPORT_FILE="$RUN/worker-report.json"
SUP_TOKEN=$(tr -d '\n' <"$RUN/supervisor-token")
LIVE="node $M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs"

fail() {
  echo "FAIL: $*"
  exit 1
}

supervisor_call() {
  curl -sS -X "$1" -H "authorization: Bearer ${SUP_TOKEN}" -H 'content-type: application/json' \
    -d "${3:-{\}}" "http://127.0.0.1:${M5B_MATRIX_SUP_PORT}$2"
}

instance_pid() {
  supervisor_call GET "/control/v1/instances/${M5B_REPOSITORY_ID}" |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["pid"] or "")'
}

task_field() {
  m5b_sql "select $1 from task_links where id='$M5B_TASK_ID'"
}

cursor_raw() {
  local label=$1
  echo "## runtime_cursors ${label}"
  echo '$ psql "$DATABASE_URL" -c "select repository_id, cursor, updated_at from runtime_cursors"'
  PGPASSWORD= psql "${M5B_MATRIX_PG_URL}" -c \
    "select repository_id, cursor, updated_at from runtime_cursors"
}

cursor_value() {
  PGPASSWORD= psql "${M5B_MATRIX_PG_URL}" -X -q -tA -c \
    "select coalesce((select cursor from runtime_cursors where repository_id='$M5B_REPOSITORY_ID'), 0)" |
    tr -d '[:space:]'
}

echo "# item 5 — restart reconciliation in state: ${STATE}"
echo "recorded=$(date -Is)"
echo "head=$(cd "$M5B_MATRIX_ROOT" && git rev-parse HEAD)"
echo "dispatcher_artifact=$(cd "$M5B_MATRIX_ROOT" && sha256sum apps/dispatcher/dist/main.js | cut -d' ' -f1) ($(stat -c %s "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js") bytes)"
echo "slice=$(cat "$M5B_MATRIX_SLICE_PATH/cgroup.procs" 2>/dev/null | wc -l) procs directly in slice"
echo

# --- choose the worker's report kind for this scenario -----------------------
# Every scenario keeps the worker's turn open with a real long-running bash call
# so the ticket is still live when the restart happens; without that a finished
# turn ends the ticket as completed and there is nothing to reconcile.
echo 600000 >"$RUN/worker-delay.txt"
case "$STATE" in
  paused)
    printf '%s\n' '{"state":"progress","summary":"Working on the lifecycle probe."}' >"$REPORT_FILE"
    ;;
  waiting_input)
    printf '%s\n' '{"state":"progress","summary":"Need a decision before continuing.","human_action":"Which branch should the probe use?"}' >"$REPORT_FILE"
    ;;
  awaiting_review)
    printf '%s\n' '{"state":"ready","summary":"Lifecycle probe ready for review."}' >"$REPORT_FILE"
    ;;
  *)
    fail "unknown state ${STATE}"
    ;;
esac
echo "## worker report fixture"
cat "$REPORT_FILE"
echo

echo "## create and drive the ticket through the real owner API"
CREATED=$($LIVE new-task --text "Matrix item 5 ${STATE} probe." --client-request-id "item5-${STATE}-$(date +%s)")
echo "$CREATED"
M5B_TASK_ID=$(printf '%s' "$CREATED" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
export M5B_TASK_ID
echo

echo "## wait for the runtime to accept the task"
for _ in $(seq 1 120); do
  ticket=$(task_field upstream_ticket_id)
  [[ -n $ticket ]] && break
  sleep 1
done
[[ -n $ticket ]] || fail "the runtime never created a ticket (task state: $(task_field state))"
echo "ticket=$ticket task_state=$(task_field state)"
echo

echo "## wait for the target runtime state"
deadline=$(( $(date +%s) + 180 ))
target=$STATE
[[ $STATE == paused ]] && target=stopped
while (( $(date +%s) < deadline )); do
  current=$(task_field state)
  [[ $current == "$target" ]] && break
  if [[ $STATE == paused && $current == running ]]; then
    echo "state: ${current}; pausing through the real owner API"
    $LIVE pause --task "$M5B_TASK_ID" >/dev/null
  fi
  if [[ $STATE == awaiting_review ]]; then
    ticket_state=$(python3 -c "
import json,urllib.request
req=urllib.request.Request('$M5B_BRIDGE_URL/bridge/v1/tickets/$ticket', headers={'authorization':'Bearer $M5B_BRIDGE_TOKEN'})
print(json.load(urllib.request.urlopen(req))['state'])
")
    [[ $ticket_state == awaiting_review ]] && { echo "runtime ticket state: awaiting_review"; break; }
  fi
  sleep 1
done
echo "platform task state: $(task_field state)  (waited for ${target})"
echo

cursor_raw "BEFORE the restart"
CURSOR_BEFORE=$(cursor_value)
echo "cursor_before_restart=${CURSOR_BEFORE}"
echo

echo "## snapshot before the restart"
$LIVE ticket --ticket "$ticket" >"$RUN/ticket-before.json"
cat "$RUN/ticket-before.json"
m5b_sql "select 'task', state, version, upstream_ticket_id, coalesce(runtime_lease_id::text,'-'), coalesce(stopped_at::text,'-') from task_links where id='$M5B_TASK_ID'"
m5b_sql "select 'lease', state, fencing_token, coalesce(waiting_for,'-'), coalesce(stop_proven_at::text,'-') from runtime_leases where id=(select runtime_lease_id from task_links where id='$M5B_TASK_ID')"
m5b_sql "select 'delivery', count(*), string_agg(state::text, ',') from deliveries where message_id in (select id from messages where conversation_id=(select conversation_id from task_links where id='$M5B_TASK_ID'))"
BRIDGE_PID_BEFORE=$(instance_pid)
DISPATCHER_PID_BEFORE=$(m5b_unit_pid "${M5B_MATRIX_SLICE%.slice}-dispatcher.service")
echo "bridge_pid_before=${BRIDGE_PID_BEFORE} dispatcher_pid_before=${DISPATCHER_PID_BEFORE}"
echo

echo "## restart both stores"
if [[ $STATE == paused ]]; then
  echo '$ supervisor sleep --manual (graceful runtime stop with stop proof)'
  supervisor_call POST "/control/v1/instances/${M5B_REPOSITORY_ID}/sleep" '{"manual":true}' | head -c 300
  echo
  for _ in $(seq 1 120); do
    alive=0
    kill -0 "$BRIDGE_PID_BEFORE" 2>/dev/null && alive=1
    (( alive == 0 )) && break
    sleep 0.5
  done
else
  # A live turn owns a job, so a graceful sleep is refused (and should be). Kill
  # the harness instead: the supervisor observes the death and the next wake
  # starts a fresh process, which is the restart this scenario measures.
  echo '$ kill -TERM <runtime pid> (abrupt restart while the turn waits on the model)'
  kill -TERM "$BRIDGE_PID_BEFORE" 2>/dev/null || true
  for _ in $(seq 1 120); do
    alive=0
    kill -0 "$BRIDGE_PID_BEFORE" 2>/dev/null && alive=1
    (( alive == 0 )) && break
    sleep 0.5
  done
  sleep 3
fi
echo "old bridge pid alive after stop: ${alive:-0}"
echo '$ supervisor wake (fresh runtime process)'
supervisor_call POST "/control/v1/instances/${M5B_REPOSITORY_ID}/wake" '{"priority":20,"reason":"manual"}' | head -c 300
echo
for _ in $(seq 1 240); do
  row=$(supervisor_call GET "/control/v1/instances/${M5B_REPOSITORY_ID}")
  [[ $row == *'"state":"online"'* && $row == *'"reasonCode":"listening"'* ]] && break
  sleep 0.5
done
BRIDGE_PID_AFTER=$(instance_pid)
echo "bridge_pid_after=${BRIDGE_PID_AFTER}"

echo '$ systemctl restart dispatcher'
systemctl restart "${M5B_MATRIX_SLICE%.slice}-dispatcher.service"
sleep 4
DISPATCHER_PID_AFTER=$(m5b_unit_pid "${M5B_MATRIX_SLICE%.slice}-dispatcher.service")
echo "dispatcher_pid_after=${DISPATCHER_PID_AFTER}"
bridge_restarted=no
[[ $BRIDGE_PID_BEFORE != "$BRIDGE_PID_AFTER" ]] && bridge_restarted=yes
dispatcher_restarted=no
[[ $DISPATCHER_PID_BEFORE != "$DISPATCHER_PID_AFTER" ]] && dispatcher_restarted=yes
echo "bridge restarted: ${bridge_restarted}"
echo "dispatcher restarted: ${dispatcher_restarted}"
[[ $bridge_restarted == yes && $dispatcher_restarted == yes ]] \
  || fail "the restart did not happen (bridge=${bridge_restarted} dispatcher=${dispatcher_restarted}); the comparison would be meaningless"
echo

echo "## restart reconciliation lines from the dispatcher"
journalctl -u "${M5B_MATRIX_SLICE%.slice}-dispatcher.service" --since "-40s" --no-pager |
  grep -E "reconcile|dispatcher.ready" | tail -10
echo

echo "## snapshot after the restart"
sleep 6
$LIVE ticket --ticket "$ticket" >"$RUN/ticket-after.json"
cat "$RUN/ticket-after.json"
m5b_sql "select 'task', state, version, upstream_ticket_id, coalesce(runtime_lease_id::text,'-'), coalesce(stopped_at::text,'-') from task_links where id='$M5B_TASK_ID'"
m5b_sql "select 'lease', state, fencing_token, coalesce(waiting_for,'-'), coalesce(stop_proven_at::text,'-') from runtime_leases where id=(select runtime_lease_id from task_links where id='$M5B_TASK_ID')"
echo

echo "## field-by-field comparison"
python3 - "$RUN/ticket-before.json" "$RUN/ticket-after.json" <<'PY'
import json,sys
before=json.load(open(sys.argv[1]))["body"]
after=json.load(open(sys.argv[2]))["body"]
def flat(value, prefix=""):
    out={}
    if isinstance(value, dict):
        for key,item in value.items():
            out.update(flat(item, f"{prefix}{key}."))
    elif isinstance(value, list):
        out[prefix.rstrip('.')]=json.dumps(value, sort_keys=True)
    else:
        out[prefix.rstrip('.')]=value
    return out
b=flat(before); a=flat(after)
# A restart may legitimately change these; anything else must be identical.
volatile = {"updatedAt"}
diffs=[(k,b.get(k),a.get(k)) for k in sorted(set(b)|set(a)) if b.get(k)!=a.get(k)]
material=[d for d in diffs if d[0] not in volatile]
print(f"{'field':48} {'before':38} after")
for k,bv,av in diffs:
    print(f"{k:48} {str(bv)[:36]:38} {str(av)[:36]}")
print()
print(f"compared_fields={len(set(b)|set(a))} differing={len(diffs)} material_differences={len(material)}")
print("verdict:", "identical" if not material else "DIFFERS")
PY
echo

cursor_raw "AFTER the restart, before any new delivery"
CURSOR_AFTER_RESTART=$(cursor_value)
echo "cursor_after_restart=${CURSOR_AFTER_RESTART}"
echo

echo "## a real delivery after the restart (same ticket, real entrance)"
case "$STATE" in
  paused)
    echo '$ live.mjs resume --task <id>   (POST /api/v1/tasks/:id/resume)'
    $LIVE resume --task "$M5B_TASK_ID" | head -12
    ;;
  *)
    echo '$ live.mjs message --conversation <id>   (POST /api/v1/conversations/:id/messages)'
    $LIVE message --conversation "$(task_field conversation_id)" \
      --text "Matrix restart follow-up." | head -12
    ;;
esac
echo

echo "## wait for the cursor to advance after that delivery"
CURSOR_DEADLINE=$(( $(date +%s) + 90 ))
CURSOR_AFTER_DELIVERY=$CURSOR_AFTER_RESTART
while (( $(date +%s) < CURSOR_DEADLINE )); do
  CURSOR_AFTER_DELIVERY=$(cursor_value)
  (( CURSOR_AFTER_DELIVERY > CURSOR_AFTER_RESTART )) && break
  sleep 1
done
cursor_raw "AFTER the real delivery"
echo "cursor_after_delivery=${CURSOR_AFTER_DELIVERY}"
echo

echo "## verdict on the cursor"
echo "cursor_before_restart=${CURSOR_BEFORE}"
echo "cursor_after_restart=${CURSOR_AFTER_RESTART}"
echo "cursor_after_delivery=${CURSOR_AFTER_DELIVERY}"
if (( CURSOR_AFTER_DELIVERY > CURSOR_AFTER_RESTART )); then
  echo "VERDICT: cursor ${CURSOR_AFTER_RESTART} -> ${CURSOR_AFTER_DELIVERY}; the reconciliation chain still advances after the restart."
elif (( CURSOR_AFTER_RESTART != CURSOR_BEFORE )); then
  echo "VERDICT: the cursor moved only during the restart (${CURSOR_BEFORE} -> ${CURSOR_AFTER_RESTART}) and not on the new delivery; NOT proven."
else
  echo "VERDICT: cursor did not advance (${CURSOR_BEFORE} -> ${CURSOR_AFTER_DELIVERY}); the reconciliation chain is NOT proven."
fi

