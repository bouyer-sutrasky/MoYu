#!/usr/bin/env bash
# M5-B matrix item 6b — aggregate pressure on the one slice that holds all four
# service categories: PostgreSQL, the platform API, the dispatcher, the runtime
# (supervisor + instances) and the test provider.
#
# The slice is m5bmatrix.slice: memory.max=8 GiB, memory.high=6 GiB, swap.max=0.
# The deployed admission caps are far below that (pg 1 GiB, api 1 GiB, dispatcher
# 512 MiB, supervisor 512 MiB, provider 512 MiB = 3.5 GiB together), so the log
# runs two phases and says which one produced each reading:
#
#   phase 1  every service under load but inside its own cap -> the aggregate the
#            real services can actually reach;
#   phase 2  a clearly labelled filler member inside the same slice drives the
#            aggregate to the 8 GiB ceiling -> what the slice does at high/max.
#
#   scripts/m5b/matrix/item6-stress.sh
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

RUN=$M5B_MATRIX_RUN
SLICE=$M5B_MATRIX_SLICE_PATH
PG_URL=$M5B_MATRIX_PG_URL
LIVE="node $M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs"
FILL_UNIT=m5bmatrix-stress-fill.service
MEM_FILE="$RUN/worker-mem.txt"
ALLOC_FILE="$RUN/provider-alloc.txt"
FILL_MB=${M5B_MATRIX_FILL_MB:-6500}

cg_line() {
  local path=$1 label=$2
  printf '%-30s current=%-11s peak=%-11s events=[%s]\n' \
    "$label" \
    "$(cat "$path/memory.current" 2>/dev/null || echo -)" \
    "$(cat "$path/memory.peak" 2>/dev/null || echo -)" \
    "$(tr '\n' ' ' <"$path/memory.events" 2>/dev/null || echo -)"
}

events_field() { awk -v key="$1" '$1 == key { print $2 }' "$SLICE/memory.events" 2>/dev/null; }
member() { cat "$(m5b_unit_cgroup "$1.service")/memory.current" 2>/dev/null || echo -; }
fill_current() { cat "/sys/fs/cgroup/${M5B_MATRIX_SLICE}/${FILL_UNIT}/memory.current" 2>/dev/null || echo 0; }

echo "# item 6b — aggregate pressure on the shared 8 GiB slice"
echo "recorded=$(date -Is)"
echo "dispatcher_artifact=$(sha256sum "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js" | cut -d' ' -f1) ($(stat -c %s "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js") bytes)"
m5b_slice_facts "$SLICE"
echo
echo "## the admission caps that sit under the slice budget (systemctl show -p MemoryMax)"
for unit in m5bmatrix-pg m5bmatrix-api m5bmatrix-dispatcher m5bmatrix-supervisor m5bmatrix-provider; do
  printf '%-26s MemoryMax=%-12s MemoryHigh=%s\n' "$unit" \
    "$(systemctl show -p MemoryMax --value "$unit.service" 2>/dev/null)" \
    "$(systemctl show -p MemoryHigh --value "$unit.service" 2>/dev/null)"
done
echo "sum_of_member_caps_bytes=$((
  $(systemctl show -p MemoryMax --value m5bmatrix-pg.service) +
  $(systemctl show -p MemoryMax --value m5bmatrix-api.service) +
  $(systemctl show -p MemoryMax --value m5bmatrix-dispatcher.service) +
  $(systemctl show -p MemoryMax --value m5bmatrix-supervisor.service) +
  $(systemctl show -p MemoryMax --value m5bmatrix-provider.service) ))"
echo

BASE_HIGH=$(events_field high)
BASE_MAX=$(events_field max)
BASE_OOM=$(events_field oom_kill)
echo "baseline_events: high=${BASE_HIGH} max=${BASE_MAX} oom_kill=${BASE_OOM} current=$(cat "$SLICE/memory.current")"
echo

