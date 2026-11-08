#!/usr/bin/env bash
# M5-B matrix item 3 — the 4 / 6 / 8 GiB budgets, the 6 GiB high watermark, and
# what the slice does when it really reaches memory.max.
#
# Each tier is measured the same way: set the slice's MemoryMax and MemoryHigh,
# start ONE synthetic member that fills the remaining headroom (stress-member.sh
# refuses to start otherwise), then sample current/events and the host's
# MemAvailable until the member is killed or the window ends.
#
# Safety, from the host-OOM incident:
#   - the member proves its own cgroup before it allocates a byte, and the driver
#     confirms systemctl's ControlGroup starts with /m5bmatrix.slice;
#   - one member at a time, never more than the tier's memory.max;
#   - both driver and member stop when host MemAvailable falls below 4 GiB.
#
#   scripts/m5b/matrix/item3-budget.sh
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

SLICE_PATH=$M5B_MATRIX_SLICE_PATH
SLICE=$M5B_MATRIX_SLICE
FLOOR_MB=${M5B_MATRIX_HOST_FLOOR_MB:-4096}
WINDOW=${M5B_MATRIX_TIER_WINDOW:-150}
export M5B_MATRIX_HOST_FLOOR_MB=$FLOOR_MB

available_mb() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
ev() { awk -v k="$1" '$1 == k {print $2}' "$SLICE_PATH/memory.events" 2>/dev/null; }

run_tier() {
  local tier_max_gib=$1 tier_high_gib=$2
  local max_bytes=$((tier_max_gib * 1024 * 1024 * 1024))
  local high_bytes
  if [[ $tier_high_gib == max ]]; then high_bytes=$max_bytes; else high_bytes=$((tier_high_gib * 1024 * 1024 * 1024)); fi
  echo "=============================================================="
  echo "## tier: MemoryMax=${tier_max_gib}GiB MemoryHigh=${tier_high_gib}GiB"
  echo "\$ systemctl set-property ${SLICE} MemoryMax=${max_bytes} MemoryHigh=${high_bytes} MemorySwapMax=0"
  systemctl set-property "$SLICE" "MemoryMax=${max_bytes}" "MemoryHigh=${high_bytes}" "MemorySwapMax=0"
  sleep 2
  echo "applied: max=$(cat "$SLICE_PATH/memory.max") high=$(cat "$SLICE_PATH/memory.high") swap.max=$(cat "$SLICE_PATH/memory.swap.max")"

  local base_current base_high base_max base_oom
  base_current=$(cat "$SLICE_PATH/memory.current")
  base_high=$(ev high); base_max=$(ev max); base_oom=$(ev oom_kill)
  echo "baseline: current=${base_current} high=${base_high} max=${base_max} oom_kill=${base_oom} host_available=$(available_mb)MiB"

  local headroom=$((max_bytes - base_current - 96 * 1024 * 1024))
  (( headroom < 0 )) && headroom=0
  local want_mb=$((headroom / 1024 / 1024))
  echo "\$ scripts/m5b/matrix/stress-member.sh ${want_mb} tier${tier_max_gib}   # one member, fills the headroom"
  bash "$HERE/stress-member.sh" "$want_mb" "tier${tier_max_gib}" 2>&1 | tail -4

  local peak=0 killed=no i cur avail
  for i in $(seq 1 $WINDOW); do
    cur=$(cat "$SLICE_PATH/memory.current")
    (( cur > peak )) && peak=$cur
    avail=$(available_mb)
    if (( i % 15 == 1 )); then
      printf 't=%-4s current=%-12s high_d=%-7s max_d=%-5s oom_d=%-3s host_available=%sMiB member=%s\n' \
        "$i" "$cur" "$(( $(ev high) - base_high ))" "$(( $(ev max) - base_max ))" \
        "$(( $(ev oom_kill) - base_oom ))" "$avail" \
        "$(systemctl is-active "m5bmatrix-stress-tier${tier_max_gib}.service" 2>/dev/null || echo gone)"
    fi
    if (( avail < FLOOR_MB )); then
      echo "ABORT: host MemAvailable ${avail} MiB < ${FLOOR_MB} MiB floor at t=${i}; stopping the member"
      killed=aborted
      break
    fi
    systemctl is-active "m5bmatrix-stress-tier${tier_max_gib}.service" >/dev/null 2>&1 || { killed=killed; break; }
    sleep 1
  done
  sleep 2
  local end_current end_peak
  end_current=$(cat "$SLICE_PATH/memory.current")
  end_peak=$(cat "$SLICE_PATH/memory.peak")
  echo "result: peak_window=${peak} slice_peak=${end_peak} current_after=${end_current}"
  echo "events_delta: high=$(( $(ev high) - base_high )) max=$(( $(ev max) - base_max )) oom_kill=$(( $(ev oom_kill) - base_oom ))"
  echo "member_state=$(systemctl is-active "m5bmatrix-stress-tier${tier_max_gib}.service" 2>/dev/null || echo gone) ended=${killed}"
  echo "host_available_after=$(available_mb)MiB"
  journalctl --since "-${WINDOW}s" --no-pager 2>/dev/null | grep -aiE "oom-kill|Killed process" | tail -3 | sed 's/^/  /'
  systemctl stop "m5bmatrix-stress-tier${tier_max_gib}.service" 2>/dev/null || true
  sleep 3
  echo
}

echo "# item 3 — 4 / 6 / 8 GiB budgets on ${SLICE}, and the ceiling itself"
echo "recorded=$(date -Is)"
echo "host_floor_mb=${FLOOR_MB}  window_seconds=${WINDOW}"
echo "host_mem_total_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)  host_available_now=$(available_mb)MiB"
echo

# 4 GiB with a 3 GiB high watermark, 6 GiB with 4.5 GiB, and the deployed
# 8 GiB / 6 GiB pair. High == max is never used, so every tier exercises the
# high watermark before the ceiling.
run_tier 4 3
run_tier 6 4
run_tier 8 6

echo "## restore the slice to the deployed pair"
systemctl set-property "$SLICE" MemoryMax=8589934592 MemoryHigh=6442450944 MemorySwapMax=0
sleep 1
echo "restored: max=$(cat "$SLICE_PATH/memory.max") high=$(cat "$SLICE_PATH/memory.high")"
