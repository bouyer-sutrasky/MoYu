#!/usr/bin/env bash
# Boots and tears down the isolated M5-B matrix stack.
#
#   scripts/m5b/matrix/stack.sh up      # fresh slice, PG, migrations, seed, runtime, API, dispatcher
#   scripts/m5b/matrix/stack.sh down    # stops everything this run created
#   scripts/m5b/matrix/stack.sh status  # prints measured facts, touches nothing
#
# The stack is one enforceable slice so API, PostgreSQL, dispatcher, supervisor,
# runtime and test processes are all inside the same managed memory boundary.
# Production 3082, the production database and the shared 55432 PostgreSQL are
# never touched.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

SLICE=$M5B_MATRIX_SLICE
ANCHOR="${SLICE%.slice}-anchor.service"
PG_UNIT="${SLICE%.slice}-pg.service"
SUP_UNIT="${SLICE%.slice}-supervisor.service"
DISP_UNIT="${SLICE%.slice}-dispatcher.service"
API_UNIT="${SLICE%.slice}-api.service"
PROV_UNIT="${SLICE%.slice}-provider.service"
ALL_UNITS=("$PG_UNIT" "$PROV_UNIT" "$SUP_UNIT" "$DISP_UNIT" "$API_UNIT")

RUN=$M5B_MATRIX_RUN
PGDATA="$RUN/pgdata"
LOG_DIR="$RUN/logs"
INSTANCES_JSON="$RUN/instances.json"
SUP_TOKEN_FILE="$RUN/supervisor-token"
PROVIDER_LOG="$RUN/local-provider.jsonl"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

note() {
  echo "== $*"
}

stop_unit() {
  local unit=$1
  systemctl stop "$unit" 2>/dev/null || true
  systemctl reset-failed "$unit" 2>/dev/null || true
}

down() {
  note "stopping matrix units"
  for unit in "${ALL_UNITS[@]}"; do
    printf '  stop %s\n' "$unit"
    stop_unit "$unit"
  done
  stop_unit "$ANCHOR"
  # The supervisor moves a runtime into its own instance cgroup, so stopping the
  # supervisor unit does not stop that runtime. Tear the instance subtree down
  # explicitly, otherwise the next start fails with `port_in_use`.
  if [[ -d $M5B_MATRIX_CGROUP_ROOT ]]; then
    local dir
    while IFS= read -r dir; do
      [[ -f $dir/cgroup.kill ]] && { echo 1 >"$dir/cgroup.kill" 2>/dev/null || true; }
    done < <(find "$M5B_MATRIX_CGROUP_ROOT" -mindepth 1 -maxdepth 2 -type d 2>/dev/null)
    for _ in $(seq 1 40); do
      local busy=0
      while IFS= read -r dir; do
        [[ -n $(tr -d '[:space:]' <"$dir/cgroup.procs" 2>/dev/null) ]] && busy=1
      done < <(find "$M5B_MATRIX_CGROUP_ROOT" -mindepth 1 -maxdepth 2 -type d 2>/dev/null)
      (( busy == 0 )) && break
      sleep 0.25
    done
    find "$M5B_MATRIX_CGROUP_ROOT" -depth -mindepth 1 -maxdepth 2 -type d -exec rmdir {} \; 2>/dev/null || true
  fi
  # Wait for the loopback ports to be released before the next start.
  for _ in $(seq 1 40); do
    ss -ltn 2>/dev/null | grep -qE '127\.0\.0\.1:(3403|3404) ' || break
    sleep 0.25
  done
  # A leftover unit keeps the slice alive; stop the slice only after its members.
  for _ in $(seq 1 20); do
    [[ -d $M5B_MATRIX_SLICE_PATH ]] || break
    sleep 0.25
  done
  if [[ -d $M5B_MATRIX_SLICE_PATH ]]; then
    echo "  note: ${M5B_MATRIX_SLICE_PATH} still exists (held by a remaining member)"
  else
    echo "  slice ${SLICE} removed"
  fi
  rm -f "$M5B_MATRIX_STATE"
}

