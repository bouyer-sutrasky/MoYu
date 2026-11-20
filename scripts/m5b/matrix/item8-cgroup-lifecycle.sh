#!/usr/bin/env bash
# M5-B matrix item 8 — real DSH instance lifecycle and cgroup ownership.
#
# Runs on the isolated matrix stack (stack.sh up) and drives the real supervisor,
# runtime and platform API. Covers: empty-root cold start, sleep/wake, supervisor
# restart, root exit with surviving descendants, same-name cgroup recreation and
# a foreign process holding the instance port.
#
#   scripts/m5b/matrix/item8-cgroup-lifecycle.sh [log-file]
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"
if [[ -f $M5B_MATRIX_STATE ]]; then
  # shellcheck disable=SC1090
  source "$M5B_MATRIX_STATE"
fi

SUP="http://127.0.0.1:${M5B_MATRIX_SUP_PORT}"
REPO=$M5B_REPOSITORY_ID
DB=$M5B_MATRIX_PG_URL
ROOT=$M5B_MATRIX_CGROUP_ROOT
SUP_TOKEN=$(m5b_protected_read supervisor-token) || {
  echo "FAIL: missing supervisor token; run stack.sh up" >&2
  exit 1
}
LIVE="node $M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs"
LOG=${1:-}
FAILURES=0

fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

verdict() {
  local name=$1 ok=$2 detail=$3
  if [[ $ok == 1 ]]; then
    echo "verdict ${name}=pass ${detail}"
  else
    echo "verdict ${name}=FAIL ${detail}"
    FAILURES=$((FAILURES + 1))
  fi
}

sup() {
  local method=$1 path=$2 body=${3:-}
  if [[ -n $body ]]; then
    curl -sS -X "$method" -H "authorization: Bearer ${SUP_TOKEN}" \
      -H 'content-type: application/json' -d "$body" "${SUP}${path}"
  else
    curl -sS -X "$method" -H "authorization: Bearer ${SUP_TOKEN}" "${SUP}${path}"
  fi
}

instance_json() {
  sup GET "/control/v1/instances/${REPO}"
}

field() {
  python3 -c 'import json,sys
try: d=json.load(sys.stdin)["data"]
except Exception: sys.exit(2)
print(json.dumps(d))'
}

wait_state() {
  local wanted=$1 timeout=${2:-240} body state
  for _ in $(seq 1 "$((timeout * 2))"); do
    body=$(instance_json)
    state=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["state"])' 2>/dev/null || true)
    [[ $state == "$wanted" ]] && { printf '%s' "$body"; return 0; }
    sleep 0.5
  done
  printf '%s' "$body"
  return 1
}

wait_reason() {
  local wanted=$1 timeout=${2:-120} body reason
  for _ in $(seq 1 "$((timeout * 2))"); do
    body=$(instance_json)
    reason=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["reasonCode"])' 2>/dev/null || true)
    [[ $reason == "$wanted" ]] && { printf '%s' "$body"; return 0; }
    sleep 0.5
  done
  printf '%s' "$body"
  return 1
}

starttime() {
  awk '{print $22}' "/proc/$1/stat" 2>/dev/null || true
}

pid_cgroup() {
  awk -F: '/^0::/{print $3}' "/proc/$1/cgroup" 2>/dev/null | sed 's#^/##'
}

capacity() {
  m5b_sql "select count(*) from repository_instances where state in ('online','starting','stopping')"
}

active_leases() {
  m5b_sql "select count(*) from runtime_leases where state = 'active'"
}

listeners() {
  ss -ltn 2>/dev/null | awk '$4 ~ /:3403$|:3404$/ {print $4}' | sort -u | tr '\n' ' '
}

