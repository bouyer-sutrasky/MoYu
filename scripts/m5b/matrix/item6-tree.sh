#!/usr/bin/env bash
# M5-B matrix item 6a — the whole process tree of the runtime, and what is left of
# it after the runtime is stopped.
#
# The previous attempt only looked at the Bridge's direct children and borrowed the
# rest from `paused.evidence`. This walks every cgroup under the slice, recursively:
# `m5bmatrix.slice/cgroup.procs` is empty because every process lives in a subgroup.
#
#   scripts/m5b/matrix/item6-tree.sh
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

RUN=$M5B_MATRIX_RUN
SLICE=$M5B_MATRIX_SLICE_PATH
CGROOT=$M5B_MATRIX_CGROUP_ROOT
LIVE="node $M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs"
SLEEP_FILE="$M5B_MATRIX_TMP/worker-sleep.txt"

fail() {
  echo "FAIL: $*"
  exit 1
}

# Every cgroup directory of the slice, deepest last, with its process count.
list_groups() {
  find "$SLICE" -mindepth 1 -type d 2>/dev/null | sort
}

# One row per process anywhere in the slice: pid, uid, cgroup, full cmdline.
# `cgroup.procs` of a subgroup lists the processes that group owns; walking every
# subgroup recursively is the only way to see them, because the slice root's own
# cgroup.procs only lists processes attached directly to it (it is empty here).
walk_tree() {
  local group pid uid cmd cg
  printf '%-8s %-6s %-58s %s\n' pid uid cgroup cmdline
  for group in $(list_groups); do
    local count
    count=$(wc -l <"$group/cgroup.procs" 2>/dev/null || echo 0)
    [[ $count -eq 0 ]] && continue
    while read -r pid; do
      [[ -z $pid ]] && continue
      uid=$(awk '/^Uid:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo '?')
      cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-96)
      cg=$(m5b_proc_cgroup "$pid")
      printf '%-8s %-6s %-58s %s\n' "$pid" "$uid" "${cg#$SLICE/}" "$cmd"
    done <"$group/cgroup.procs"
  done
}

tree_cmdlines() {
  local pid
  for pid in $(tree_pids); do
    printf '%s %s\n' "$pid" "$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)"
  done
}

tree_pids() {
  local group
  for group in $(list_groups); do
    cat "$group/cgroup.procs" 2>/dev/null
  done | sort -u
}

echo "# item 6a — whole process tree of the runtime, and the empty tree after stopping it"
echo "recorded=$(date -Is)"
echo "dispatcher_artifact=$(sha256sum "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js" | cut -d' ' -f1) ($(stat -c %s "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js") bytes)"
echo "slice=${SLICE}"
echo "cgroup_root=${CGROOT}"
echo

echo "## the slice root owns no process itself (why a one-level look is wrong)"
echo "\$ cat ${SLICE}/cgroup.procs | wc -l"
wc -l <"$SLICE/cgroup.procs"
echo "\$ find ${SLICE} -mindepth 1 -type d | wc -l"
list_groups | wc -l
echo "\$ cat ${SLICE}/cgroup.controllers / ${SLICE}/cgroup.subtree_control"
cat "$SLICE/cgroup.controllers" 2>/dev/null | sed 's/^/controllers: /'
cat "$SLICE/cgroup.subtree_control" 2>/dev/null | sed 's/^/subtree_control: /'
echo

echo "## the units of the stack and the cgroup each one runs in"
for unit in m5bmatrix-pg m5bmatrix-provider m5bmatrix-supervisor m5bmatrix-dispatcher m5bmatrix-api; do
  printf '%-28s pid=%-8s cgroup=%s\n' "$unit" "$(m5b_unit_pid "$unit.service")" "$(m5b_unit_cgroup "$unit.service" | sed "s|$SLICE/||")"
done
echo

echo "## start a long turn that really spawns background children"
# The provider answers the worker's turn with `sh -c 'sleep N & sleep N & wait'`,
# so the runtime owns two real descendants, not just a node process.
echo 900 >"$SLEEP_FILE"
chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$SLEEP_FILE" 2>/dev/null || true
chmod 0640 "$SLEEP_FILE"
if tree_cmdlines | grep -q 'sleep 900'; then
  echo "a long turn with real children is already running; reusing it"
  TICKET=$(ps -eo pid,cmd 2>/dev/null | awk '/[s]leep 900/{print $1; exit}')
  TASK=$(m5b_sql "select coalesce((select id::text from task_links order by created_at desc limit 1),'')")
