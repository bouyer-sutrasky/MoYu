#!/usr/bin/env bash
# Red-to-green test for scripts/m6a/evidence.sh: the harness may only clean up
# processes it started. It sources the harness for its cleanup functions, starts
# two decoys the harness did not start (same command line, same kind of port),
# starts two of its own through the harness, then runs the same cleanup the EXIT
# trap runs. Exit 0 only when the decoys survive and the harness's own processes
# are gone.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
NODE_BIN=${M6A_NODE_BIN:-/opt/moyu-node24/bin}
PATH="$NODE_BIN:$PATH"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/m6a-ownership.XXXXXX")

decoy_dispatcher=''
decoy_listener=''
own_dispatcher=''
own_listener=''

cleanup_test() {
  local pid
  for pid in "$decoy_dispatcher" "$decoy_listener" "$own_dispatcher" "$own_listener"; do
    [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup_test EXIT

export M6A_RUN_DIR="$TMP/run"
export M6A_NODE_BIN="$NODE_BIN"
# shellcheck disable=SC1090
source "$HERE/evidence.sh"

mkdir -p "$TMP/decoy/dispatcher/dist" "$TMP/own/dispatcher/dist" "$TMP/logs"
printf 'setInterval(() => {}, 1000);\n' > "$TMP/decoy/dispatcher/dist/main.js"
printf 'setInterval(() => {}, 1000);\n' > "$TMP/own/dispatcher/dist/main.js"
listener_js='const http=require("http");http.createServer((q,s)=>s.end("ok")).listen(process.argv[1],"127.0.0.1")'

# A live process counts as stopped when it is gone or only a zombie.
process_state() {
  local pid=$1
  [[ -n "$pid" && -d "/proc/$pid" ]] || { printf 'gone'; return 0; }
  sed -n 's/^[^)]*) \([A-Z]\).*/\1/p' "/proc/$pid/stat" 2>/dev/null || printf '?'
}
alive() {
  local state
  state=$(process_state "$1")
  [[ "$state" != 'gone' && "$state" != 'Z' ]]
}
stopped() { ! alive "$1"; }
pass_fail() {
  local name=$1
  shift
  if "$@"; then printf 'PASS %s\n' "$name"; else printf 'FAIL %s\n' "$name"; FAILED=1; fi
}
port_free() { ! ss -ltn 2>/dev/null | grep -qE ":$1[[:space:]]"; }
wait_listen() {
  local port=$1
  for _ in $(seq 1 100); do port_free "$port" || return 0; sleep 0.05; done
  return 1
}

FAILED=0

# The ports the harness's old EXIT trap sweeps.
port_free 4620 || { echo 'FAIL port 4620 is already in use; cannot build the port decoy'; exit 1; }
port_free 4621 || { echo 'FAIL port 4621 is already in use; cannot build the own listener'; exit 1; }

echo '## 1. decoys this run did not start'
ss -ltn | grep -E ':(4620|4621)[[:space:]]' && { echo 'FAIL port decoy port already bound'; exit 1; }
node "$TMP/decoy/dispatcher/dist/main.js" --name m6a-decoy > "$TMP/logs/decoy-dispatcher.log" 2>&1 &
decoy_dispatcher=$!
node -e "$listener_js" 4620 > "$TMP/logs/decoy-listener.log" 2>&1 &
decoy_listener=$!
wait_listen 4620 || { echo 'FAIL decoy listener did not bind 4620'; exit 1; }
echo "decoy dispatcher pid=$decoy_dispatcher state=$(process_state "$decoy_dispatcher")"
echo "decoy listener   pid=$decoy_listener state=$(process_state "$decoy_listener")"
echo "decoy dispatcher carries the run marker: $(tr '\0' '\n' < "/proc/$decoy_dispatcher/environ" | grep -c "^$MARKER$" || true)"
echo

echo '## 2. processes this run started through the harness'
own_dispatcher=$(start_owned dispatcher "$TMP" node "$TMP/own/dispatcher/dist/main.js" --name own)
own_listener=$(start_owned stub "$TMP" node -e "$listener_js" 4621)
wait_listen 4621 || { echo 'FAIL own listener did not bind 4621'; exit 1; }
echo "own dispatcher pid=$own_dispatcher state=$(process_state "$own_dispatcher") marker=$(tr '\0' '\n' < "/proc/$own_dispatcher/environ" | grep -c "^$MARKER$" || true)"
echo "own listener   pid=$own_listener state=$(process_state "$own_listener") marker=$(tr '\0' '\n' < "/proc/$own_listener/environ" | grep -c "^$MARKER$" || true)"
echo

echo '## 3. before: raw ps'
ps -o pid,stat,args -p "$decoy_dispatcher,$decoy_listener,$own_dispatcher,$own_listener" || true
echo

echo '## 4. the harness stops its dispatcher, then its EXIT cleanup runs'
stop_dispatcher
sleep 0.3
cleanup_run_processes
sleep 0.5

echo '## 5. after: raw ps'
ps -o pid,stat,args -p "$decoy_dispatcher,$decoy_listener,$own_dispatcher,$own_listener" || true
echo

echo '## 6. verdict'
pass_fail 'decoy dispatcher survives (this run did not start it)' alive "$decoy_dispatcher"
pass_fail "own dispatcher is stopped (run .pid was $own_dispatcher)" stopped "$own_dispatcher"
pass_fail 'decoy listener survives (this run did not start it)' alive "$decoy_listener"
pass_fail "own listener is stopped (run .pid was $own_listener)" stopped "$own_listener"
echo "exit=$FAILED"
exit "$FAILED"
