#!/usr/bin/env bash
# Shared facts for the M5-B on-site matrix runs (docs/evidence/m5b/matrix/).
#
# Every matrix item boots the same isolated stack: one enforceable systemd slice
# that holds the isolated PostgreSQL, the platform API, the dispatcher, the host
# supervisor, the supervisor-owned runtime cgroups and the local test provider.
# Nothing here touches the production 3082 service, the production database or
# the shared 55432 PostgreSQL.
#
# Layout of one run (see scripts/m5b/matrix/guard.mjs for the enforced rules):
#
#   $M5B_MATRIX_RUN              root-owned 0755, not writable by the matrix user
#   $M5B_MATRIX_PROTECTED        0700 root:root  supervisor token, seed, state
#   $M5B_MATRIX_CONFIG           0750 root:matrix  instances.json (read by supervisor)
#   $M5B_MATRIX_TMP              0700 matrix      provider/worker scratch files
#   $M5B_MATRIX_CREDENTIALS      0700 matrix      bridge credentials written by supervisor
#   $M5B_MATRIX_INSTANCE_ENV     0700 matrix      instance env files (bridge tokens)
#   $M5B_MATRIX_DSH_HOME         0700 matrix      staged runtime home
#
# Privileged bootstrap files never live in a directory the test identity can
# write, and the test identity never reuses the host agent key or gh config:
# its credentials are dedicated and probe-only (see prepare-nonroot.sh).
#
# Values can be overridden per run; the defaults are what the committed evidence
# logs were captured with.
M5B_MATRIX_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export PATH=/opt/moyu-node24/bin:$PATH
export M5B_MATRIX_ROOT=${M5B_MATRIX_ROOT:-$(cd "$M5B_MATRIX_DIR/../../.." && pwd)}
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
# The matrix gets its own harness home. The shared m5b profile is only a
# read-only source: the staged copy lives under the run root and carries the
# loopback-provider fixture, so no shared profile, credential store or session
# directory is read or written by the test identity.
export M5B_MATRIX_DSH_HOME=${M5B_MATRIX_DSH_HOME:-$M5B_MATRIX_RUN/dsh-home}
export M5B_MATRIX_PROFILE_SOURCE=${M5B_MATRIX_PROFILE_SOURCE:-/root/.dsh-m5/profiles/m5b}
export M5B_MATRIX_USER=${M5B_MATRIX_USER:-m5bmatrix}
export M5B_MATRIX_GROUP=${M5B_MATRIX_GROUP:-m5bmatrix}
export M5B_MATRIX_UPSTREAM_BUILD=${M5B_MATRIX_UPSTREAM_BUILD:-/root/src/upstream/m5b-admission-build21}
# Privileged bootstrap state: root-owned, verified before every write.
export M5B_MATRIX_PROTECTED=${M5B_MATRIX_PROTECTED:-$M5B_MATRIX_RUN/protected}
export M5B_MATRIX_CONFIG=${M5B_MATRIX_CONFIG:-$M5B_MATRIX_RUN/config}
export M5B_MATRIX_STAGE=${M5B_MATRIX_STAGE:-$M5B_MATRIX_RUN/stage}
export M5B_MATRIX_LOGS=${M5B_MATRIX_LOGS:-$M5B_MATRIX_RUN/logs}
# Matrix-owned temporary state, partitioned from the privileged files above.
export M5B_MATRIX_TMP=${M5B_MATRIX_TMP:-$M5B_MATRIX_RUN/tmp}
export M5B_MATRIX_CREDENTIALS=${M5B_MATRIX_CREDENTIALS:-$M5B_MATRIX_RUN/credentials}
export M5B_MATRIX_INSTANCE_ENV=${M5B_MATRIX_INSTANCE_ENV:-$M5B_MATRIX_RUN/instance-env}
export M5B_MATRIX_INSTANCE_LOGS=${M5B_MATRIX_INSTANCE_LOGS:-$M5B_MATRIX_RUN/instance-logs}
export M5B_MATRIX_WORKTREES=${M5B_MATRIX_WORKTREES:-$M5B_MATRIX_RUN/worktrees}
export M5B_MATRIX_SUPERVISOR_TOKEN_FILE=$M5B_MATRIX_PROTECTED/supervisor-token
export M5B_MATRIX_SEED_FILE=$M5B_MATRIX_PROTECTED/seed.env
export M5B_MATRIX_STATE=${M5B_MATRIX_STATE:-$M5B_MATRIX_PROTECTED/state.env}
export M5B_MATRIX_INSTANCES_JSON=${M5B_MATRIX_INSTANCES_JSON:-$M5B_MATRIX_CONFIG/instances.json}
# Dedicated, probe-only credentials. The host agent key and the shared
# /root/.config/gh-agent token are refused by the guard.
export M5B_MATRIX_SSH_KEY=${M5B_MATRIX_SSH_KEY:-/root/.config/m5bmatrix/probe_ssh_key}
export M5B_MATRIX_GH_CONFIG_DIR=${M5B_MATRIX_GH_CONFIG_DIR:-/root/.config/m5bmatrix/gh}
export M5B_MATRIX_GH_HOME=${M5B_MATRIX_GH_HOME:-/home/m5bmatrix}
export M5B_MATRIX_GH_CLI=${M5B_MATRIX_GH_CLI:-$M5B_MATRIX_ROOT/scripts/m5b/matrix/gh-m5b.sh}