start_slice() {
  local available_before
  available_before=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  (( available_before >= 4 * 1024 * 1024 )) || fail "host MemAvailable ${available_before} kB is below the 4 GiB safety floor"
  note "creating the aggregate slice"
  m5b_run systemd-run --unit="${ANCHOR%.service}" --slice="$SLICE" \
    --uid="$M5B_MATRIX_USER" --gid="$M5B_MATRIX_GROUP" \
    --property=MemoryMax=64M --property=MemorySwapMax=0 \
    /bin/sleep 86400 >/dev/null || fail "could not create the slice anchor"
  m5b_run systemctl set-property --runtime "$SLICE" \
    "MemoryMax=${M5B_MATRIX_BUDGET_MB}M" "MemoryHigh=${M5B_MATRIX_HIGH_MB}M" \
    MemorySwapMax=0 || fail "could not set the slice memory policy"
  local max high
  max=$(cat "$M5B_MATRIX_SLICE_PATH/memory.max")
  high=$(cat "$M5B_MATRIX_SLICE_PATH/memory.high")
  [[ $max == $(( M5B_MATRIX_BUDGET_MB * 1024 * 1024 )) ]] || fail "slice memory.max is ${max}"
  [[ $high == $(( M5B_MATRIX_HIGH_MB * 1024 * 1024 )) ]] || fail "slice memory.high is ${high}"
  # The instance cgroups live under the supervisor's own delegated unit cgroup,
  # which only exists once that unit starts; start_supervisor sets them up as the
  # matrix identity. Nothing is created here.
  m5b_slice_facts
}

start_postgres() {
  note "starting the isolated PostgreSQL inside the slice"
  mkdir -p "$RUN" "$LOG_DIR"
  chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$RUN" "$LOG_DIR"
  chmod 0755 "$RUN"
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"
  if [[ ! -f $PGDATA/PG_VERSION ]]; then
    m5b_run runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb \
      -D "$PGDATA" -U moyu --auth=trust -E UTF8 >"$LOG_DIR/initdb.log" 2>&1 \
      || fail "initdb failed, see $LOG_DIR/initdb.log"
  fi
  m5b_run systemd-run --unit="${PG_UNIT%.service}" --slice="$SLICE" \
    --uid=postgres --gid=postgres --property=MemoryMax=1G --property=MemorySwapMax=0 \
    /usr/lib/postgresql/16/bin/postgres -D "$PGDATA" \
    -p "$M5B_MATRIX_PG_PORT" -k /tmp -c listen_addresses=127.0.0.1 \
    >/dev/null || fail "could not start the matrix PostgreSQL"
  for _ in $(seq 1 120); do
    pg_isready -h 127.0.0.1 -p "$M5B_MATRIX_PG_PORT" -q && break
    sleep 0.5
  done
  pg_isready -h 127.0.0.1 -p "$M5B_MATRIX_PG_PORT" || fail "PostgreSQL did not accept connections"
  echo "pg unit cgroup=$(m5b_unit_cgroup "$PG_UNIT")"
}

migrate_and_seed() {
  note "creating ${M5B_MATRIX_DB} and applying migrations"
  m5b_sql_admin "drop database if exists ${M5B_MATRIX_DB} with (force)" >/dev/null
  m5b_sql_admin "create database ${M5B_MATRIX_DB}" >/dev/null
  ( cd "$M5B_MATRIX_ROOT" \
    && m5b_run env DATABASE_URL="$M5B_MATRIX_PG_URL" \
      corepack pnpm --filter @moyu/db db:migrate ) || fail "migrations failed"

  note "seeding the owner, repository and one browser session"
  local session_token owner_id repo_id
  session_token=$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-43)
  m5b_sql "insert into owners (display_name) values ('M5-B Matrix Owner') returning id" >/dev/null
  owner_id=$(m5b_sql "select id from owners order by created_at limit 1")
  repo_id=$(m5b_sql "insert into repositories (owner_id, full_name, default_branch, status)
                     values ('$owner_id', '$M5B_MATRIX_REPOSITORY', 'main', 'provisioning')
                     returning id" | tr -d '[:space:]')
  local token_hash
  token_hash=$(printf '%s' "$session_token" | sha256sum | cut -d' ' -f1)
  m5b_sql "insert into sessions (owner_id, token_hash, expires_at)
           values ('$owner_id', '$token_hash', now() + interval '10 days')" >/dev/null
  printf 'export M5B_OWNER_ID=%s\nexport M5B_REPOSITORY_ID=%s\nexport M5B_SESSION_TOKEN=%s\n' \
    "$owner_id" "$repo_id" "$session_token" >"$RUN/seed.env"
  echo "owner=$owner_id repository=$repo_id"
}

