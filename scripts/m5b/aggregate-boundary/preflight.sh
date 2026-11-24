#!/usr/bin/env bash
# Read-only preflight for the Issue #42 verification of the 8 GiB aggregate hard
# boundary and the memory-admission hysteresis. It creates, starts, stops and
# moves nothing: it only stats cgroups, units, /proc/meminfo and the harness, so
# it can run before the isolated stack is up (and while it is still blocked).
#
# The run it gates (see docs/evidence/m5b/aggregate-boundary/PLAN.md) may only
# start when every gate here passes:
#
#   - unified cgroup v2 with the memory controller and PSI available;
#   - the target slice, if it already exists, carries the declared 8 GiB / 6 GiB
#     pair and no swap (a mismatch means the run would measure another boundary);
#   - when the stack is up, all five harness members are active and each one's
#     ControlGroup sits inside the slice (a partial stack is a mismatch; a fully
#     down stack is expected before `stack.sh up` and is only informational);
#   - the host really has room for an 8 GiB slice above the 4 GiB floor;
#   - the isolation precheck of #36 (PR #49) exists and passes, because the
#     matrix harness runs as the dedicated `m5bmatrix` identity, not as root;
#   - the build artifacts the harness will start are present in $M5B_MATRIX_ROOT.
#
# Exit codes:
#   0  every gate passed, the bounded run may start;
#   1  a measured fact contradicts the declared boundary (fix it, do not run);
#   2  a prerequisite is missing (dependency not merged / isolation not
#      confirmed), so the boundary stays "unverified" and the preflight is kept.
#
#   scripts/m5b/aggregate-boundary/preflight.sh
set -uo pipefail

MIB=$((1024 * 1024))
GIB=$((1024 * MIB))

SLICE_NAME=${M5B_MATRIX_SLICE:-m5bmatrix.slice}
SLICE_PATH=${M5B_MATRIX_SLICE_PATH:-/sys/fs/cgroup/$SLICE_NAME}
HARD_MB=${M5B_MATRIX_BUDGET_MB:-8192}
HIGH_MB=${M5B_MATRIX_HIGH_MB:-6144}
FLOOR_MB=${M5B_MATRIX_HOST_FLOOR_MB:-4096}
ROOT=${M5B_MATRIX_ROOT:-/root/src/${DSH_SUPERAGENT_NAME:-aggregate-pressure}}
UNITS=(
  "${SLICE_NAME%.slice}-pg.service"
  "${SLICE_NAME%.slice}-api.service"
  "${SLICE_NAME%.slice}-dispatcher.service"
  "${SLICE_NAME%.slice}-supervisor.service"
  "${SLICE_NAME%.slice}-provider.service"
)

FAIL=0
INCOMPLETE=0

pass() { printf '  PASS       %s\n' "$*"; }
fail() { printf '  FAIL       %s\n' "$*"; FAIL=1; }
incomplete() { printf '  INCOMPLETE %s\n' "$*"; INCOMPLETE=1; }
info() { printf '  %s\n' "$*"; }

meminfo() { awk -v key="$1" '$1 == key":" { print $2 }' /proc/meminfo; }
events_field() { awk -v key="$1" '$1 == key { print $2 }' "$2/memory.events" 2>/dev/null; }

echo "# M5-B aggregate boundary preflight (Issue #42)"
echo "recorded=$(date -Is)"
echo "host=$(hostname) kernel=$(uname -r) systemd=$(systemctl --version | head -1 | awk '{print $2}')"
echo "slice=${SLICE_PATH}"
echo "declared_boundary=memory.max ${HARD_MB} MiB / memory.high ${HIGH_MB} MiB / swap.max 0"
echo "matrix_root=${ROOT}"
echo

echo "## cgroup v2 and the memory controller"
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  pass "unified cgroup v2 hierarchy"
else
  fail "no /sys/fs/cgroup/cgroup.controllers: not a cgroup v2 host"
fi
if grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then
  pass "memory controller available at the root"
else
  fail "memory controller is not available at the cgroup root"
fi
if [[ -r /sys/fs/cgroup/memory.pressure ]]; then
  pass "memory PSI (memory.pressure) is readable"
else
  fail "memory PSI is missing; the admission pressure gate cannot be measured"
