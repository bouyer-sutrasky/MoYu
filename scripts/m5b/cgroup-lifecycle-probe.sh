#!/usr/bin/env bash
# M5-B cgroup 冷启动与重启归属现场探针（Issue #41）。
#
# 在一个**空白**的委托目录里跑 supervisor 的真实实现，检验：
#   1. 不预建根目录也能冷启动：建根、启用 memory/pids、绑定 runtime 与后代；
#   2. 停止后实例 cgroup 递归为空并被移除，再开一代仍可核对（PID / cgroup inode / 端口）；
#   3. 权限不足（非 root + 非委托目录）时明确失败，不会返回一个未计量的路径。
#
# 用法：scripts/m5b/cgroup-lifecycle-probe.sh [日志文件]
# 只在本机自有的 cgroup 子树里创建目录，结束时用 cgroup.kill 清空并 rmdir。
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
LOG=${1:-/dev/stdout}
NODE_BIN=${NODE_BIN:-/opt/moyu-node24/bin/node}
# Overridable so the same script also runs from another checkout (for example the
# baseline commit's worktree, to capture the before-fix result).
TSX=${TSX:-$REPO/apps/supervisor/node_modules/.bin/tsx}
ESBUILD=${ESBUILD:-$(ls -d "$REPO"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | sort -V | tail -1)}
RUN_NODE=${RUN_NODE:-/usr/bin/node}
BASE=/sys/fs/cgroup/moyu-cprobe-$$
NONROOT_BASE=${BASE}-nonroot
NONROOT_DELEGATED=${BASE}-delegated
BUNDLE_DIR=$(mktemp -d /tmp/moyu-cprobe-bundle-XXXXXX)

cleanup() {
  rm -rf "$BUNDLE_DIR"
  for dir in "$BASE" "$NONROOT_BASE" "$NONROOT_DELEGATED"; do
    [[ -d $dir ]] || continue
    # Kill anything left in the subtree through the kernel's own interface.
    find "$dir" -depth -type d 2>/dev/null | while read -r sub; do
      echo 1 >"$sub/cgroup.kill" 2>/dev/null
    done
    sleep 0.2
    find "$dir" -depth -mindepth 1 -type d -exec rmdir {} \; 2>/dev/null
    rmdir "$dir" 2>/dev/null
  done
}
trap cleanup EXIT

[[ -x $TSX ]] || {
  echo "missing $TSX (run pnpm install first)" >&2
  exit 2
}
[[ -w /sys/fs/cgroup ]] || {
  echo "cgroup v2 mount is not writable; run on the isolated host" >&2
  exit 2
}

run_probe() {
  local label=$1 root=$2 mode=${3:-full}
  echo "### ${label}"
  echo "\$ MOYU_CGROUP_ROOT=${root} ${TSX} scripts/m5b/cgroup-lifecycle-probe.ts ${mode}"
  (cd "$REPO/apps/supervisor" && MOYU_CGROUP_ROOT="$root" PROBE_NONROOT_ROOT="$root" \
    timeout 180 "$TSX" "$REPO/scripts/m5b/cgroup-lifecycle-probe.ts" "$mode")
  echo "exit=$?"
  echo
}

{
  echo "# M5-B cgroup 冷启动与重启归属探针"
  echo "recorded=$(date -Is)"
  echo "head=$(cd "$REPO" && git rev-parse HEAD)"
  echo "node=$(MOYU_CGROUP_ROOT=/sys/fs/cgroup/ignored "$NODE_BIN" -v 2>/dev/null || echo "$NODE_BIN")"
  echo "kernel=$(uname -r) user=$(id -un)($(id -u))"
  echo "cgroup_mount=$(awk '$5=="/sys/fs/cgroup"{print $9}' /proc/self/mountinfo) type=$(stat -f -c %T /sys/fs/cgroup)"
  echo "self_cgroup=$(awk -F: '/^0::/{print $3}' /proc/self/cgroup)"
  echo

  # 1. 空白委托目录：只建这一层，不给它启用控制器，也不预建 instances 根。
  mkdir "$BASE" || exit 1
  echo "blank_parent=${BASE#/sys/fs/cgroup}"
  echo "blank_parent.controllers=$(tr '\n' ' ' <"$BASE/cgroup.controllers")"
  echo "blank_parent.subtree_control=[$(cat "$BASE/cgroup.subtree_control")]"
  echo "blank_parent.procs=[$(tr '\n' ' ' <"$BASE/cgroup.procs")]"
  echo
  run_probe "空白委托目录冷启动（MOYU_CGROUP_ROOT 不存在）" "$BASE/instances" full

  # 2. 权限不足场景。用 esbuild 打成一份世界可读的 bundle，换身份运行真实实现。
  [[ -x $ESBUILD && -x $RUN_NODE ]] || {
    echo "esbuild or $RUN_NODE missing; skipping the non-root cases" >&2
    return 0
  }
  "$ESBUILD" "$REPO/scripts/m5b/cgroup-lifecycle-probe.ts" --bundle --platform=node \
    --format=esm --log-level=warning --outfile="$BUNDLE_DIR/probe.mjs"
  chmod 0755 "$BUNDLE_DIR" "$BUNDLE_DIR/probe.mjs"
  mkdir "$NONROOT_BASE" "$NONROOT_DELEGATED"
  chmod 0755 "$NONROOT_BASE"
  # (a) root 所有的目录：连根都建不出来。
  echo "### 权限不足场景 (a)：目录由 root 所有，换身份后无法建根"
  echo "\$ setpriv --reuid=65534 --regid=65534 --clear-groups MOYU_CGROUP_ROOT=${NONROOT_BASE}/instances $RUN_NODE probe.mjs nonroot"
  MOYU_CGROUP_ROOT="$NONROOT_BASE/instances" \
    setpriv --reuid=65534 --regid=65534 --clear-groups \
    timeout 60 "$RUN_NODE" "$BUNDLE_DIR/probe.mjs" nonroot
  echo "exit=$?"
  # (b) 目录委托给了测试身份，但上一层（systemd 单元 cgroup）没有把控制器交给它：
  #     根能建出来，控制器启用必须明确失败，不能返回一个未计量的实例路径。
  chown 65534:65534 "$NONROOT_DELEGATED"
  chmod 0755 "$NONROOT_DELEGATED"
  echo
  echo "### 权限不足场景 (b)：委托目录可写，但上一层未交出 memory/pids"
  echo "\$ setpriv --reuid=65534 --regid=65534 --clear-groups MOYU_CGROUP_ROOT=${NONROOT_DELEGATED}/instances $RUN_NODE probe.mjs nonroot"
  MOYU_CGROUP_ROOT="$NONROOT_DELEGATED/instances" \
    setpriv --reuid=65534 --regid=65534 --clear-groups \
    timeout 60 "$RUN_NODE" "$BUNDLE_DIR/probe.mjs" nonroot
  echo "exit=$?"
} 2>&1 | tee "$LOG"

exit "${PIPESTATUS[0]}"