snapshot() {
  local label=$1 body
  body=$(instance_json) || true
  echo "## ${label} $(date -Is)"
  printf '%s' "$body" | python3 -c '
import json,sys
d=json.load(sys.stdin)["data"]; o=d.get("ownership") or {}
print("state=%s desired=%s pid=%s reason=%s waiting=%s" % (d["state"],d["desiredState"],d["pid"],d["reasonCode"],d["waitingFor"]))
print("cgroup=%s inode=%s rootPid=%s" % (o.get("cgroup"),o.get("cgroupInode"),o.get("rootPid")))
print("members=%s" % [(m.get("pid"),m.get("startTime")) for m in (o.get("members") or [])])
print("ports=%s/%s memory.current=%s memory.max=%s" % (d["port"],d["bridgePort"],d.get("memoryCurrentBytes"),d.get("memoryLimitBytes")))
' 2>/dev/null || echo "instance=unavailable"
  local dir
  for dir in "$ROOT"/*/; do
    [[ -d $dir ]] || continue
    echo "cgroup_dir=$(basename "$dir") inode=$(stat -c %i "$dir") pids=[$(tr '\n' ' ' <"$dir/cgroup.procs" 2>/dev/null)]"
  done
  echo "listeners=[$(listeners)] capacity=$(capacity) active_leases=$(active_leases)"
  m5b_sql "select 'instance_row', state, desired_state, coalesce(pid::text,'-'), reason_code, coalesce(waiting_for,'-') from repository_instances"
  echo
}

old_generation() {
  instance_json | python3 -c '
import json,sys
d=json.load(sys.stdin)["data"]; o=d.get("ownership") or {}
print("%s %s %s" % (d["pid"], o.get("cgroup"), o.get("cgroupInode")))'
}

create_task() {
  local text=$1 request=$2
  $LIVE new-task --text "$text" --client-request-id "$request"
}

pause_task() {
  local task=$1
  $LIVE pause --task "$task" >/dev/null || true
  for _ in $(seq 1 120); do
    state=$(m5b_sql "select state from task_links where id='$task'")
    [[ $state == stopped ]] && return 0
    sleep 0.5
  done
  return 1
}

scenario_sleep_wake() {
  echo "### 1. sleep / wake"
  local before old_pid old_cgroup old_inode body pid cgroup inode
  before=$(old_generation); read -r old_pid old_cgroup old_inode <<<"$before"
  sup POST "/control/v1/instances/${REPO}/sleep" '{"manual":true}' >/dev/null
  body=$(wait_state sleeping 120) || fail "sleep did not reach sleeping"
  snapshot "after sleep"
  verdict sleep_pid_gone "$([[ $(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["pid"] or "")') == "" ]] && echo 1 || echo 0)" "old pid ${old_pid} cleared"
  verdict sleep_ports_released "$([[ -z $(listeners) ]] && echo 1 || echo 0)" "listeners=[$(listeners)]"
  verdict sleep_capacity_released "$([[ $(capacity) == 0 ]] && echo 1 || echo 0)" "capacity=$(capacity)"
  sup POST "/control/v1/instances/${REPO}/wake" '{"priority":20,"reason":"manual"}' >/dev/null
  body=$(wait_state online 240) || fail "wake did not reach online"
  snapshot "after wake"
  read -r pid cgroup inode <<<"$(old_generation)"
  verdict wake_new_pid "$([[ -n $pid && $pid != "$old_pid" ]] && echo 1 || echo 0)" "old=${old_pid} new=${pid}"
  verdict wake_new_inode "$([[ -n $inode && $inode != "$old_inode" ]] && echo 1 || echo 0)" "old=${old_inode} new=${inode}"
  verdict wake_ports_listening "$([[ -n $(listeners) ]] && echo 1 || echo 0)" "listeners=[$(listeners)]"
  verdict wake_capacity_used "$([[ $(capacity) == 1 ]] && echo 1 || echo 0)" "capacity=$(capacity)"
}

scenario_empty_root() {
  echo "### 2. empty-root cold start"
  local body pid cgroup inode old_pid
  body=$(old_generation); read -r old_pid _ <<<"$body"
  sup POST "/control/v1/instances/${REPO}/sleep" '{"manual":true}' >/dev/null
  wait_state sleeping 120 >/dev/null || fail "sleep before empty-root restart failed"
  local dir
  for dir in "$ROOT"/*/; do
    [[ -d $dir ]] || continue
    [[ -z $(tr -d '[:space:]' <"$dir/cgroup.procs" 2>/dev/null) ]] || fail "instance cgroup still populated: $dir"
    rmdir "$dir" || fail "could not remove empty instance cgroup $dir"
  done
  rmdir "$ROOT" || fail "could not remove the instance root"
  verdict empty_root_removed "$([[ ! -d $ROOT ]] && echo 1 || echo 0)" "root_missing=$([[ ! -d $ROOT ]] && echo yes || echo no)"
  sup POST "/control/v1/instances/${REPO}/wake" '{"priority":20,"reason":"manual"}' >/dev/null
  body=$(wait_state online 240) || fail "wake into the missing root did not reach online"
  snapshot "after cold start"
  read -r pid cgroup inode <<<"$(old_generation)"
  local controllers subtree dirs current max pids
  controllers=$(cat "$ROOT/cgroup.controllers" 2>/dev/null || true)
  subtree=$(cat "$ROOT/cgroup.subtree_control" 2>/dev/null || true)
  verdict empty_root_recreated "$([[ -d $ROOT ]] && echo 1 || echo 0)" "root_exists=$([[ -d $ROOT ]] && echo yes || echo no)"
  verdict empty_root_controllers "$([[ $controllers == *memory* && $subtree == *memory* && $subtree == *pids* ]] && echo 1 || echo 0)" "controllers=[$controllers] subtree=[$subtree]"
  current=$(cat "$cgroup/memory.current" 2>/dev/null || true); max=$(cat "$cgroup/memory.max" 2>/dev/null || true); pids=$(cat "$cgroup/pids.current" 2>/dev/null || true)
  verdict empty_root_metered "$([[ -n $current && -n $max && -n $pids ]] && echo 1 || echo 0)" "memory.current=${current:-missing} memory.max=${max:-missing} pids.current=${pids:-missing}"
  verdict empty_root_new_generation "$([[ -n $pid && $pid != "$old_pid" && -n $inode ]] && echo 1 || echo 0)" "old=${old_pid} new=${pid} inode=${inode}"
}

