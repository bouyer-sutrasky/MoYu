#!/usr/bin/env bash
# M5-B matrix item 2 — measured memory of the managed boundary.
#
# Reads the real cgroups of the isolated PostgreSQL, the platform API, the
# dispatcher, the host supervisor, the runtime instance and the local test
# provider, proves they are members of one slice, then runs a real build/test
# process inside the same slice and reads its own cgroup peak.
#
#   scripts/m5b/matrix/item2-cgroup.sh
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

SLICE_PATH=$M5B_MATRIX_SLICE_PATH
PREFIX=${M5B_MATRIX_SLICE%.slice}

fail() {
  echo "FAIL: $*"
  exit 1
}

show_cgroup() {
  local label=$1 path=$2
  echo "## ${label}"
  echo "  path=${path#/sys/fs/cgroup}"
  echo "  memory.current=$(cat "$path/memory.current" 2>/dev/null || echo missing)"
  echo "  memory.peak=$(cat "$path/memory.peak" 2>/dev/null || echo missing)"
  echo "  memory.max=$(cat "$path/memory.max" 2>/dev/null || echo missing)"
  echo "  memory.high=$(cat "$path/memory.high" 2>/dev/null || echo missing)"
  echo "  memory.events=$(tr '\n' ' ' <"$path/memory.events" 2>/dev/null || echo missing)"
  echo "  pids.current=$(cat "$path/pids.current" 2>/dev/null || echo missing)"
}

echo "# item 2 — measured memory inside one managed boundary"
echo "recorded=$(date -Is)"
echo "head=$(cd "$M5B_MATRIX_ROOT" && git rev-parse HEAD)"
echo "host_mem_available_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
echo

echo "## boundary"
echo "slice=${SLICE_PATH#/sys/fs/cgroup}"
echo "memory.max=$(cat "$SLICE_PATH/memory.max")"
echo "memory.high=$(cat "$SLICE_PATH/memory.high")"
echo "memory.current=$(cat "$SLICE_PATH/memory.current")"
echo "memory.peak=$(cat "$SLICE_PATH/memory.peak")"
echo "memory.swap.max=$(cat "$SLICE_PATH/memory.swap.max")"
echo "memory.events=$(tr '\n' ' ' <"$SLICE_PATH/memory.events")"
echo "cgroup.controllers=$(cat "$SLICE_PATH/cgroup.controllers")"
echo

echo "## members of the slice (unit, pid, own cgroup)"
for unit in "${PREFIX}-pg.service" "${PREFIX}-api.service" "${PREFIX}-dispatcher.service" \
  "${PREFIX}-supervisor.service" "${PREFIX}-provider.service"; do
  pid=$(m5b_unit_pid "$unit")
  cgroup=$(m5b_proc_cgroup "$pid")
  echo "  ${unit} pid=${pid} cgroup=${cgroup#/sys/fs/cgroup}"
  case "$cgroup" in
    "$SLICE_PATH"/*) echo "    in this slice: yes" ;;
    *) echo "    in this slice: NO" ; fail "${unit} is outside ${SLICE_PATH}" ;;
  esac
done
for dir in "$M5B_MATRIX_CGROUP_ROOT"/*/; do
  [[ -d $dir ]] || continue
  procs=$(tr '\n' ' ' <"$dir/cgroup.procs" 2>/dev/null)
  [[ -z ${procs// /} ]] && continue
  echo "  runtime cgroup $(basename "$dir") pids=[${procs}] cgroup=${dir%/}"
  case "$dir" in
    "$SLICE_PATH"/*) echo "    in this slice: yes" ;;
    *) echo "    in this slice: NO" ;;
  esac
done
echo

echo "## measured memory per member"
show_cgroup "postgresql (${PREFIX}-pg.service)" "$SLICE_PATH/${PREFIX}-pg.service"
show_cgroup "platform api (${PREFIX}-api.service)" "$SLICE_PATH/${PREFIX}-api.service"
show_cgroup "dispatcher (${PREFIX}-dispatcher.service)" "$SLICE_PATH/${PREFIX}-dispatcher.service"
show_cgroup "supervisor (${PREFIX}-supervisor.service)" "$SLICE_PATH/${PREFIX}-supervisor.service"
show_cgroup "local provider (${PREFIX}-provider.service)" "$SLICE_PATH/${PREFIX}-provider.service"
for dir in "$M5B_MATRIX_CGROUP_ROOT"/*/; do
  [[ -d $dir ]] || continue
  [[ -z $(tr -d '[:space:]' <"$dir/cgroup.procs" 2>/dev/null) ]] && continue
  show_cgroup "runtime instance $(basename "$dir")" "${dir%/}"
done
echo

echo "## a real build/test process inside the same slice"
available_before=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
echo "host_mem_available_before_kb=${available_before}"
systemd-run --unit="${PREFIX}-testproc" --slice="$M5B_MATRIX_SLICE" \
  --working-directory="$M5B_MATRIX_ROOT" \
  --setenv=PATH=/opt/moyu-node24/bin:/usr/bin:/bin \
  --property=MemoryMax=2G --property=MemorySwapMax=0 \
  /bin/bash -c 'corepack pnpm --filter @moyu/api test 2>&1 | tail -6' >/dev/null 2>&1
test_cg=""
peak=0
events=""
limit=""
for _ in $(seq 1 600); do
  cg=$(systemctl show -p ControlGroup --value "${PREFIX}-testproc.service" 2>/dev/null || true)
  if [[ -n $cg && -r "/sys/fs/cgroup${cg}/memory.peak" ]]; then
    test_cg=$cg
    value=$(cat "/sys/fs/cgroup${cg}/memory.peak" 2>/dev/null || echo 0)
    (( value > peak )) && peak=$value
    events=$(tr '\n' ' ' <"/sys/fs/cgroup${cg}/memory.events" 2>/dev/null || echo "")
    limit=$(cat "/sys/fs/cgroup${cg}/memory.max" 2>/dev/null || echo "")
  fi
  systemctl is-active --quiet "${PREFIX}-testproc.service" || break
  sleep 0.2
done
echo "test_process_cgroup=${test_cg#/sys/fs/cgroup}"
echo "test_process_memory_peak_bytes=${peak}"
echo "test_process_limit_bytes=${limit:-missing}"
echo "test_process_events=${events:-missing}"
systemctl show -p Result --value "${PREFIX}-testproc.service" | sed 's/^/test_process_result=/'
systemctl reset-failed "${PREFIX}-testproc.service" 2>/dev/null || true
echo "slice_memory_peak_after=$(cat "$SLICE_PATH/memory.peak")"
echo "slice_memory_events_after=$(tr '\n' ' ' <"$SLICE_PATH/memory.events")"
echo "host_mem_available_after_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
echo

echo "## verdict"
limits_ok=yes
[[ $(cat "$SLICE_PATH/memory.max") == $(( M5B_MATRIX_BUDGET_MB * 1024 * 1024 )) ]] || limits_ok=no
oom=$(awk '$1=="oom_kill"{print $2}' "$SLICE_PATH/memory.events")
echo "slice_limit_matches_policy=${limits_ok}"
echo "slice_oom_kill_total=${oom:-0}"
echo "All four services and the build/test process ran inside ${SLICE_PATH#/sys/fs/cgroup}."
