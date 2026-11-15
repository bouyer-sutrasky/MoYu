#!/usr/bin/env bash
# ISS-63 evidence: run the same two-repository scenario against the pre-change
# tree (both repositories must use the supervisor-wide command) and the fixed
# tree (one repository has its own commands, the other falls back, invalid
# configuration fails closed).
#
# Requirements:
#   M63_DB_ADMIN_URL   isolated PostgreSQL admin URL (e.g. the 55432 test cluster)
#   M63_BASE_TREE      a clean checkout/worktree at the pre-change commit
#   M63_BRANCH_TREE    optional; defaults to this script's repository
#   M63_RUN_DIR        optional temp root (default /tmp/m63-evidence)
#
# It refuses to touch the production API/3082: the script only uses loopback
# ports 4790/4791 and a throwaway database.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BRANCH_TREE=${M63_BRANCH_TREE:-$(cd "$HERE/../.." && pwd)}
BASE_TREE=${M63_BASE_TREE:-}
ADMIN_URL=${M63_DB_ADMIN_URL:-${TEST_DATABASE_ADMIN_URL:-}}
LOG_DIR="$BRANCH_TREE/docs/evidence/m63"
LOG="$LOG_DIR/ISS63-check-commands.txt"

if [ -z "$ADMIN_URL" ]; then
  echo "error: M63_DB_ADMIN_URL (or TEST_DATABASE_ADMIN_URL) is required" >&2
  exit 2
fi
if [ -z "$BASE_TREE" ] || { [ ! -d "$BASE_TREE/.git" ] && [ ! -f "$BASE_TREE/.git" ]; }; then
  echo "error: M63_BASE_TREE must be a git checkout/worktree of the pre-change commit" >&2
  exit 2
fi
if [ ! -d "$BRANCH_TREE/.git" ] && [ ! -f "$BRANCH_TREE/.git" ]; then
  echo "error: M63_BRANCH_TREE is not a git checkout: $BRANCH_TREE" >&2
  exit 2
fi

export PATH="/opt/moyu-node24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"
mkdir -p "$LOG_DIR"
: > "$LOG"

write_header() {
  {
    echo "# ISS-63 按仓库配置检查命令 · 红绿证据"
    echo "# 生成时间：$(date -Iseconds)"
    echo "# node：$(node --version) / pnpm：$(pnpm --version)"
    echo "# base tree：$BASE_TREE @ $(git -C "$BASE_TREE" rev-parse HEAD)"
    echo "# branch tree：$BRANCH_TREE @ $(git -C "$BRANCH_TREE" rev-parse HEAD)"
    echo "# 隔离库：$ADMIN_URL（脚本内随机库名）"
    echo
  } >> "$LOG"
}

prepare_tree() {
  local tree=$1
  echo "==> install/build $tree" >&2
  (cd "$tree" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null)
}

run_case() {
  local label=$1
  local tree=$2
  local port=$3
  echo "==> $label ($tree) port $port" >&2
  node "$BRANCH_TREE/scripts/m63/evidence.mjs" \
    --tree "$tree" \
    --label "$label" \
    --port "$port" >> "$LOG" 2>&1
}

status=0
write_header
prepare_tree "$BASE_TREE" || status=1
prepare_tree "$BRANCH_TREE" || status=1
run_case base "$BASE_TREE" 4790 || status=1
run_case branch "$BRANCH_TREE" 4791 || status=1

echo >> "$LOG"
if [ "$status" -eq 0 ]; then
  echo "RESULT PASS (base red behaviour + branch green behaviour)" >> "$LOG"
else
  echo "RESULT FAIL (see the sections above)" >> "$LOG"
fi

cat "$LOG"
exit "$status"