scenario_root_exit_descendants() {
  echo "### 3. root PID exits, descendants survive"
  printf '%s\n' '{"state":"progress","summary":"Ticket #94 matrix item 8: keep the turn open for the root-exit scenario."}' >"$M5B_MATRIX_CONTROL/worker-report.json"
  echo 240 >"$M5B_MATRIX_CONTROL/worker-sleep.txt"
  chmod 0644 "$M5B_MATRIX_CONTROL/worker-report.json" "$M5B_MATRIX_CONTROL/worker-sleep.txt" 2>/dev/null || true
  local created task body pid cgroup inode procs lease
  created=$(create_task "Ticket #94 matrix item 8: root exit with surviving descendants." "item8-desc-$(date +%s)")
  task=$(printf '%s' "$created" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
  echo "task=${task}"
  for _ in $(seq 1 180); do
    procs=$(for dir in "$ROOT"/*/; do [[ -d $dir ]] && cat "$dir/cgroup.procs" 2>/dev/null; done | wc -l)
    [[ $procs -ge 3 ]] && break
    sleep 1
  done
  body=$(old_generation); read -r pid cgroup inode <<<"$body"
  snapshot "before root exit"
  lease=$(m5b_sql "select coalesce(runtime_lease_id::text,'-') from task_links where id='$task'")
  verdict descendants_present "$([[ $procs -ge 3 ]] && echo 1 || echo 0)" "cgroup_procs=${procs}"
  verdict root_exit_lease_recorded "$([[ $lease != - && $(active_leases) -ge 1 ]] && echo 1 || echo 0)" "task=${task} lease=${lease} active=$(active_leases)"
  kill -KILL "$pid" 2>/dev/null || fail "could not kill root ${pid}"
  for _ in $(seq 1 120); do
    body=$(instance_json); state=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["state"])')
    [[ $state != online && $state != starting ]] && break
    sleep 0.5
  done
  sleep 3
  snapshot "after root exit"
  procs=$(for dir in "$ROOT"/*/; do [[ -d $dir ]] && cat "$dir/cgroup.procs" 2>/dev/null; done | wc -l)
  verdict root_exit_descendants_stopped "$([[ $procs == 0 ]] && echo 1 || echo 0)" "cgroup_procs=${procs}"
  verdict root_exit_ports_released "$([[ -z $(listeners) ]] && echo 1 || echo 0)" "listeners=[$(listeners)]"
  verdict root_exit_capacity_released "$([[ $(capacity) == 0 ]] && echo 1 || echo 0)" "capacity=$(capacity)"
  # The pause needs a live runtime to deliver the stop; wake once, then pause.
  # A second wake after the pause would race a duplicate spawn against the ports.
  if (( $(active_leases) > 0 )); then
    sup POST "/control/v1/instances/${REPO}/wake" '{"priority":20,"reason":"manual"}' >/dev/null
    wait_state online 240 >/dev/null || fail "wake before pausing the surviving task did not reach online"
  fi
  pause_task "$task" || fail "could not pause the task and release its lease"
  for _ in $(seq 1 240); do [[ $(active_leases) == 0 ]] && break; sleep 0.5; done
  verdict root_exit_lease_released "$([[ $(active_leases) == 0 ]] && echo 1 || echo 0)" "active_leases=$(active_leases)"
  body=$(instance_json)
  state=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["state"])')
  if [[ $state != online ]]; then
    sup POST "/control/v1/instances/${REPO}/wake" '{"priority":20,"reason":"manual"}' >/dev/null
    wait_state online 240 >/dev/null || fail "wake after root exit did not reach online"
  fi
  snapshot "next generation after root exit"
  verdict root_exit_next_generation "$([[ -n $(listeners) && $(capacity) == 1 ]] && echo 1 || echo 0)" "listeners=[$(listeners)] capacity=$(capacity)"
}

