#!/usr/bin/env bash
# Isolated resource-boundary check for M5-B.
#
# Safety rules:
# - the host must have at least 8 GiB MemAvailable before anything starts;
# - the aggregate slice is capped at 8 GiB;
# - the hog runs as nobody in a 256 MiB scope with a 30 s runtime cap;
# - the hog itself refuses to allocate unless its own cgroup limit is <= 256 MiB;
# - every transient unit is stopped in the EXIT trap.
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "must run as root to create the isolated systemd slice" >&2
  exit 2
fi

OUT=${M5B_OOM_OUT:-docs/evidence/m5b/nonroot-oom.log}
ANCHOR=m5b-slice-anchor
HOG=m5b-oom-hog
SLICE=moyu-m5b.slice
HOG_SOURCE=$PWD/scripts/m5b/memory-hog.mjs
HOG_RUN=/tmp/m5b-memory-hog-$$.mjs

available_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
if (( available_kb < 8 * 1024 * 1024 )); then
  echo "refusing: MemAvailable ${available_kb} kB is below the 8 GiB safety floor" >&2
  exit 2
fi

cleanup() {
  systemctl stop "$HOG" 2>/dev/null || true
  systemctl reset-failed "$HOG" 2>/dev/null || true
  systemctl stop "$ANCHOR" 2>/dev/null || true
  systemctl stop "$SLICE" 2>/dev/null || true
  rm -rf /run/systemd/system.control/moyu-m5b.slice.d
  rm -f "$HOG_RUN"
  systemctl daemon-reload 2>/dev/null || true
}
trap cleanup EXIT

{
  echo "date=$(date -Is)"
  echo "host_mem_available_before_kb=$available_kb"
  echo "uid_before=$(id -u nobody)"
  systemd-run --unit="$ANCHOR" --slice="$SLICE" \
    --property=RuntimeMaxSec=300 --property=MemoryMax=64M \
    /bin/sleep 300 >/dev/null
  systemctl set-property --runtime "$SLICE" MemoryMax=8G MemoryHigh=6G
  slice_control_group=$(systemctl show -p ControlGroup --value "$SLICE")
  slice_path="/sys/fs/cgroup${slice_control_group}"
  echo "slice_control_group=$slice_control_group"
  echo "slice_memory_max=$(cat "$slice_path/memory.max")"
  echo "slice_memory_high=$(cat "$slice_path/memory.high")"
  echo "slice_memory_current=$(cat "$slice_path/memory.current")"
  # /root is not traversable by nobody; place the guarded fixture in /tmp.
  cp "$HOG_SOURCE" "$HOG_RUN"
  chmod 0644 "$HOG_RUN"
  set +e
  systemd-run --unit="$HOG" --slice="$SLICE" --uid=nobody \
    --property=MemoryMax=256M --property=MemoryHigh=256M --property=MemorySwapMax=0 \
    --property=RuntimeMaxSec=10 --property=TimeoutStopSec=10 \
    --wait --pipe /usr/bin/node "$HOG_RUN"
  hog_status=$?
  set -e
  echo "hog_exit_status=$hog_status"
  echo "hog_result=$(systemctl show -p Result --value "$HOG" 2>/dev/null || echo missing)"
  control_group=$(systemctl show -p ControlGroup --value "$HOG" 2>/dev/null || true)
  echo "hog_control_group=$control_group"
  if [[ -n "$control_group" && -d "/sys/fs/cgroup$control_group" ]]; then
    echo "hog_memory_max=$(cat "/sys/fs/cgroup$control_group/memory.max")"
    echo "hog_memory_events=$(tr '\n' ' ' < "/sys/fs/cgroup$control_group/memory.events")"
    echo "hog_memory_peak=$(cat "/sys/fs/cgroup$control_group/memory.peak")"
  fi
  echo "host_mem_available_after_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
} 2>&1 | tee "$OUT"