start_provider() {
  note "starting the loopback test provider"
  # A stale log or dump owned by another user makes the provider's own writes
  # fail; remove them so the unit always starts with a writable file.
  rm -f "$PROVIDER_LOG" "$RUN/provider-prompts.jsonl"
  m5b_run systemd-run --unit="${PROV_UNIT%.service}" --slice="$SLICE" \
    --uid="$M5B_MATRIX_USER" --gid="$M5B_MATRIX_GROUP" \
    --property=MemoryMax=512M --property=MemorySwapMax=0 \
    --setenv=LOCAL_PROVIDER_PORT="$M5B_MATRIX_PROVIDER_PORT" \
    --setenv=LOCAL_PROVIDER_LOG="$PROVIDER_LOG" \
    ${M5B_MATRIX_PROVIDER_DUMP:+--setenv=LOCAL_PROVIDER_DUMP="$RUN/provider-prompts.jsonl"} \
    --setenv=LOCAL_PROVIDER_WORKER_REPORT="${M5B_MATRIX_WORKER_REPORT:-}" \
    --setenv=LOCAL_PROVIDER_WORKER_REPORT_FILE="$RUN/worker-report.json" \
    --setenv=LOCAL_PROVIDER_WORKER_SLEEP_FILE="$RUN/worker-sleep.txt" \
    --setenv=LOCAL_PROVIDER_WORKER_DELAY_FILE="$RUN/worker-delay.txt" \
    --working-directory="$M5B_MATRIX_ROOT" \
    /usr/bin/node scripts/m5b/local-provider.mjs >/dev/null \
    || fail "could not start the local test provider"
  m5b_wait_http "http://127.0.0.1:${M5B_MATRIX_PROVIDER_PORT}/v1/models" 20000 "local provider" \
    || fail "local provider did not answer"
}

write_instances_config() {
  cat >"$INSTANCES_JSON" <<JSON
{
  "instances": [
    { "repository": "$M5B_MATRIX_REPOSITORY", "profile": "$M5B_MATRIX_PROFILE", "dshPort": 3404, "bridgePort": 3403 }
  ],
  "portRange": { "start": 3411, "end": 3499 }
}
JSON
  # The supervisor reads this file as the matrix identity.
  chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$INSTANCES_JSON"
  chmod 0640 "$INSTANCES_JSON"
}