echo "## phase 1 — every service loaded but inside its own admission cap"
echo "postgres: sort with work_mem=256MB over 10M rows (stays under 1 GiB)"
PGPASSWORD= psql "$PG_URL" -X -q -v ON_ERROR_STOP=1 -c "
  set work_mem='256MB';
  select count(*) from (select g from generate_series(1,10000000) g order by g desc) s;
" >"$RUN/stress-pg.out" 2>&1 &
PG_JOB=$!
echo "runtime: a worker turn holding 600 MiB inside the runtime's cgroup"
echo 600 >"$MEM_FILE"
chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$MEM_FILE" 2>/dev/null || true
chmod 0640 "$MEM_FILE"
CREATED=$($LIVE new-task --text "Matrix item 6b: hold worker memory under load." \
  --client-request-id "item6-stress-$(date +%s)")
TASK=$(printf '%s' "$CREATED" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
echo "task=${TASK}"
echo "provider: hold 300 MiB inside the provider process"
echo 300 >"$ALLOC_FILE"
chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$ALLOC_FILE" 2>/dev/null || true
chmod 0640 "$ALLOC_FILE"
curl -sS -m 120 -X POST "http://127.0.0.1:${M5B_MATRIX_PROVIDER_PORT}/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"local-test","messages":[{"role":"user","content":"allocate"}]}' >/dev/null 2>&1 &
echo "api: a steady stream of 64 KiB requests (memory inside the api cgroup)"
(
  for _ in $(seq 1 40); do
    python3 - "$M5B_MATRIX_API_PORT" <<'PY' >/dev/null 2>&1 &
import json, sys, urllib.request
body = json.dumps({"repositoryId": "00000000-0000-0000-0000-000000000000",
                   "padding": "x" * (64 * 1024)}).encode()
request = urllib.request.Request(f'http://127.0.0.1:{sys.argv[1]}/api/v1/conversations', data=body,
                                 method='POST', headers={'content-type': 'application/json',
                                                         'cookie': 'moyu_session=invalid'})
try:
    urllib.request.urlopen(request, timeout=30).read()
except Exception:
    pass
PY
  done
  wait
) &
API_JOB=$!
sleep 12

echo
echo "### timeline, phase 1 (1 s samples)"
printf '%-6s %-12s %-8s %-8s %-8s %-12s %-12s %-12s %-11s %-11s\n' \
  t_s slice_cur high_d max_d oom_d pg runtime dispatcher api provider
for second in $(seq 1 10); do
  printf '%-6s %-12s %-8s %-8s %-8s %-12s %-12s %-12s %-11s %-11s\n' \
    "$second" "$(cat "$SLICE/memory.current")" \
    "$(( $(events_field high) - BASE_HIGH ))" \
    "$(( $(events_field max) - BASE_MAX ))" \
    "$(( $(events_field oom_kill) - BASE_OOM ))" \
    "$(member m5bmatrix-pg)" "$(member m5bmatrix-supervisor)" \
    "$(member m5bmatrix-dispatcher)" "$(member m5bmatrix-api)" "$(member m5bmatrix-provider)"
  sleep 1
done
echo
echo "phase1_services_alive: pg=$(systemctl is-active m5bmatrix-pg.service) api=$(curl -fsS -m 2 http://127.0.0.1:${M5B_MATRIX_API_PORT}/healthz 2>/dev/null || echo down) dispatcher=$(systemctl is-active m5bmatrix-dispatcher.service) bridge=$(curl -fsS -m 2 http://127.0.0.1:3403/healthz 2>/dev/null || echo down) provider=$(systemctl is-active m5bmatrix-provider.service)"
echo "phase1_slice_current=$(cat "$SLICE/memory.current")"
echo "phase1_postgres_result=$(head -1 "$RUN/stress-pg.out" 2>/dev/null)"
echo

echo "## phase 2 — a labelled filler in the same slice drives the aggregate to the 8 GiB ceiling"
# The synthetic member goes through stress-member.sh, which refuses to allocate
# unless the process proves it is inside the slice and unless the request fits the
# slice's memory.max and its current headroom.
echo "\$ scripts/m5b/matrix/stress-member.sh ${FILL_MB} fill"
bash "$M5B_MATRIX_ROOT/scripts/m5b/matrix/stress-member.sh" "$FILL_MB" fill || echo "REFUSED: no synthetic member started"
BASE2_HIGH=$(events_field high)
BASE2_MAX=$(events_field max)
BASE2_OOM=$(events_field oom_kill)
printf '%-6s %-12s %-8s %-8s %-8s %-12s %-12s %-11s %-11s %-11s\n' \
  t_s slice_cur high_d max_d oom_d filler pg runtime api provider
for second in $(seq 1 40); do
  printf '%-6s %-12s %-8s %-8s %-8s %-12s %-12s %-11s %-11s %-11s\n' \
    "$second" "$(cat "$SLICE/memory.current")" \
    "$(( $(events_field high) - BASE2_HIGH ))" \
    "$(( $(events_field max) - BASE2_MAX ))" \
    "$(( $(events_field oom_kill) - BASE2_OOM ))" \
    "$(fill_current)" "$(member m5bmatrix-pg)" "$(member m5bmatrix-supervisor)" \
    "$(member m5bmatrix-api)" "$(member m5bmatrix-provider)"
  sleep 1
done
echo
echo "filler_unit_active=$(systemctl is-active "$FILL_UNIT" 2>/dev/null || echo gone)"
echo "after_phase2_services: pg=$(systemctl is-active m5bmatrix-pg.service) api=$(systemctl is-active m5bmatrix-api.service) dispatcher=$(systemctl is-active m5bmatrix-dispatcher.service) bridge=$(curl -fsS -m 2 http://127.0.0.1:3403/healthz 2>/dev/null || echo down) provider=$(systemctl is-active m5bmatrix-provider.service)"
echo

echo "## raw readings at the end"
cg_line "$SLICE" "m5bmatrix.slice (aggregate)"
for unit in m5bmatrix-pg m5bmatrix-api m5bmatrix-dispatcher m5bmatrix-supervisor m5bmatrix-provider; do
  cg=$(m5b_unit_cgroup "$unit.service")
  [[ -n $cg ]] && cg_line "$cg" "$unit"
done
if [[ -d "/sys/fs/cgroup/${M5B_MATRIX_SLICE}/${FILL_UNIT}" ]]; then
  cg_line "/sys/fs/cgroup/${M5B_MATRIX_SLICE}/${FILL_UNIT}" "filler (synthetic, label only)"
fi
echo

echo "## release the load"
kill "$PG_JOB" "$API_JOB" 2>/dev/null || true
echo 0 >"$MEM_FILE"
echo 0 >"$ALLOC_FILE"
systemctl stop "$FILL_UNIT" 2>/dev/null || true
wait "$PG_JOB" "$API_JOB" 2>/dev/null || true
sleep 3
echo "postgres_output=$(head -2 "$RUN/stress-pg.out" 2>/dev/null | tr '\n' ' ')"
echo

echo "## verdict"
PEAK=$(cat "$SLICE/memory.peak")
HIGH_D=$(( $(events_field high) - BASE_HIGH ))
MAX_D=$(( $(events_field max) - BASE_MAX ))
OOM_D=$(( $(events_field oom_kill) - BASE_OOM ))
echo "slice_peak_bytes=${PEAK} (~$(awk -v p="$PEAK" 'BEGIN{printf "%.2f GiB", p/1073741824}'))"
echo "events_delta_over_the_whole_run: high=${HIGH_D} max=${MAX_D} oom_kill=${OOM_D}"
echo "sum_of_member_caps_bytes=${CAPS_SUM:-see above} against slice memory.max=8589934592"
if (( OOM_D > 0 )); then
  echo "OBSERVED: an OOM kill inside the slice; which member died is named above (filler vs service)."
elif (( HIGH_D > 0 )); then
  echo "OBSERVED: scheduling only — the kernel throttled/reclaimed at memory.high, no process died."
else
  echo "OBSERVED: even with the filler the slice never throttled."
fi