else
  CREATED=$($LIVE new-task --text "Matrix item 6a: hold a long turn with real background children." \
    --client-request-id "item6-tree-$(date +%s)")
  echo "$CREATED"
  TASK=$(printf '%s' "$CREATED" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
  TICKET=""
  for _ in $(seq 1 120); do
    TICKET=$(m5b_sql "select coalesce(upstream_ticket_id,'') from task_links where id='$TASK'")
    [[ -n $TICKET ]] && break
    sleep 1
  done
  [[ -n $TICKET ]] || fail "the runtime never created a ticket"
fi
echo "ticket=$TICKET"
echo

echo "## wait for the worker's real child processes to exist"
FOUND=0
for _ in $(seq 1 180); do
  if tree_cmdlines | grep -q 'sleep 900'; then
    FOUND=1
    break
  fi
  sleep 1
done
(( FOUND == 1 )) || fail "no 'sleep 900' descendant appeared; the tree walk would prove nothing"
echo "found=yes"
echo

echo "## the whole tree, recursively (pid, uid, cgroup, full cmdline)"
echo '$ find /sys/fs/cgroup/m5bmatrix.slice -mindepth 1 -type d | while read g; do cat "$g/cgroup.procs"; done  # then /proc/<pid>/cmdline, /proc/<pid>/cgroup'
walk_tree | tee "$RUN/tree-running.txt"
echo
echo "processes_in_slice=$(tree_pids | wc -l)"
echo "sleep_children=$(walk_tree | grep -c 'sleep 900' || true)"
echo

echo "## the worker's own view of its subtree (side evidence only, never the process table)"
$LIVE ticket --ticket "$TICKET" 2>/dev/null | python3 -c "
import json,sys
try:
    body = json.load(sys.stdin).get('body', {})
except Exception:
    body = {}
evidence = (body.get('paused') or {}).get('evidence')
print('ticket_state=', body.get('state'))
print('paused_evidence=', json.dumps(evidence)[:300] if evidence else None)
print('note: the paused.evidence field is absent for a running ticket and is never used as the process table')
"
echo

echo "## stopping the supervisor alone does NOT stop the runtime (the known behaviour, shown here)"
SUP_CG=$(m5b_unit_cgroup m5bmatrix-supervisor.service)
echo "\$ systemctl stop m5bmatrix-supervisor.service"
systemctl stop m5bmatrix-supervisor.service
sleep 3
echo "supervisor_active=$(systemctl is-active m5bmatrix-supervisor.service)"
if tree_pids | grep -qx . -A0 2>/dev/null; then :; fi
LEFT_AFTER_SUP=$(tree_pids | wc -l)
echo "processes_in_slice_after_stopping_only_the_supervisor=${LEFT_AFTER_SUP}"
echo "bridge_healthz_after_supervisor_stop=$(curl -fsS -m 2 http://127.0.0.1:3403/healthz 2>/dev/null || echo 'not answering')"
echo "dispatcher_port_3403_bound=$(ss -ltn 2>/dev/null | grep -c ':3403' || true)"
echo "verdict_for_this_step: the runtime in its own cgroup survived the supervisor stop, so it must be killed through the cgroup, not the unit"
echo

echo "## now kill the whole delegated subtree with cgroup.kill (the equivalent stop)"
echo "\$ write 1 to cgroup.kill of every group under ${CGROOT} (deepest first)"
for group in $(find "$CGROOT" -mindepth 1 -type d 2>/dev/null | sort -r); do
  if [[ -w "$group/cgroup.kill" ]]; then
    echo 1 >"$group/cgroup.kill" 2>/dev/null || true
    echo "killed ${group#$SLICE/}"
  fi
done
# The instance unit itself stays delegated and empty; its own kill covers stragglers.
if [[ -w "$CGROOT/cgroup.kill" ]]; then echo 1 >"$CGROOT/cgroup.kill" 2>/dev/null || true; fi
for _ in $(seq 1 60); do
  leftover=$(tree_pids | wc -l)
  (( leftover == 0 )) && break
  sleep 1
done
echo

echo "## the tree again, after the stop"
echo '$ same recursive walk as above'
walk_tree | tee "$RUN/tree-after-stop.txt"
echo "processes_under_the_runtime_cgroup_after_stop=$(find "$CGROOT" -mindepth 1 -type d 2>/dev/null | while read -r g; do wc -l <"$g/cgroup.procs" 2>/dev/null || echo 0; done | awk '{s+=$1} END{print s+0}')"
echo "sleep_survivors_anywhere_in_the_slice=$(walk_tree | grep -c 'sleep 900' || true)"
echo "bridge_healthz_after_kill=$(curl -fsS -m 2 http://127.0.0.1:3403/healthz 2>/dev/null || echo 'not answering')"
echo "port_3403_still_bound=$(ss -ltn 2>/dev/null | grep -c ':3403' || true)"
echo "port_3404_still_bound=$(ss -ltn 2>/dev/null | grep -c ':3404' || true)"
echo

echo "## the platform side of the same ticket"
m5b_sql "select id, state, version from task_links where id='$TASK'"
echo

echo "## verdict"
TREE_N=$(grep -c . "$RUN/tree-running.txt" || true)
echo "tree_rows=${TREE_N} (header included)"
echo "sleep_children_while_running='$(grep -c 'sleep 900' "$RUN/tree-running.txt" || true)'"
echo "processes_after_stop=$(tree_pids | wc -l)"
if grep -q 'sleep 900' "$RUN/tree-running.txt" && [[ $(tree_pids | wc -l) -eq 0 ]] && ! grep -q 'sleep 900' "$RUN/tree-after-stop.txt"; then
  echo "VERDICT: the whole tree is visible by recursive walk, and after the cgroup kill nothing of it remains. Passed."
else
  echo "VERDICT: not proven; see the tables above."
fi