fi
echo

echo "## the target slice"
if [[ -d $SLICE_PATH ]]; then
  SLICE_MAX=$(cat "$SLICE_PATH/memory.max" 2>/dev/null || echo missing)
  SLICE_HIGH=$(cat "$SLICE_PATH/memory.high" 2>/dev/null || echo missing)
  SLICE_SWAP=$(cat "$SLICE_PATH/memory.swap.max" 2>/dev/null || echo missing)
  info "memory.max=${SLICE_MAX} memory.high=${SLICE_HIGH} memory.swap.max=${SLICE_SWAP}"
  info "memory.current=$(cat "$SLICE_PATH/memory.current" 2>/dev/null || echo missing)"
  info "memory.peak=$(cat "$SLICE_PATH/memory.peak" 2>/dev/null || echo missing)"
  info "memory.events=[$(tr '\n' ' ' <"$SLICE_PATH/memory.events" 2>/dev/null)]"
  info "memory.events.local=[$(tr '\n' ' ' <"$SLICE_PATH/memory.events.local" 2>/dev/null)]"
  if [[ $SLICE_MAX == "$((HARD_MB * MIB))" ]]; then
    pass "slice memory.max equals the declared ${HARD_MB} MiB"
  else
    fail "slice memory.max=${SLICE_MAX} is not the declared ${HARD_MB} MiB; the run would measure another boundary"
  fi
  if [[ $SLICE_HIGH == "$((HIGH_MB * MIB))" ]]; then
    pass "slice memory.high equals the declared ${HIGH_MB} MiB"
  else
    fail "slice memory.high=${SLICE_HIGH} is not the declared ${HIGH_MB} MiB; restore it before the run"
  fi
  if [[ $SLICE_SWAP == 0 ]]; then
    pass "slice memory.swap.max=0, so the boundary cannot be escaped through swap"
  else
    fail "slice memory.swap.max=${SLICE_SWAP}; swap would hide the boundary"
  fi
else
  info "slice ${SLICE_PATH} is absent; stack.sh up creates and verifies it in a fresh run"
fi
echo