scenario_foreign_port() {
  echo "### 4. foreign process holds the instance port"
  local body old_pid foreign_pid foreign_cgroup detail
  sup POST "/control/v1/instances/${REPO}/sleep" '{"manual":true}' >/dev/null
  wait_state sleeping 120 >/dev/null || fail "sleep before foreign-port scenario failed"
  runuser -u "$M5B_MATRIX_USER" -- /usr/bin/node -e \
    'require("net").createServer((socket) => socket.end()).listen(3404, "127.0.0.1")' \
    >/dev/null 2>&1 &
  foreign_pid=""
  for _ in $(seq 1 50); do
    foreign_pid=$(ss -ltnp 2>/dev/null | awk '/:3404 / {if (match($0,/pid=[0-9]+/)) print substr($0,RSTART+4,RLENGTH-4)}' | head -1)
    [[ -n $foreign_pid ]] && break
    sleep 0.1
  done
  foreign_cgroup=$(pid_cgroup "$foreign_pid" 2>/dev/null || true)
  echo "foreign_pid=${foreign_pid} foreign_cgroup=${foreign_cgroup}"
  verdict foreign_port_listening "$([[ -n $foreign_pid ]] && echo 1 || echo 0)" "port 3404 held by ${foreign_pid:-none}"
  sup POST "/control/v1/instances/${REPO}/wake" '{"priority":20,"reason":"manual"}' >/dev/null
  body=$(wait_reason port_in_use 120) || fail "wake with a foreign port did not report port_in_use"
  snapshot "after foreign-port wake"
  detail=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["reasonDetail"] or "")')
  verdict foreign_owner_reported "$([[ $detail == *"$foreign_pid"* ]] && echo 1 || echo 0)" "${detail}"
  verdict foreign_still_alive "$([[ -n $foreign_pid && -d /proc/$foreign_pid ]] && echo 1 || echo 0)" "pid ${foreign_pid:-none} alive"
  verdict foreign_slot_not_used "$([[ $(capacity) == 0 ]] && echo 1 || echo 0)" "capacity=$(capacity)"
  kill -KILL "$foreign_pid" 2>/dev/null || true
  sleep 1
  # `retry` resets the fault and starts one instance; a following `wake` can race
  # a second spawn against the same ports, so only retry here.
  if ! sup POST "/control/v1/instances/${REPO}/retry" '{}' >/dev/null 2>&1; then
    sup POST "/control/v1/instances/${REPO}/wake" '{"priority":20,"reason":"manual"}' >/dev/null
  fi
  wait_state online 240 >/dev/null || fail "retry after freeing the foreign port did not reach online"
  sleep 2
  wait_state online 60 >/dev/null || fail "the instance did not stay online after the foreign port was freed"
  snapshot "next generation after foreign port"
  verdict foreign_port_next_generation "$([[ -n $(listeners) && $(capacity) == 1 ]] && echo 1 || echo 0)" "listeners=[$(listeners)] capacity=$(capacity)"
}

