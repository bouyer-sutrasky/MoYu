#!/usr/bin/env bash
# One synthetic memory member for the M5-B matrix stress runs.
#
# Two hard rules the host incident of 2026-11-07 forced, both enforced here as
# assertions rather than comments:
#
#   1. a synthetic member must prove it is inside the slice BEFORE it allocates a
#      single byte — the allocator reads its own /proc/self/cgroup and exits
#      without touching memory when the path is not under the slice;
#   2. the total synthetic pressure may not exceed the slice's memory.max, and
#      members start one at a time, each one confirmed in place before the next.
#
#   scripts/m5b/matrix/stress-member.sh <MiB> [unit-suffix]
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

SLICE_PATH=$M5B_MATRIX_SLICE_PATH
SLICE_NAME=${M5B_MATRIX_SLICE}
MB=${1:?usage: stress-member.sh <MiB> [unit-suffix]}
SUFFIX=${2:-fill}
UNIT="m5bmatrix-stress-${SUFFIX}"

if ! [[ $MB =~ ^[0-9]+$ ]] || (( MB <= 0 )); then
  echo "REFUSED: <MiB> must be a positive integer, got '${MB}'"
  exit 2
fi

MAX=$(cat "$SLICE_PATH/memory.max" 2>/dev/null || echo missing)
[[ $MAX =~ ^[0-9]+$ ]] || {
  echo "REFUSED: the slice has no numeric memory.max (${MAX})"
  exit 2
}
CURRENT=$(cat "$SLICE_PATH/memory.current" 2>/dev/null || echo 0)
WANT=$((MB * 1024 * 1024))
HEADROOM=$((MAX - CURRENT))
echo "slice=${SLICE_NAME} memory.max=${MAX} memory.current=${CURRENT} requested=${WANT} headroom=${HEADROOM}"

# Rule 2a: never ask for more than the slice may hold at all.
if (( WANT > MAX )); then
  echo "REFUSED: ${WANT} B exceeds the slice memory.max ${MAX} B; synthetic pressure may not exceed the ceiling"
  exit 3
fi
# Rule 2b: never ask for more than is actually left, so the slice is not driven
# into an OOM kill of a real service by a synthetic member.
if (( WANT > HEADROOM )); then
  echo "REFUSED: ${WANT} B exceeds the current headroom ${HEADROOM} B; start a smaller member"
  exit 3
fi

# The allocator: verify placement first, allocate only when the check passes.
read -r -d '' ALLOCATOR <<'PY'
import os, sys, time

mb = int(sys.argv[1])
slice_name = sys.argv[2]
path = None
with open('/proc/self/cgroup') as handle:
    for line in handle:
        if line.startswith('0::'):
            path = line.strip().split('::', 1)[1]
# Rule 1: nothing is allocated until this process proves where it lives.
if not path or not path.startswith('/' + slice_name + '/'):
    print(f'REFUSED: this process is in cgroup {path!r}, not inside /{slice_name}/; no memory allocated', flush=True)
    sys.exit(4)
print(f'placed_in={path}', flush=True)
chunks = []
step = 32 * 1024 * 1024
held = 0
while held < mb * 1024 * 1024:
    chunks.append(bytearray(step))
    held += step
    time.sleep(0.05)
print(f'holding={held}', flush=True)
time.sleep(300)
PY

echo "\$ systemd-run --slice=${SLICE_NAME} --unit=${UNIT} … (one member, confirmed before the next)"
systemd-run --slice="$SLICE_NAME" --unit="$UNIT" --collect -p MemoryAccounting=yes \
  --description="M5-B matrix synthetic member (not a service)" \
  /usr/bin/python3 -c "$ALLOCATOR" "$MB" "$SLICE_NAME"
if (( $? != 0 )); then
  echo "REFUSED: systemd-run did not start the member"
  exit 5
fi

# Rule 2c: confirm the unit is really inside the slice before anything else runs.
PLACED=""
for _ in $(seq 1 20); do
  CG=$(systemctl show -p ControlGroup --value "$UNIT.service" 2>/dev/null)
  if [[ -n $CG ]]; then
    PLACED=$CG
    break
  fi
  sleep 0.25
done
echo "unit=${UNIT}.service ControlGroup=${PLACED:-<empty>}"
case "$PLACED" in
  /${SLICE_NAME}/*) echo "PLACED: the member is inside ${SLICE_NAME}" ;;
  *)
    echo "REFUSED: the member is NOT inside ${SLICE_NAME} (ControlGroup=${PLACED:-<empty>}); stopping it now"
    systemctl stop "$UNIT.service" 2>/dev/null
    exit 6
    ;;
esac

for _ in $(seq 1 40); do
  STATE=$(systemctl show -p ActiveState --value "$UNIT.service" 2>/dev/null)
  [[ $STATE == active ]] && break
  [[ $STATE == failed ]] && { echo "REFUSED: the member failed before allocating"; exit 7; }
  sleep 0.25
done
echo "member_state=$(systemctl show -p ActiveState --value "$UNIT.service") cgroup_current=$(cat "/sys/fs/cgroup${PLACED}/memory.current" 2>/dev/null || echo -)"
echo "OK: ${MB} MiB synthetic member running inside ${SLICE_NAME} as ${UNIT}.service"