echo "## members of the slice (a member outside the slice proves nothing)"
ALL_ACTIVE=1
ACTIVE_COUNT=0
for unit in "${UNITS[@]}"; do
  state=$(systemctl show -p ActiveState --value "$unit" 2>/dev/null || true)
  cg=$(systemctl show -p ControlGroup --value "$unit" 2>/dev/null || true)
  if [[ $state == active || $state == activating ]]; then
    ACTIVE_COUNT=$((ACTIVE_COUNT + 1))
    case "$cg" in
      /${SLICE_NAME}/*) pass "$unit active inside ${SLICE_NAME} (${cg})" ;;
      *) fail "$unit active but its ControlGroup=${cg:-<empty>} is not inside ${SLICE_NAME}" ;;
    esac
    cur=$(cat "/sys/fs/cgroup${cg}/memory.current" 2>/dev/null || echo unknown)
    info "  ${unit} memory.current=${cur} memory.max=$(cat "/sys/fs/cgroup${cg}/memory.max" 2>/dev/null || echo unknown)"
  else
    ALL_ACTIVE=0
    info "$unit not active (${state:-unknown})"
  fi
done
if (( ACTIVE_COUNT == 0 )); then
  info "stack is down: this preflight only clears the preconditions; run it again after stack.sh up and require every member inside the slice before any pressure step"
elif (( ALL_ACTIVE )); then
  pass "all five matrix members are active inside ${SLICE_NAME}: the pressure scenarios may sample them"
else
  fail "partial stack: ${ACTIVE_COUNT}/${#UNITS[@]} members active; do not start a pressure step"
fi
echo

echo "## host headroom"
MEM_TOTAL=$(meminfo MemTotal)
MEM_AVAIL=$(meminfo MemAvailable)
SWAP_TOTAL=$(meminfo SwapTotal)
info "MemTotal=$((MEM_TOTAL / 1024)) MiB MemAvailable=$((MEM_AVAIL / 1024)) MiB SwapTotal=$((SWAP_TOTAL / 1024)) MiB"
info "run floor: abort when MemAvailable drops below ${FLOOR_MB} MiB"
if (( MEM_TOTAL >= HARD_MB + FLOOR_MB )); then
  pass "MemTotal covers the ${HARD_MB} MiB slice plus the ${FLOOR_MB} MiB floor"
else
  fail "MemTotal=$((MEM_TOTAL / 1024)) MiB cannot hold the ${HARD_MB} MiB slice plus the ${FLOOR_MB} MiB floor"
fi
if (( MEM_AVAIL >= HARD_MB + 2 * 1024 )); then
  pass "MemAvailable now leaves at least 2 GiB above the ${HARD_MB} MiB slice"
else
  fail "MemAvailable=$((MEM_AVAIL / 1024)) MiB is too close to the ${HARD_MB} MiB slice for a bounded run"
fi
echo

echo "## isolation precondition (#36, PR #49)"
PRECHECK="$ROOT/scripts/m5b/matrix/precheck.mjs"
if [[ -f $PRECHECK ]]; then
  if command -v node >/dev/null 2>&1; then
    out=$(cd "$ROOT" && node "$PRECHECK" 2>&1)
    rc=$?
    echo "$out" | sed 's/^/  /' | tail -40
    if (( rc == 0 )); then
      pass "isolation precheck exited 0 (local facts)"
    else
      incomplete "isolation precheck exited ${rc}; the matrix run stays blocked (field convergence is an owner action)"
    fi
  else
    incomplete "node is not available to run the isolation precheck"
  fi
else
  incomplete "isolation precheck is absent in ${ROOT}; it lands with #36 / PR #49, and no matrix run may start before it passes"
fi
echo

echo "## artifacts the harness will start"
DISPATCHER="$ROOT/apps/dispatcher/dist/main.js"
if [[ -f $DISPATCHER ]]; then
  pass "dispatcher artifact $(stat -c %s "$DISPATCHER") bytes sha256=$(sha256sum "$DISPATCHER" | cut -d' ' -f1)"
else
  incomplete "dispatcher artifact ${DISPATCHER} is missing; build ${ROOT} from the verified head first"
fi
for artifact in "$ROOT/apps/supervisor/dist/main.js" "$ROOT/apps/api/dist/server.js" "$ROOT/scripts/m5b/local-provider.mjs"; do
  if [[ -f $artifact ]]; then
    pass "artifact present: ${artifact#"$ROOT"/}"
  else
    incomplete "artifact missing: ${artifact#"$ROOT"/}"
  fi
done
echo

echo "## admission arithmetic for the hysteresis scenario (from apps/supervisor/src/config.ts and resources.ts)"
echo "  target=${M5B_MATRIX_MEMORY_TARGET_MB:-4096} MiB budget=${M5B_MATRIX_MEMORY_BUDGET_MB:-6144} MiB"
echo "  hard=${HARD_MB} MiB reserve=${M5B_MATRIX_MEMORY_RESERVE_MB:-1024} MiB hysteresis=${M5B_MATRIX_MEMORY_HYSTERESIS_MB:-256} MiB"
echo "  instance estimate = min(INSTANCE_MEMORY_MAX, ceil(target / max_online))"
for online in 2 3; do
  target=${M5B_MATRIX_MEMORY_TARGET_MB:-4096}
  imax=${M5B_MATRIX_INSTANCE_MAX_MB:-3072}
  estimate=$(( (target + online - 1) / online ))
  (( estimate > imax )) && estimate=$imax
  budget=${M5B_MATRIX_MEMORY_BUDGET_MB:-6144}
  hysteresis=${M5B_MATRIX_MEMORY_HYSTERESIS_MB:-256}
  echo "  max_online=${online}: estimate=${estimate} MiB"
  echo "    blocked repository stays in resource_wait while aggregate current in ($((budget - hysteresis - estimate)), $((budget - estimate))] MiB"
  echo "    a fresh repository is refused as over_budget when aggregate current > $((HARD_MB - estimate)) MiB"
done
echo

echo "## verdict"
if (( FAIL )); then
  echo "verdict=mismatch"
  exit 1
elif (( INCOMPLETE )); then
  echo "verdict=unverified (prerequisite missing; keep this preflight, do not run the boundary probe)"
  exit 2
else
  echo "verdict=ready"
  exit 0
fi