scenario_same_name_cgroup() {
  echo "### 5. same-name cgroup recreation with a live foreign process"
  local body pid cgroup inode supervisor_pid
  body=$(instance_json)
  state=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["state"])')
  [[ $state == online ]] || { fail "same-name scenario needs an online generation, got ${state}"; return; }
  sleep 2
  body=$(instance_json)
  state=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["state"])')
  [[ $state == online ]] || { fail "same-name scenario generation did not stay online, got ${state}"; return; }
  body=$(old_generation); read -r pid cgroup inode <<<"$body"
  supervisor_pid=$(m5b_unit_pid "${M5B_MATRIX_SLICE%.slice}-supervisor.service")
  echo "generation_pid=${pid} cgroup=${cgroup} inode=${inode} supervisor=${supervisor_pid}"
  kill -STOP "$supervisor_pid" || fail "could not pause the supervisor for the replacement"
  local holding="$ROOT/ticket94-holding" foreign foreign_pid new_inode
  mkdir "$holding" || fail "could not create the holding cgroup"
  local proc
  for proc in $(cat "$cgroup/cgroup.procs"); do echo "$proc" >"$holding/cgroup.procs"; done
  rmdir "$cgroup" || fail "could not remove the emptied instance cgroup"
  mkdir "$cgroup" || fail "could not recreate the same cgroup path"
  new_inode=$(stat -c %i "$cgroup")
  runuser -u "$M5B_MATRIX_USER" -- /bin/sleep 600 >/dev/null 2>&1 &
  foreign=$!
  sleep 0.5
  echo "$foreign" >"$cgroup/cgroup.procs"
  foreign_pid=$(cat "$cgroup/cgroup.procs" | head -1)
  kill -KILL "$pid" 2>/dev/null || true
  kill -CONT "$supervisor_pid" || fail "could not resume the supervisor"
  sleep 12
  snapshot "same-name cgroup after resume"
  body=$(instance_json)
  local owner_cgroup owner_inode state reason capacity_now
  owner_cgroup=$(printf '%s' "$body" | python3 -c 'import json,sys;print((json.load(sys.stdin)["data"].get("ownership") or {}).get("cgroup"))')
  owner_inode=$(printf '%s' "$body" | python3 -c 'import json,sys;print((json.load(sys.stdin)["data"].get("ownership") or {}).get("cgroupInode"))')
  state=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["state"])')
  reason=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["reasonCode"])')
  capacity_now=$(capacity)
  verdict same_name_inode_replaced "$([[ $new_inode != "$inode" ]] && echo 1 || echo 0)" "recorded=${inode} current=${new_inode}"
  verdict same_name_foreign_untouched "$([[ -n $foreign_pid && -d /proc/$foreign_pid && $(cat "$cgroup/cgroup.procs" | tr '\n' ' ') == *"$foreign_pid"* ]] && echo 1 || echo 0)" "foreign=${foreign_pid} pids=[$(tr '\n' ' ' <"$cgroup/cgroup.procs")]"
  verdict same_name_slot_retained "$([[ $state == stopping && $reason == stop_failed && $capacity_now == 1 ]] && echo 1 || echo 0)" "state=${state} reason=${reason} capacity=${capacity_now}"
  verdict same_name_old_identity_kept "$([[ $owner_cgroup == "$cgroup" && $owner_inode == "$inode" ]] && echo 1 || echo 0)" "ownership_cgroup=${owner_cgroup} inode=${owner_inode}"
  kill -KILL "$foreign_pid" 2>/dev/null || true
  sleep 0.5
  rmdir "$cgroup" || fail "could not remove the recreated cgroup after cleanup"
  rmdir "$holding" || true
  for _ in $(seq 1 80); do [[ $(capacity) == 0 ]] && break; sleep 0.5; done
  verdict same_name_capacity_released "$([[ $(capacity) == 0 ]] && echo 1 || echo 0)" "capacity=$(capacity)"
  sup POST "/control/v1/instances/${REPO}/wake" '{"priority":20,"reason":"manual"}' >/dev/null
  wait_state online 240 >/dev/null || fail "wake after same-name cleanup did not reach online"
  snapshot "next generation after same-name cleanup"
  verdict same_name_next_generation "$([[ -n $(listeners) && $(capacity) == 1 ]] && echo 1 || echo 0)" "listeners=[$(listeners)] capacity=$(capacity)"
}