stage_dsh_home() {
  note "staging the runtime profile into a matrix-owned harness home"
  local dst="$M5B_MATRIX_DSH_HOME/profiles/$M5B_MATRIX_PROFILE"
  mkdir -p "$dst/node_modules" "$M5B_MATRIX_DSH_HOME/state" "$M5B_MATRIX_DSH_HOME/sessions"
  for file in package.json cordis.patch.yml cordis.yml; do
    [[ -f $M5B_MATRIX_PROFILE_SOURCE/$file ]] && cp "$M5B_MATRIX_PROFILE_SOURCE/$file" "$dst/$file"
  done
  ln -sfn "$M5B_MATRIX_UPSTREAM_BUILD" "$dst/node_modules/dsh-superagent"
  # The staged profile must point its state at this harness home; the supervisor
  # verifies that exact path before it reports the instance online.
  sed -i "s#^    stateDir: .*#    stateDir: $M5B_MATRIX_DSH_HOME/state/$M5B_MATRIX_PROFILE#" \
    "$dst/cordis.patch.yml"
  grep -n "stateDir:" "$dst/cordis.patch.yml"
  # The isolated matrix runs on the loopback provider only. This fixture is
  # applied to the staged copy, so the shared m5b profile stays untouched:
  #  - `local-test` gains reasoning efforts (the supervisor always asks the eval
  #    model for reasoningEffort "low");
  #  - the orchestrator's default model is the loopback model, so a candidate is
  #    decided by the deterministic provider instead of an external one;
  #  - the external provider is removed, so no request can leave the host.
  m5b_run python3 - "$dst/cordis.patch.yml" <<'PYEOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = text.replace(
    """          - id: local-test
            name: Local Test
            contextWindow: 32768
            maxTokens: 4096""",
    """          - id: local-test
            name: Local Test
            contextWindow: 32768
            maxTokens: 4096
            reasoningEfforts:
              off: null
              low: low
              high: high""",
)
text = text.replace(
    """- id: agent-default-model
  config:
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash""",
    """- id: agent-default-model
  config:
    provider: local-test
    model: local-test""",
)
text = re.sub(r"      commandcode:\n(?:        .*\n)+", "", text)
open(path, "w").write(text)
PYEOF
  # The runtime resolves `LOCAL_TEST_API_KEY` from its own credential store, so the
  # fixture key lives in the staged harness home, never in the shared one.
  m5b_run sh -c "printf 'version: 1\nrefs:\n  LOCAL_TEST_API_KEY: local-test-dummy\n' > '$M5B_MATRIX_DSH_HOME/.credentials.yaml'"
  chmod 0600 "$M5B_MATRIX_DSH_HOME/.credentials.yaml"
  chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$M5B_MATRIX_DSH_HOME/.credentials.yaml"
  grep -n "provider: local-test\|reasoningEfforts\|commandcode" "$dst/cordis.patch.yml" | head -6
  chown -R "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$M5B_MATRIX_DSH_HOME"
  chmod 0700 "$M5B_MATRIX_DSH_HOME"
  echo "dsh_home=$M5B_MATRIX_DSH_HOME owner=$(stat -c %U:%G "$M5B_MATRIX_DSH_HOME")"
  echo "profile=$dst -> $(readlink "$dst/node_modules/dsh-superagent")"
}

