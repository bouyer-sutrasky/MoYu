#!/usr/bin/env bash
# M5-B 委托单元里的冷启动与归属探针（Issue #41）。
#
# 用真实的 systemd 委托单元（User=nobody、Delegate=yes、DelegateSubgroup=payload）
# 跑 supervisor 的真实实现，证明**空白委托目录 + 非 root**也能建根、启用控制器、
# 绑定 runtime 与后代，并在停止后得到递归空树。单元名带 pid，结束时停止并 reset-failed，
# 只影响这一个临时单元。
#
# 用法：scripts/m5b/cgroup-unit-delegation-check.sh [日志文件]
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
LOG=${1:-/dev/stdout}
RUN_NODE=${RUN_NODE:-/usr/bin/node}
ESBUILD=${ESBUILD:-$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)}
UNIT=moyu-cgroup-probe-$$
BUNDLE_DIR=$(mktemp -d /tmp/moyu-cgroup-unit-XXXXXX)

cleanup() {
  systemctl stop "$UNIT.service" 2>/dev/null
  systemctl reset-failed "$UNIT.service" 2>/dev/null
  rm -rf "$BUNDLE_DIR"
}
trap cleanup EXIT

[[ -x $ESBUILD ]] || {
  echo "missing esbuild (run pnpm install first)" >&2
  exit 2
}
[[ -x $RUN_NODE ]] || {
  echo "missing $RUN_NODE" >&2
  exit 2
}
command -v systemd-run >/dev/null || {
  echo "systemd-run is required for the delegated-unit check" >&2
  exit 2
}

"$ESBUILD" "$HERE/cgroup-lifecycle-probe.ts" --bundle --platform=node --format=esm \
  --log-level=warning --outfile="$BUNDLE_DIR/probe.mjs"
chmod 0755 "$BUNDLE_DIR" "$BUNDLE_DIR/probe.mjs"

{
  echo "# M5-B 委托单元探针（非 root + 空白委托目录）"
  echo "recorded=$(date -Is)"
  echo "head=$(cd "$REPO" && git rev-parse HEAD)"
  echo "unit=$UNIT.service user=nobody group=nogroup"
  echo "delegation=Delegate=yes DelegateSubgroup=payload"
  echo
  echo "\$ systemd-run --unit=$UNIT -p User=nobody -p Group=nogroup -p Delegate=yes -p DelegateSubgroup=payload \\"
  echo "    -p Environment=MOYU_CGROUP_ROOT=/sys/fs/cgroup/system.slice/$UNIT.service/instances \\"
  echo "    $RUN_NODE probe.mjs"
  systemd-run --unit="$UNIT" \
    -p User=nobody -p Group=nogroup \
    -p Delegate=yes -p DelegateSubgroup=payload -p RuntimeMaxSec=120 \
    -p "Environment=MOYU_CGROUP_ROOT=/sys/fs/cgroup/system.slice/$UNIT.service/instances" \
    "$RUN_NODE" "$BUNDLE_DIR/probe.mjs" >/dev/null 2>&1
  # Capture the delegated cgroup while the unit is still running; it is removed
  # by systemd when the unit stops.
  unit_cgroup=/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$UNIT.service" 2>/dev/null)
  payload_root=""
  for _ in $(seq 1 60); do
    if systemctl is-active --quiet "$UNIT.service"; then
      payload_root=${unit_cgroup}
    fi
    [[ -n $payload_root ]] && break
    sleep 0.5
  done
  echo "unit_cgroup_while_active=${payload_root#/sys/fs/cgroup}"
  echo "unit_cgroup_own_procs=[$(tr '\n' ' ' <"$payload_root/cgroup.procs" 2>/dev/null)]"
  echo "unit_cgroup_subtree=[$(cat "$payload_root/cgroup.subtree_control" 2>/dev/null)]"
  for _ in $(seq 1 60); do
    systemctl is-active --quiet "$UNIT.service" || break
    sleep 1
  done
  journalctl -u "$UNIT.service" --no-pager -o cat 2>&1
  result=$(systemctl show -p Result --value "$UNIT.service" 2>/dev/null)
  systemctl stop "$UNIT.service" 2>/dev/null
  systemctl reset-failed "$UNIT.service" 2>/dev/null
  echo
  echo "unit_result=${result:-unknown}"
  echo "unit_cgroup_removed=$([[ -d $payload_root ]] && echo false || echo true)"
} 2>&1 | tee "$LOG"

# The unit result must be success and no verdict may have failed.
if grep -q "verdict .*=FAIL" "$LOG"; then
  echo "probe reported failing verdicts" >&2
  exit 1
fi
grep -q "unit_result=success" "$LOG" || {
  echo "the delegated unit did not finish successfully" >&2
  exit 1
}
exit 0
