#!/usr/bin/env bash
# M5-B matrix item 1c — pause and start interleaved in three phases.
#
# For each phase the log records the real timeline, the ticket and assignment
# snapshots around it, the execution-lease rows, and how many worker executions
# and deliveries actually happened (counted from the runtime's worker sessions and
# from the dispatcher's delivery lines, never from the platform's state field).
#
#   scripts/m5b/matrix/item1-pause-start.sh
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

LIVE="node $M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs"
SESSIONS=$M5B_MATRIX_DSH_HOME/sessions

ticket_of() { m5b_sql "select coalesce(upstream_ticket_id,'') from task_links where id='$1'"; }
state_of() { m5b_sql "select state from task_links where id='$1'"; }
leases() { m5b_sql "select state||'|'||holder_id from runtime_leases"; }

snapshot() {
  local task=$1 label=$2 ticket
  ticket=$(ticket_of "$task")
  echo "  [${label}] platform_state=$(state_of "$task") ticket=${ticket:-none}"
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

run_phase() {
  local phase=$1 pause_when=$2
  echo "=============================================================="
  echo "## phase: ${phase} (pause ${pause_when})"
  local t0 created task ticket
  t0=$(date -Is)
  created=$($LIVE new-task --text "Matrix item 1c: pause ${pause_when} the start." \
    --client-request-id "item1-${phase}-$(date +%s)")
  task=$(printf '%s' "$created" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
  echo "  created_at=${t0} task=${task}"
  for _ in $(seq 1 120); do
    ticket=$(ticket_of "$task")
    [[ -n $ticket ]] && break
    sleep 1
  done
  echo "  ticket_created_at=$(date -Is) ticket=${ticket:-none}"

  case "$pause_when" in
    before-start)
      # Pause while the task is still queued for admission, i.e. before any worker
      # starts. If it starts first, the phase is wrong and says so.
      echo "  \$ pause while state=$(state_of "$task")"
      $LIVE pause --task "$task" >/dev/null 2>&1 || echo "  pause rejected"
      ;;
    during-start)
      echo "  \$ pause as soon as the worker starts (state=$(state_of "$task"))"
      $LIVE pause --task "$task" >/dev/null 2>&1 || echo "  pause rejected"
      ;;
    after-start)
      for _ in $(seq 1 180); do
        [[ $(state_of "$task") == running ]] && break
        sleep 1
      done
      echo "  \$ pause after the worker is running (state=$(state_of "$task"))"
      $LIVE pause --task "$task" >/dev/null 2>&1 || echo "  pause rejected"
      ;;
  esac
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
  echo "  deliveries_for_this_ticket=$(journalctl -u m5bmatrix-dispatcher.service --since "-6min" --no-pager 2>/dev/null | grep -ac "\"conversationId\"" || true)"
  echo
}

echo "# item 1c — pause and start in three phases (real Web entrance, real pause/resume)"
echo "recorded=$(date -Is)"
echo "dispatcher_artifact=$(sha256sum "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js" | cut -d' ' -f1)"
echo
run_phase c1-before-start before-start
run_phase c2-during-start during-start
run_phase c3-after-start after-start

echo "## how many worker executions actually ran (one session directory per ticket)"
ls -d "$SESSIONS"/*/worker-* 2>/dev/null | wc -l