start_supervisor() {
  note "starting the host supervisor inside the slice"
  [[ -f $SUP_TOKEN_FILE ]] || head -c 32 /dev/urandom | base64 | tr -d '=+/' >"$SUP_TOKEN_FILE"
  chmod 600 "$SUP_TOKEN_FILE"
  mkdir -p "$M5B_MATRIX_CREDENTIALS" "$M5B_MATRIX_INSTANCE_ENV" \
    "$M5B_MATRIX_INSTANCE_LOGS" "$M5B_MATRIX_WORKTREES"
  chown -R "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$M5B_MATRIX_CREDENTIALS" \
    "$M5B_MATRIX_INSTANCE_ENV" "$M5B_MATRIX_INSTANCE_LOGS" "$M5B_MATRIX_WORKTREES"
  local sup_token
  sup_token=$(tr -d '\n' <"$SUP_TOKEN_FILE")
  m5b_run systemd-run --unit="${SUP_UNIT%.service}" --slice="$SLICE" \
    --uid="$M5B_MATRIX_USER" --gid="$M5B_MATRIX_GROUP" \
    --property=Delegate=yes --property=DelegateSubgroup=payload \
    --property=MemoryMax=512M --property=MemorySwapMax=0 \
    --setenv=MOYU_CGROUP_ROOT="$M5B_MATRIX_SUPERVISOR_CGROUP/instances" \
    --setenv=NODE_ENV=production \
    --setenv=LOG_LEVEL=info \
    --setenv=SUPERVISOR_HOST=127.0.0.1 \
    --setenv=SUPERVISOR_PORT="$M5B_MATRIX_SUP_PORT" \
    --setenv=SUPERVISOR_TOKEN="$sup_token" \
    --setenv=DATABASE_URL="$M5B_MATRIX_PG_URL" \
    --setenv=INSTANCES_CONFIG="$INSTANCES_JSON" \
    --setenv=DSH_HOME="$M5B_MATRIX_DSH_HOME" \
    --setenv=PLATFORM_URL="http://127.0.0.1:${M5B_MATRIX_API_PORT}" \
    --setenv=RUNTIME_CREDENTIALS_DIR="$M5B_MATRIX_CREDENTIALS" \
    --setenv=INSTANCE_ENV_DIR="$M5B_MATRIX_INSTANCE_ENV" \
    --setenv=INSTANCE_LOG_DIR="$M5B_MATRIX_INSTANCE_LOGS" \
    --setenv=WORKTREE_ROOT="$M5B_MATRIX_WORKTREES" \
    --setenv=AGGREGATE_CGROUP="$M5B_MATRIX_SLICE_PATH" \
    --setenv=PLATFORM_CGROUP="$M5B_MATRIX_SLICE_PATH/${SLICE%.slice}-api.service" \
    --setenv=POSTGRES_CGROUP="$M5B_MATRIX_SLICE_PATH/${SLICE%.slice}-pg.service" \
    --setenv=MAX_START_ATTEMPTS=3 \
    --setenv=TICK_INTERVAL_MS=1000 \
    --setenv=RESOURCE_SAMPLE_INTERVAL_MS=5000 \
    --setenv=MEMORY_TARGET_MB=4096 \
    --setenv=MEMORY_BUDGET_MB=6144 \
    --setenv=MEMORY_HARD_LIMIT_MB="${M5B_MATRIX_BUDGET_MB}" \
    --setenv=INSTANCE_MEMORY_MAX_MB=3072 \
    --setenv=INSTANCE_MEMORY_HIGH_MB=2560 \
    --setenv=GITHUB_CLI=/root/.local/bin/gh-agent \
    --setenv=EXECUTOR_MODEL=local-test/local-test \
    --working-directory="$M5B_MATRIX_ROOT" \
    /usr/bin/node apps/supervisor/dist/main.js >/dev/null \
    || fail "could not start the supervisor"
  local health=''
  for _ in $(seq 1 60); do
    health=$(curl -sS -m 2 -H "authorization: Bearer $(tr -d '\n' <"$SUP_TOKEN_FILE")" \
      "http://127.0.0.1:${M5B_MATRIX_SUP_PORT}/control/v1/health" 2>/dev/null || true)
    [[ $health == *'"status":"ok"'* ]] && break
    sleep 0.5
  done
  [[ $health == *'"status":"ok"'* ]] || fail "supervisor did not answer: ${health}"
  # A process may only be moved inside its own delegated subtree, so the managed
  # root lives under the supervisor's unit cgroup. systemd delegates that cgroup
  # to the unit user (Delegate=yes); create the root and enable the controllers
  # as that user, then prove the delegation with a real write.
  # DelegateSubgroup keeps the service's own processes in `<unit>/payload`, so the
  # unit cgroup stays process-free and the identity can enable the memory
  # controller in its own subtree (the kernel forbids doing that while a cgroup
  # holds processes).
  m5b_run runuser -u "$M5B_MATRIX_USER" -- /bin/sh -c \
    "echo '+memory +pids' > '$M5B_MATRIX_SUPERVISOR_CGROUP/cgroup.subtree_control' && \
     mkdir -p '$M5B_MATRIX_SUPERVISOR_CGROUP/instances' && \
     echo '+memory +pids' > '$M5B_MATRIX_SUPERVISOR_CGROUP/instances/cgroup.subtree_control'" \
    || fail "the matrix identity cannot manage its delegated cgroup subtree"
  echo "supervisor_cgroup=$M5B_MATRIX_SUPERVISOR_CGROUP owner=$(stat -c %U:%G "$M5B_MATRIX_SUPERVISOR_CGROUP")"
  echo "managed_cgroup_root=$M5B_MATRIX_SUPERVISOR_CGROUP/instances controllers=$(cat "$M5B_MATRIX_SUPERVISOR_CGROUP/instances/cgroup.subtree_control")"
}

supervisor_call() {
  local method=$1 path=$2
  curl -sS -X "$method" \
    -H "authorization: Bearer $(tr -d '\n' <"$SUP_TOKEN_FILE")" \
    -H 'content-type: application/json' \
    -d "${3:-{\}}" \
    "http://127.0.0.1:${M5B_MATRIX_SUP_PORT}${path}"
}

