#!/usr/bin/env bash
# Shared facts for the M5-B on-site matrix runs (docs/evidence/m5b/matrix/).
#
# Every matrix item boots the same isolated stack: one enforceable systemd slice
# that holds the isolated PostgreSQL, the platform API, the dispatcher, the host
# supervisor, the supervisor-owned runtime cgroups and the local test provider.
# Nothing here touches the production 3082 service, the production database or
# the shared 55432 PostgreSQL.
#
# Values can be overridden per run; the defaults are what the committed evidence
# logs were captured with.

export PATH=/opt/moyu-node24/bin:$PATH
export M5B_MATRIX_ROOT=${M5B_MATRIX_ROOT:-/root/src/live-matrix-m5b-a222254fd0d8}
export M5B_MATRIX_RUN=${M5B_MATRIX_RUN:-/tmp/m5bmatrix}
export M5B_MATRIX_SLICE=${M5B_MATRIX_SLICE:-m5bmatrix.slice}
export M5B_MATRIX_BUDGET_MB=${M5B_MATRIX_BUDGET_MB:-8192}
export M5B_MATRIX_HIGH_MB=${M5B_MATRIX_HIGH_MB:-6144}
export M5B_MATRIX_PG_PORT=${M5B_MATRIX_PG_PORT:-55433}
export M5B_MATRIX_API_PORT=${M5B_MATRIX_API_PORT:-4510}
export M5B_MATRIX_SUP_PORT=${M5B_MATRIX_SUP_PORT:-4491}
export M5B_MATRIX_PROVIDER_PORT=${M5B_MATRIX_PROVIDER_PORT:-3851}
export M5B_MATRIX_DB=${M5B_MATRIX_DB:-m5b_matrix}
export M5B_MATRIX_REPOSITORY=${M5B_MATRIX_REPOSITORY:-Bouyer12/m5a-beta-adf10ad9}
export M5B_MATRIX_PROFILE=${M5B_MATRIX_PROFILE:-m5b}
export M5B_MATRIX_DSH_HOME=${M5B_MATRIX_DSH_HOME:-/root/.dsh-m5}
export M5B_MATRIX_STATE=${M5B_MATRIX_STATE:-$M5B_MATRIX_RUN/state.env}

export M5B_MATRIX_PG_URL="postgres://moyu@127.0.0.1:${M5B_MATRIX_PG_PORT}/${M5B_MATRIX_DB}"
export M5B_MATRIX_PG_ADMIN="postgres://moyu@127.0.0.1:${M5B_MATRIX_PG_PORT}/postgres"
export M5B_MATRIX_SLICE_PATH="/sys/fs/cgroup/${M5B_MATRIX_SLICE}"
export M5B_MATRIX_CGROUP_ROOT="/sys/fs/cgroup/${M5B_MATRIX_SLICE}/instances"

m5b_log() {
  printf '%s\n' "$*"
}

# Prints the command about to run, so a captured log carries the exact command.
m5b_run() {
  printf '$ %s\n' "$*"
  "$@"
}

m5b_sql() {
  PGPASSWORD= psql "${M5B_MATRIX_PG_URL}" -X -q -v ON_ERROR_STOP=1 -tA -c "$1"
}

m5b_sql_admin() {
  PGPASSWORD= psql "${M5B_MATRIX_PG_ADMIN}" -X -q -v ON_ERROR_STOP=1 -tA -c "$1"
}

m5b_wait_http() {
  local url=$1 timeout=${2:-90000} label=${3:-$url}
  local deadline=$(( $(date +%s) + timeout / 1000 ))
  while (( $(date +%s) < deadline )); do
    if curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "timed out waiting for ${label} (${url})" >&2
  return 1
}

m5b_unit_cgroup() {
  local unit=$1
  local cg
  cg=$(systemctl show -p ControlGroup --value "$unit" 2>/dev/null || true)
  [[ -n "$cg" ]] && printf '/sys/fs/cgroup%s\n' "$cg"
}

m5b_unit_pid() {
  systemctl show -p MainPID --value "$1" 2>/dev/null || true
}

m5b_proc_cgroup() {
  awk -F: '/^0::/{print "/sys/fs/cgroup"$3}' "/proc/$1/cgroup" 2>/dev/null || true
}

m5b_slice_facts() {
  local path=${1:-$M5B_MATRIX_SLICE_PATH}
  echo "slice=${path}"
  echo "  memory.max=$(cat "$path/memory.max" 2>/dev/null || echo missing)"
  echo "  memory.high=$(cat "$path/memory.high" 2>/dev/null || echo missing)"
  echo "  memory.current=$(cat "$path/memory.current" 2>/dev/null || echo missing)"
  echo "  memory.peak=$(cat "$path/memory.peak" 2>/dev/null || echo missing)"
  echo "  memory.events=$(tr '\n' ' ' < "$path/memory.events" 2>/dev/null || echo missing)"
  echo "  memory.swap.max=$(cat "$path/memory.swap.max" 2>/dev/null || echo missing)"
  echo "host_mem_available_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
}