export M5B_MATRIX_PG_URL="postgres://moyu@127.0.0.1:${M5B_MATRIX_PG_PORT}/${M5B_MATRIX_DB}"
export M5B_MATRIX_PG_ADMIN="postgres://moyu@127.0.0.1:${M5B_MATRIX_PG_PORT}/postgres"
export M5B_MATRIX_SLICE_PATH="/sys/fs/cgroup/${M5B_MATRIX_SLICE}"
export M5B_MATRIX_SUPERVISOR_CGROUP="/sys/fs/cgroup/${M5B_MATRIX_SLICE}/${M5B_MATRIX_SLICE%.slice}-supervisor.service"
export M5B_MATRIX_CGROUP_ROOT="$M5B_MATRIX_SUPERVISOR_CGROUP/instances"

m5b_log() {
  printf '%s\n' "$*"
}

# Prints the command about to run, so a captured log carries the exact command.
m5b_run() {
  printf '$ %s\n' "$*"
  "$@"
}

# Same, but masks token-bearing arguments before printing. Used for units and
# control calls whose argv carries a Bearer token.
m5b_run_redacted() {
  printf '$ %s\n' "$(printf '%s ' "$@" | sed -E 's/(TOKEN=|Bearer )[^ ]+/\1***/g')"
  "$@"
}

m5b_guard() {
  node "$M5B_MATRIX_DIR/guard.mjs" "$@"
}

m5b_prepare_run() {
  m5b_guard prepare-run --run "$M5B_MATRIX_RUN" --user "$M5B_MATRIX_USER"
}

m5b_check_run() {
  m5b_guard check-run --run "$M5B_MATRIX_RUN" --user "$M5B_MATRIX_USER"
}

m5b_audit_host() {
  m5b_guard audit-host --user "$M5B_MATRIX_USER"
}

m5b_audit_credentials() {
  m5b_guard audit-credentials --user "$M5B_MATRIX_USER" \
    --ssh-key "$M5B_MATRIX_SSH_KEY" --gh-config "$M5B_MATRIX_GH_CONFIG_DIR"
}

# Privileged bootstrap writes: the guard verifies ownership/mode and refuses a
# symbolic-link target on every call.
m5b_protected_write() {
  local name=$1 content=$2
  printf '%s' "$content" | m5b_guard write-protected --dir "$M5B_MATRIX_PROTECTED" --name "$name"
}

m5b_protected_read() {
  m5b_guard read-protected --dir "$M5B_MATRIX_PROTECTED" --name "$1"
}

m5b_protected_remove() {
  m5b_guard remove-protected --dir "$M5B_MATRIX_PROTECTED" --name "$1"
}

# A file the supervisor reads as the matrix identity: root-owned, group read.
m5b_config_write() {
  local name=$1 content=$2
  printf '%s' "$content" | m5b_guard write-config --dir "$M5B_MATRIX_CONFIG" \
    --name "$name" --user "$M5B_MATRIX_USER"
}

m5b_clean_owned() {
  m5b_guard clean-owned --dir "$1" --user "$M5B_MATRIX_USER"
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