archive_runtime_state() {
  local state_dir="$M5B_MATRIX_DSH_HOME/state/$M5B_MATRIX_PROFILE"
  if [[ -d $state_dir && -n $(ls -A "$state_dir" 2>/dev/null) ]]; then
    local archive="$state_dir.pre-matrix-$(date +%Y%m%dT%H%M%S)"
    note "archiving the previous runtime state to $archive"
    mv "$state_dir" "$archive"
  fi
  mkdir -p "$state_dir"
  chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$state_dir"
  chmod 700 "$state_dir"
  # Session transcripts live beside the state dir, keyed by that directory. They
  # carry the orchestrator session's persisted model selection, so a stale one
  # would keep calling a provider this isolated profile no longer registers.
  local sessions="$M5B_MATRIX_DSH_HOME/sessions/--$(printf '%s' "$state_dir" | sed 's#^/##; s#/#-#g')--"
  mkdir -p "$M5B_MATRIX_DSH_HOME/sessions"
  chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$M5B_MATRIX_DSH_HOME/sessions"
  if [[ -d $sessions && -n $(ls -A "$sessions" 2>/dev/null) ]]; then
    # Keep the archive outside the sessions root: the JSONL store walks that
    # directory and rejects a session whose stored cwd no longer matches its path.
    local archive="$M5B_MATRIX_DSH_HOME/session-archive/$(basename "$sessions")-$(date +%Y%m%dT%H%M%S)"
    mkdir -p "$(dirname "$archive")"
    note "archiving the previous runtime sessions to $archive"
    mv "$sessions" "$archive"
  fi
}

start_runtime() {
  note "preparing and waking the runtime instance through the supervisor"
  local repo_id
  repo_id=$(sed -n 's/^export M5B_REPOSITORY_ID=//p' "$RUN/seed.env")
  m5b_run supervisor_call POST "/control/v1/instances/${repo_id}/prepare" '{}'
  echo
  m5b_run supervisor_call POST "/control/v1/instances/${repo_id}/wake" '{"priority":20,"reason":"manual"}'
  echo
  # Configuring the profile restarts dsh-superagent once, so a single successful
  # probe can be a reset window. Require three consecutive answers instead.
  local streak=0 health=''
  for _ in $(seq 1 240); do
    health=$(curl -fsS -m 2 "http://127.0.0.1:3403/healthz" 2>/dev/null || true)
    if [[ $health == *'"ok":true'* ]]; then
      streak=$(( streak + 1 ))
      (( streak >= 3 )) && break
    else
      streak=0
    fi
    sleep 0.5
  done
  (( streak >= 3 )) || fail "runtime bridge did not become healthy"
  # The supervisor finishes configuring the profile after the bridge answers;
  # wait for its own online projection before the stack is reported ready.
  local instance=''
  for _ in $(seq 1 240); do
    instance=$(supervisor_call GET "/control/v1/instances/${repo_id}")
    [[ $instance == *'"state":"online"'* && $instance == *'"reasonCode":"listening"'* ]] && break
    sleep 0.5
  done
  [[ $instance == *'"state":"online"'* && $instance == *'"reasonCode":"listening"'* ]] \
    || fail "runtime instance did not reach online/listening: ${instance}"
  echo "bridge healthz: ${health}"
  echo "instance row:"
  m5b_sql "select state, desired_state, pid, port, bridge_port, profile, reason_code from repository_instances where repository_id='$repo_id'"
}

start_dispatcher() {
  note "starting the dispatcher from the baseline artifact"
  m5b_run sha256sum apps/dispatcher/dist/main.js
  m5b_run systemd-run --unit="${DISP_UNIT%.service}" --slice="$SLICE" \
    --uid="$M5B_MATRIX_USER" --gid="$M5B_MATRIX_GROUP" \
    --property=MemoryMax=512M --property=MemorySwapMax=0 \
    --setenv=NODE_ENV=test \
    --setenv=LOG_LEVEL=info \
    --setenv=DATABASE_URL="$M5B_MATRIX_PG_URL" \
    --setenv=RUNTIME_CREDENTIALS_DIR="$M5B_MATRIX_CREDENTIALS" \
    --setenv=RECONCILE_ON_START=true \
    --working-directory="$M5B_MATRIX_ROOT" \
    /usr/bin/node apps/dispatcher/dist/main.js >/dev/null \
    || fail "could not start the dispatcher"
  sleep 2
  systemctl is-active "$DISP_UNIT" >/dev/null || fail "dispatcher is not running"
}