scenario_supervisor_restart() {
  echo "### 6. supervisor restart"
  local body old_pid old_cgroup old_inode new_pid new_cgroup new_inode
  body=$(old_generation); read -r old_pid old_cgroup old_inode <<<"$body"
  systemctl restart "${M5B_MATRIX_SLICE%.slice}-supervisor.service" || fail "supervisor restart failed"
  for _ in $(seq 1 120); do
    curl -sS -m 2 -H "authorization: Bearer ${SUP_TOKEN}" "${SUP}/control/v1/health" 2>/dev/null | grep -q '"status":"ok"' && break
    sleep 0.5
  done
  wait_state online 240 >/dev/null || fail "runtime did not come online after the supervisor restart"
  body=$(old_generation); read -r new_pid new_cgroup new_inode <<<"$body"
  snapshot "after supervisor restart"
  verdict supervisor_restarted "$([[ $(systemctl is-active "${M5B_MATRIX_SLICE%.slice}-supervisor.service") == active ]] && echo 1 || echo 0)" "unit=$(systemctl is-active "${M5B_MATRIX_SLICE%.slice}-supervisor.service")"
  verdict supervisor_new_generation "$([[ -n $new_pid && $new_pid != "$old_pid" && -n $new_inode && $new_inode != "$old_inode" ]] && echo 1 || echo 0)" "old=${old_pid}/${old_inode} new=${new_pid}/${new_inode}"
  verdict supervisor_capacity_used "$([[ $(capacity) == 1 ]] && echo 1 || echo 0)" "capacity=$(capacity)"
  verdict supervisor_ports_listening "$([[ -n $(listeners) ]] && echo 1 || echo 0)" "listeners=[$(listeners)]"
}

main() {
  echo "# M5-B matrix item 8 — real DSH instance lifecycle and cgroup ownership"
  echo "recorded=$(date -Is)"
  echo "head=$(cd "$M5B_MATRIX_ROOT" && git rev-parse HEAD)"
  echo "slice=${M5B_MATRIX_SLICE_PATH#/sys/fs/cgroup} cgroup_root=${ROOT#/sys/fs/cgroup}"
  echo "supervisor_artifact=$(cd "$M5B_MATRIX_ROOT" && sha256sum apps/supervisor/dist/main.js | cut -d' ' -f1) ($(stat -c %s "$M5B_MATRIX_ROOT/apps/supervisor/dist/main.js") bytes)"
  echo "api_artifact=$(cd "$M5B_MATRIX_ROOT" && sha256sum apps/api/dist/server.js | cut -d' ' -f1)"
  echo "dispatcher_artifact=$(cd "$M5B_MATRIX_ROOT" && sha256sum apps/dispatcher/dist/main.js | cut -d' ' -f1)"
  echo "identity=$(id -un "$M5B_MATRIX_USER") uid=$(id -u "$M5B_MATRIX_USER")"
  echo
  snapshot "initial generation"
  scenario_sleep_wake
  scenario_empty_root
  scenario_root_exit_descendants
  scenario_foreign_port
  scenario_same_name_cgroup
  scenario_supervisor_restart
  echo 0 >"$M5B_MATRIX_CONTROL/worker-sleep.txt"
  echo "## verdict"
  if (( FAILURES == 0 )); then
    echo "all lifecycle verdicts passed"
    exit 0
  fi
  echo "${FAILURES} lifecycle verdict(s) failed"
  exit 1
}

if [[ -n $LOG ]]; then
  main 2>&1 | tee "$LOG"
  exit "${PIPESTATUS[0]}"
fi
main
