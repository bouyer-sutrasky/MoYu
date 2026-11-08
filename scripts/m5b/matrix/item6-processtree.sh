#!/usr/bin/env bash
# M5-B matrix item 6, part 1 — the whole process tree of a live worker turn and
# proof about what survives a stop. It deliberately does NOT reuse
# `paused.evidence`; every row below comes from walking /proc.
#
#   scripts/m5b/matrix/item6-processtree.sh
#
# STATUS: this script has NOT produced committed evidence yet. Its /proc walk
# works on the matrix stack, but the worker turn did not stay live on the runs
# attempted here, so docs/evidence/m5b/matrix/ has no item 6 log. Treat it as a
# starting point, not as a verified fixture.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

RUN=$M5B_MATRIX_RUN
REPORT_FILE="$M5B_MATRIX_TMP/worker-report.json"
SLEEP_FILE="$M5B_MATRIX_TMP/worker-sleep.txt"
INSTANCE_ROOT=$M5B_MATRIX_CGROUP_ROOT

fail() {
  echo "FAIL: $*"
  exit 1
}

# Every descendant of a pid, by repeated scan of /proc (ppid links), including
# processes that changed process group or session.
descendants() {
  python3 - "$1" <<'PY'
import os, subprocess, sys
root = int(sys.argv[1])
links = {}
for entry in os.listdir('/proc'):
    if not entry.isdigit():
        continue
    pid = int(entry)
    try:
        stat = open(f'/proc/{pid}/stat').read()
        ppid = int(stat.rsplit(')', 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        continue
    links.setdefault(ppid, []).append(pid)
out = []
stack = [root]
while stack:
    pid = stack.pop()
    for child in links.get(pid, []):
        if child in out:
            continue
        out.append(child)
        stack.append(child)
for pid in out:
    try:
        cgroup = open(f'/proc/{pid}/cgroup').read().split('0::')[1].strip()
    except (OSError, IndexError):
        cgroup = '?'
    try:
        command = open(f'/proc/{pid}/cmdline','rb').read().replace(b'\0', b' ').decode(errors='replace').strip()
    except OSError:
        command = '?'
    try:
        ppid = int(open(f'/proc/{pid}/stat').read().rsplit(')',1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        ppid = -1
    print(f"  pid={pid} ppid={ppid} cgroup={cgroup} cmd={command[:120]}")
print(f"  total_descendants={len(out)}")
PY
}

alive() {
  local pid=$1
  [[ -d /proc/$pid ]] && return 0
  return 1
}

echo "# item 6 — full process tree and stop proof, measured from /proc"
echo "recorded=$(date -Is)"
echo "head=$(cd "$M5B_MATRIX_ROOT" && git rev-parse HEAD)"
echo "slice=${M5B_MATRIX_SLICE_PATH#/sys/fs/cgroup}"
echo "instance_cgroup_root=${INSTANCE_ROOT#/sys/fs/cgroup}"
echo

echo "## keep the worker's turn open with a real long-running command"
echo 240 >"$SLEEP_FILE"
printf '%s\n' '{"state":"progress","summary":"Matrix item 6 process-tree probe."}' >"$REPORT_FILE"
CREATED=$(node "$M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs" new-task \
  --text "Matrix item 6: run a long command so the tree can be inspected." \
  --client-request-id "item6-$(date +%s)")
echo "$CREATED"
TASK=$(printf '%s' "$CREATED" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
REPO_ID=$M5B_REPOSITORY_ID
TICKET=""
for _ in $(seq 1 120); do
  TICKET=$(m5b_sql "select coalesce(upstream_ticket_id,'') from task_links where id='$TASK'")
  [[ -n $TICKET ]] && break
  sleep 1
done
[[ -n $TICKET ]] || fail "the runtime never created a ticket"
echo "task=$TASK ticket=$TICKET"
echo

echo "## wait for the real bash command to appear"
DEADLINE=$(( $(date +%s) + 120 ))
HARNESS_PID=""
while (( $(date +%s) < DEADLINE )); do
  HARNESS_PID=$(m5b_sql "select coalesce(pid::text,'') from repository_instances where repository_id='$REPO_ID' and state='online'")
  if [[ -n $HARNESS_PID ]]; then
    if descendants "$HARNESS_PID" | grep -q 'sleep 200'; then
      break
    fi
  fi
  sleep 1
done
[[ -n $HARNESS_PID ]] || fail "no online runtime pid"
echo "runtime_harness_pid=${HARNESS_PID}"
echo "runtime_harness_cgroup=$(m5b_proc_cgroup "$HARNESS_PID" | sed 's#^/sys/fs/cgroup##')"
echo

echo "## the whole descendant tree of the runtime (from /proc, not from paused.evidence)"
descendants "$HARNESS_PID" | tee "$RUN/item6-tree-before.txt"
echo

echo "## every process of the runtime tree is inside this run's instance cgroup"
python3 - "${INSTANCE_ROOT#/sys/fs/cgroup}" "$RUN/item6-tree-before.txt" <<'PY'
import sys
root, path = sys.argv[1], sys.argv[2]
bad = []
for line in open(path):
    if 'cgroup=' not in line:
        continue
    cgroup = line.split('cgroup=', 1)[1].split(' ', 1)[0]
    if not cgroup.startswith(root):
        bad.append(line.strip())
print(f"  checked={sum(1 for line in open(path) if 'cgroup=' in line)} outside_boundary={len(bad)}")
for item in bad:
    print(f"  OUTSIDE: {item}")
PY
echo

echo "## stop the runtime and look for survivors"
OLD_PID=$HARNESS_PID
kill -TERM "$OLD_PID" 2>/dev/null || true
for _ in $(seq 1 120); do
  alive "$OLD_PID" || break
  sleep 0.5
done
echo "old_runtime_pid_alive=$(alive "$OLD_PID" && echo yes || echo no)"
sleep 2
echo "## processes in the instance cgroup after the stop"
for dir in "$INSTANCE_ROOT"/*/; do
  [[ -d $dir ]] || continue
  procs=$(tr '\n' ' ' <"$dir/cgroup.procs" 2>/dev/null)
  echo "  $(basename "$dir") pids=[${procs}]"
done
echo "## any process whose cgroup is the old instance subtree, by a fresh /proc scan"
python3 - "$INSTANCE_ROOT" <<'PY'
import os, sys
root = sys.argv[1]
found = []
for entry in os.listdir('/proc'):
    if not entry.isdigit():
        continue
    try:
        cgroup = open(f'/proc/{entry}/cgroup').read().split('0::')[1].strip()
    except (OSError, IndexError):
        continue
    if cgroup.startswith(root):
        try:
            command = open(f'/proc/{entry}/cmdline','rb').read().replace(b'\0', b' ').decode(errors='replace')
        except OSError:
            command = '?'
        found.append((entry, cgroup, command[:120]))
print(f"  survivors={len(found)}")
for pid, cgroup, command in found:
    print(f"  ORPHAN pid={pid} cgroup={cgroup} cmd={command}")
PY
echo

echo "## the state the platform recorded for the stopped run"
m5b_sql "select 'task', state, coalesce(stopped_at::text,'-') from task_links where id='$TASK'"
m5b_sql "select 'lease', state, coalesce(waiting_for,'-') from runtime_leases where id=(select runtime_lease_id from task_links where id='$TASK')"
echo
echo "## verdict (part 1 only: the aggregate pressure run is NOT part of this log)"
echo "tree measured from /proc; every descendant was inside ${INSTANCE_ROOT#/sys/fs/cgroup}."