start_api() {
  note "starting the platform API from the baseline artifact"
  m5b_run systemd-run --unit="${API_UNIT%.service}" --slice="$SLICE" \
    --uid="$M5B_MATRIX_USER" --gid="$M5B_MATRIX_GROUP" \
    --property=MemoryMax=1G --property=MemorySwapMax=0 \
    --setenv=NODE_ENV=production \
    --setenv=LOG_LEVEL=info \
    --setenv=API_HOST=127.0.0.1 \
    --setenv=API_PORT="$M5B_MATRIX_API_PORT" \
    --setenv=DATABASE_URL="$M5B_MATRIX_PG_URL" \
    --setenv=WEBAUTHN_RP_ID=127.0.0.1 \
    --setenv=WEBAUTHN_RP_NAME=MoYu \
    --setenv=WEBAUTHN_ORIGIN="http://127.0.0.1:${M5B_MATRIX_API_PORT}" \
    --setenv=AUTH_COOKIE_SECURE=false \
    --setenv=WEB_DIST_DIR="$M5B_MATRIX_ROOT/apps/web/dist" \
    --setenv=SUPERVISOR_URL="http://127.0.0.1:${M5B_MATRIX_SUP_PORT}" \
    --setenv=SUPERVISOR_TOKEN="$(tr -d '\n' <"$SUP_TOKEN_FILE")" \
    --setenv=RUNTIME_CREDENTIALS_DIR="$M5B_MATRIX_CREDENTIALS" \
    --setenv=GITHUB_CLI=/root/.local/bin/gh-agent \
    --working-directory="$M5B_MATRIX_ROOT" \
    /usr/bin/node apps/api/dist/server.js >/dev/null \
    || fail "could not start the API"
  m5b_wait_http "http://127.0.0.1:${M5B_MATRIX_API_PORT}/healthz" 30000 "API" || fail "API did not answer"
}

write_state() {
  local repo_id bridge_token bridge_url
  repo_id=$(sed -n 's/^export M5B_REPOSITORY_ID=//p' "$RUN/seed.env")
  bridge_token=$(python3 -c "import json,sys;print(json.load(open('$M5B_MATRIX_CREDENTIALS/$repo_id.json'))['bridgeToken'])")
  bridge_url=$(python3 -c "import json,sys;print(json.load(open('$M5B_MATRIX_CREDENTIALS/$repo_id.json'))['bridgeUrl'])")
  {
    cat "$RUN/seed.env"
    printf 'export M5B_BRIDGE_URL=%s\nexport M5B_BRIDGE_TOKEN=%s\n' "$bridge_url" "$bridge_token"
    printf 'export M5B_RUNTIME_PID=%s\n' "$(m5b_unit_pid "$SUP_UNIT")"
    printf 'export M5B_SLICE=%s\n' "$SLICE"
  } >"$M5B_MATRIX_STATE"
  chmod 600 "$M5B_MATRIX_STATE"
  note "stack state written to $M5B_MATRIX_STATE (not committed)"
}

status() {
  m5b_slice_facts
  echo "units:"
  for unit in "${ALL_UNITS[@]}"; do
    printf '  %-40s %s pid=%s cgroup=%s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null)" \
      "$(m5b_unit_pid "$unit")" "$(m5b_unit_cgroup "$unit")"
  done
  [[ -f $M5B_MATRIX_STATE ]] && { echo "state file:"; sed 's/TOKEN=.*/TOKEN=***/' "$M5B_MATRIX_STATE"; }
}

case ${1:-} in
  up)
    down
    start_slice
    start_postgres
    migrate_and_seed
    start_provider
    write_instances_config
    stage_dsh_home
    archive_runtime_state
    start_supervisor
    start_api
    start_runtime
    start_dispatcher
    write_state
    note "stack is up"
    status
    ;;
  down)
    down
    ;;
  status)
    status
    ;;
  *)
    echo "usage: $0 {up|down|status}" >&2
    exit 2
    ;;
esac
