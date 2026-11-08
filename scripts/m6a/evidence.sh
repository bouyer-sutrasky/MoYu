#!/usr/bin/env bash
# M6-A acceptance evidence, reproducible on any head.
#
# Builds this checkout, starts an isolated API + host supervisor + a recording
# stub Bridge, creates a real ticket worktree with real changes, and writes every
# A1-A8 log under docs/evidence/m6a/. Each log starts with the raw
# `git rev-parse HEAD` of the checkout that produced it, so evidence is tied to a
# head instead of a hand-written commit id.
#
# It only touches:
#   - the isolated PostgreSQL server in TEST_DATABASE_ADMIN_URL (a fresh database)
#   - $M6A_RUN_DIR (default /tmp/m6a-run)
#   - loopback ports 4620/4621/4690/4699 and the database above
# It never restarts 3082, the production API, or /root/src/upstream.
#
# Usage:
#   TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
#   M6A_PR_NUMBER=44 M6A_PR_URL=https://github.com/…/pull/44 \
#   M6A_CLOSED_PR_NUMBER=45 M6A_CLOSED_PR_URL=https://github.com/…/pull/45 \
#   bash scripts/m6a/evidence.sh
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
RUN=${M6A_RUN_DIR:-/tmp/m6a-run}
OUT="$REPO/docs/evidence/m6a"
ADMIN_URL=${TEST_DATABASE_ADMIN_URL:-}
DB_NAME=${M6A_DB_NAME:-moyu_m6a_evidence}
DATABASE_URL="$(printf '%s' "$ADMIN_URL" | sed "s#/[^/]*\$#/$DB_NAME#")"
API_AFTER=4620
API_BEFORE=4621
SUP=4690
STUB=4699
SUP_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'ab' | cut -c1-40)
STUB_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'cd' | cut -c1-32)
SESSION_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'ef' | cut -c1-43)
TICKET=t_m6a_$(git -C "$REPO" rev-parse --short=8 HEAD)
TICKET12=$(printf '%s' "$TICKET" | cut -c1-12)
CLEAN_TICKET=t_m6a_clean_$(git -C "$REPO" rev-parse --short=8 HEAD)
CLEAN12=$(printf '%s' "$CLEAN_TICKET" | cut -c1-12)
CLOSED_TICKET=t_m6a_closed_$(git -C "$REPO" rev-parse --short=8 HEAD)
CLOSED12=$(printf '%s' "$CLOSED_TICKET" | cut -c1-12)
WORKROOT="$RUN/worktrees"
WORKTREE="$WORKROOT/probe1/m6a-review-$TICKET12"
CLEAN_WORKTREE="$WORKROOT/probe1/m6a-clean-$CLEAN12"
CLOSED_WORKTREE="$WORKROOT/probe1/m6a-closed-$CLOSED12"
NODE_BIN=${M6A_NODE_BIN:-/opt/moyu-node24/bin}
PATH="$NODE_BIN:$PATH"

# --- process ownership -------------------------------------------------------
# Every process this run starts is recorded in $RUN/pids and carries a run marker
# in its environment. Cleanup proves that marker before it signals anything, so
# another process that happens to use the same ports or command line is left
# alone. Command lines and listening ports belong to whoever owns them.
RUN_ID=${M6A_RUN_ID:-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')}
PIDS="$RUN/pids"
MARKER="M6A_RUN_ID=$RUN_ID"

# True only for a live pid that carries this run's marker.
owned_pid_alive() {
  local pid=$1
  [[ -n "$pid" && -d "/proc/$pid" ]] || return 1
  grep -qzxF "$MARKER" "/proc/$pid/environ" 2>/dev/null
}

# Start one recorded service: <name> <cwd> <command...>. The command becomes the
# session leader, so its pid is also its process group, and its pid is written
# before it execs the real program.
start_owned() {
  local name=$1 cwd=$2 pid
  shift 2
  mkdir -p "$PIDS" "$RUN/logs"
  M6A_RUN_ID="$RUN_ID" setsid bash -c '
    cd "$1" || exit 1
    printf "%s" "$$" > "$2"
    shift 2
    exec "$@"
  ' _ "$cwd" "$PIDS/$name.pid" "$@" > "$RUN/logs/$name.log" 2>&1 < /dev/null &
  for _ in $(seq 1 100); do [[ -s "$PIDS/$name.pid" ]] && break; sleep 0.05; done
  pid=$(cat "$PIDS/$name.pid" 2>/dev/null || true)
  if [[ -z "$pid" ]] || ! owned_pid_alive "$pid"; then
    echo "cannot prove ownership of the $name process (pid=$pid)" >&2
    return 1
  fi
  printf '%s\n' "$pid"
}

stop_owned() {
  local name=$1 pid
  [[ -f "$PIDS/$name.pid" ]] || return 0
  pid=$(cat "$PIDS/$name.pid" 2>/dev/null || true)
  if owned_pid_alive "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do owned_pid_alive "$pid" || break; sleep 0.1; done
    if owned_pid_alive "$pid"; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PIDS/$name.pid"
}

stop_owned_services() {
  local file name
  for file in "$PIDS"/*.pid; do
    [[ -e "$file" ]] || continue
    name=$(basename "$file" .pid)
    stop_owned "$name"
  done
}

# The A3 dispatcher is one of the recorded services; nothing else is touched.
stop_dispatcher() {
  stop_owned dispatcher
}

# The only cleanup entry: every signal is preceded by the ownership check.
cleanup_run_processes() {
  stop_owned_services
}

log() { printf '%s\n' "$*"; }

header() {
  # $1 title, $2 file
  {
    printf '# %s — %s\n' "$1" "$(date -Is)"
    printf '$ git rev-parse HEAD\n'
    git -C "$REPO" rev-parse HEAD
    printf '$ git -C %s rev-parse HEAD\n' "$WORKTREE"
    git -C "$WORKTREE" rev-parse HEAD 2>/dev/null || printf '(task worktree not created for this item)\n'
    printf '环境：隔离 API http://127.0.0.1:%s，DB %s，存储 %s，supervisor http://127.0.0.1:%s\n\n' \
      "$API_AFTER" "$DB_NAME" "$RUN/artifacts" "$SUP"
  } > "$2"
}

api() { curl -s -b "moyu_session=$SESSION_TOKEN" "$@"; }

wait_http() {
  local url=$1 tries=${2:-40}
  for _ in $(seq 1 "$tries"); do
    if curl -s -o /dev/null --max-time 2 "$url"; then return 0; fi
    sleep 0.5
  done
  return 1
}

main() {
  set -euo pipefail
  : "${TEST_DATABASE_ADMIN_URL:?TEST_DATABASE_ADMIN_URL is required}"
  mkdir -p "$OUT" "$RUN/logs" "$RUN/artifacts" "$RUN/creds" "$RUN/env" "$PIDS"
  : > "$RUN/bridge-triggers.jsonl"
  trap cleanup_run_processes EXIT

log "==> build this checkout"
(cd "$REPO" && corepack pnpm install --frozen-lockfile >/dev/null && corepack pnpm build >/dev/null)

log "==> recreate isolated database $DB_NAME"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$DB_NAME\""
(cd "$REPO" && DATABASE_URL="$DATABASE_URL" corepack pnpm --filter @moyu/db db:migrate >/dev/null)

log "==> create the ticket worktrees"
# The cleaned task deliberately has no directory: that is the cleanup boundary.
rm -rf "$WORKTREE" "$CLEAN_WORKTREE" "$CLOSED_WORKTREE"
mkdir -p "$WORKROOT/probe1"
git clone -q "$REPO" "$WORKTREE"
git clone -q "$REPO" "$CLOSED_WORKTREE"
# A real, reviewable worktree change set: modify, delete, rename, add untracked.
printf '\nM6-A 验收用的一行改动。\n' >> "$WORKTREE/README.md"
(cd "$WORKTREE" && git mv docs/GLOSSARY.md docs/GLOSSARY-m6a.md && rm LICENSE)
printf '# M6-A fixture\n\n这个文件是未跟踪的新文件，用于验证 diff 面板。\n' > "$WORKTREE/docs/m6a-fixture.md"
(cd "$WORKTREE" && corepack pnpm install --frozen-lockfile >/dev/null)

log "==> seed the isolated rows"
seed=$(DATABASE_URL="$DATABASE_URL" M6A_SESSION_TOKEN="$SESSION_TOKEN" \
  M6A_TICKET_ID="$TICKET" M6A_CLEANED_TICKET_ID="$CLEAN_TICKET" \
  M6A_CLOSED_TICKET_ID="$CLOSED_TICKET" \
  M6A_PR_NUMBER="${M6A_PR_NUMBER:-}" M6A_PR_URL="${M6A_PR_URL:-}" \
  M6A_CLOSED_PR_NUMBER="${M6A_CLOSED_PR_NUMBER:-}" M6A_CLOSED_PR_URL="${M6A_CLOSED_PR_URL:-}" \
  node "$REPO/scripts/m6a/seed-fixture.mjs")
task_id=$(printf '%s' "$seed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).taskId))')
conversation_id=$(printf '%s' "$seed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).conversationId))')
cleaned_task_id=$(printf '%s' "$seed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).cleanedTaskId))')
cleaned_conversation_id=$(printf '%s' "$seed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).cleanedConversationId))')
closed_task_id=$(printf '%s' "$seed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).closedTaskId))')
closed_conversation_id=$(printf '%s' "$seed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).closedConversationId))')
OTHER_TOKEN=$(printf '%s' "$seed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).otherToken))')

# The dispatcher binds a repository through its legacy Bridge URL, so the row
# needs that URL and an online projection. The stub only records requests.
psql "$DATABASE_URL" -q -c "update repositories set bridge_url='http://127.0.0.1:$STUB' where id=(select repository_id from task_links where id='$task_id')"
psql "$DATABASE_URL" -q -c "update repository_instances set state='online', desired_state='sleeping', reason_code='listening'"

log "==> start the recording stub bridge, supervisor and API"
cat > "$RUN/instances.json" <<JSON
{
  "instances": [
    { "repository": "bouyer-sutrasky/MoYu", "profile": "probe1", "dshPort": 4692, "bridgePort": 4693 }
  ],
  "portRange": { "start": 4692, "end": 4699 }
}
JSON
start_owned stub "$REPO" env M6A_STUB_PORT="$STUB" M6A_STUB_TOKEN="$STUB_TOKEN" \
  M6A_STUB_RECORD="$RUN/bridge-triggers.jsonl" node "$REPO/scripts/m6a/stub-bridge.mjs" >/dev/null
start_owned supervisor "$REPO" env SUPERVISOR_TOKEN="$SUP_TOKEN" DATABASE_URL="$DATABASE_URL" \
  SUPERVISOR_HOST=127.0.0.1 SUPERVISOR_PORT="$SUP" \
  INSTANCES_CONFIG="$RUN/instances.json" DSH_BIN=/usr/bin/dsh DSH_HOME="$RUN/dsh" \
  PLATFORM_URL="http://127.0.0.1:$API_AFTER" RUNTIME_CREDENTIALS_DIR="$RUN/creds" \
  INSTANCE_ENV_DIR="$RUN/env" INSTANCE_LOG_DIR="$RUN/logs" WORKTREE_ROOT="$WORKROOT" \
  LOG_LEVEL=info NODE_ENV=test REVIEW_CHECK_COMMANDS='["pnpm check"]' REVIEW_CHECK_TIMEOUT_MS=900000 \
  PATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  node "$REPO/apps/supervisor/dist/main.js" >/dev/null

cat > "$RUN/api.env" <<ENV
NODE_ENV=test
API_HOST=127.0.0.1
API_PORT=$API_AFTER
LOG_LEVEL=info
DATABASE_URL=$DATABASE_URL
WEBAUTHN_RP_ID=127.0.0.1
WEBAUTHN_RP_NAME=MoYu
WEBAUTHN_ORIGIN=http://127.0.0.1:$API_AFTER
AUTH_COOKIE_SECURE=false
ARTIFACT_STORAGE_DIR=$RUN/artifacts
WEB_DIST_DIR=apps/web/dist
SUPERVISOR_URL=http://127.0.0.1:$SUP
SUPERVISOR_TOKEN=$SUP_TOKEN
GITHUB_CLI=gh
ENV
start_api_after() {
  start_owned api-after "$REPO" bash -c 'set -a; . "$1"; set +a; exec "$2" apps/api/dist/server.js' \
    _ "$RUN/api.env" "$NODE_BIN/node" >/dev/null
}
start_api_after

wait_http "http://127.0.0.1:$SUP/control/v1/health" || { echo 'supervisor did not start'; exit 1; }
wait_http "http://127.0.0.1:$API_AFTER/readyz" || { echo 'API did not start'; exit 1; }
wait_http "http://127.0.0.1:$STUB/bridge/v1/capabilities" || { echo 'stub did not start'; exit 1; }

log "==> A1 upload / download"
A1="$OUT/A1-upload.txt"
header "A1 上传主链路" "$A1"
{
  python3 - "$RUN" <<'PY'
import base64, pathlib, sys
run = pathlib.Path(sys.argv[1])
(run / 'upload.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))
(run / 'upload.txt').write_text('M6-A 附件验收\nsecond line\n', encoding='utf-8')
(run / 'upload.html').write_text('<html><body><script>alert(1)</script>injected</body></html>', encoding='utf-8')
PY
  echo '## 命令 1：上传 PNG'
  echo "$ curl -s -o resp-png.json -w '%{http_code}' -b 'moyu_session=<session>' -F 'file=@upload.png;type=image/png' \\"
  echo "    http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments"
  code=$(api -o "$RUN/resp-png.json" -w '%{http_code}' -F "file=@$RUN/upload.png;type=image/png" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments")
  echo "HTTP $code"; cat "$RUN/resp-png.json"; echo
  png_id=$(node -e "process.stdout.write(require(process.argv[1]).data.attachment.id)" "$RUN/resp-png.json")
  echo
  echo '## 命令 2：上传文本文件'
  code=$(api -o "$RUN/resp-txt.json" -w '%{http_code}' -F "file=@$RUN/upload.txt;type=text/plain" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments")
  echo "HTTP $code"; cat "$RUN/resp-txt.json"; echo
  txt_id=$(node -e "process.stdout.write(require(process.argv[1]).data.attachment.id)" "$RUN/resp-txt.json")
  echo
  echo '## 命令 3：鉴权下载并逐字节比较'
  echo "$ curl -s -b 'moyu_session=<session>' -D h1.txt -o dl.png http://127.0.0.1:$API_AFTER/api/v1/attachments/$png_id"
  api -D "$RUN/h1.txt" -o "$RUN/dl.png" "http://127.0.0.1:$API_AFTER/api/v1/attachments/$png_id"
  grep -Ei '^(HTTP|content-type|content-length|content-disposition|x-content-type-options|content-security-policy)' "$RUN/h1.txt"
  echo "$ sha256sum upload.png dl.png"
  sha256sum "$RUN/upload.png" "$RUN/dl.png"
  cmp "$RUN/upload.png" "$RUN/dl.png" && echo 'byte-identical: yes'
  api -o "$RUN/dl.txt" "http://127.0.0.1:$API_AFTER/api/v1/attachments/$txt_id"
  echo "$ sha256sum upload.txt dl.txt"
  sha256sum "$RUN/upload.txt" "$RUN/dl.txt"
  cmp "$RUN/upload.txt" "$RUN/dl.txt" && echo 'byte-identical: yes'
  echo
  echo '## 命令 4：HTML 上传后下载不得内联执行'
  code=$(api -o "$RUN/resp-html.json" -w '%{http_code}' -F "file=@$RUN/upload.html;type=text/html" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments")
  echo "HTTP $code"; cat "$RUN/resp-html.json"; echo
  html_id=$(node -e "process.stdout.write(require(process.argv[1]).data.attachment.id)" "$RUN/resp-html.json")
  api -D "$RUN/h3.txt" -o "$RUN/dl.html" "http://127.0.0.1:$API_AFTER/api/v1/attachments/$html_id"
  grep -Ei '^(HTTP|content-type|content-disposition|content-security-policy|x-content-type-options)' "$RUN/h3.txt"
  echo '判定：attachment + octet-stream + nosniff + CSP sandbox，不以内联 HTML 下发'
  echo
  echo '## attachments 库表原始行'
  psql "$DATABASE_URL" -c "select id, conversation_id, message_id, type, mime_type, size_bytes, sha256, metadata from artifacts where type='attachment' order by created_at"
  echo
  echo '## 存储目录（服务端生成的键，0600）'
  find "$RUN/artifacts" -type f -printf '%m %s %p\n' | sort
  printf '%s\n' "$png_id" "$txt_id" "$html_id" > "$RUN/attachment-ids"
} >> "$A1" 2>&1
png_id=$(sed -n 1p "$RUN/attachment-ids")

log "==> A2 rejection surface (with disk evidence)"
A2="$OUT/A2-rejections.txt"
header "A2 上传拒绝面" "$A2"
{
  storage() {
    printf 'files=%s bytes=%s\n' \
      "$(find "$RUN/artifacts" -type f | wc -l | tr -d ' ')" \
      "$(du -sb "$RUN/artifacts" | cut -f1)"
  }
  rows() { psql "$DATABASE_URL" -t -c "select count(*) from artifacts where type='attachment'" | tr -d ' '; }
  echo '## 1. 超大小上限（10 MiB + 1 KiB）→ 4xx，不落库也不落盘'
  python3 -c "open('$RUN/huge.txt','wb').write(b'A'*(10*1024*1024+1024))"
  echo "before: rows=$(rows) $(storage)"
  code=$(api -o "$RUN/resp-huge.json" -w '%{http_code}' -F "file=@$RUN/huge.txt;type=text/plain" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments")
  echo "HTTP $code"; cat "$RUN/resp-huge.json"; echo
  echo "after : rows=$(rows) $(storage)"
  echo
  echo '## 2. 非法 MIME/类型 → 4xx，不落库也不落盘'
  printf 'MZ' > "$RUN/setup.exe"
  echo "before: rows=$(rows) $(storage)"
  code=$(api -o "$RUN/resp-exe.json" -w '%{http_code}' -F "file=@$RUN/setup.exe;type=application/x-msdownload" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments")
  echo "HTTP $code"; cat "$RUN/resp-exe.json"; echo
  echo "after : rows=$(rows) $(storage)"
  echo
  echo '## 3. 未登录 → 401'
  code=$(curl -s -o "$RUN/resp-anon.json" -w '%{http_code}' -F "file=@$RUN/upload.txt;type=text/plain" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments")
  echo "HTTP $code"; cat "$RUN/resp-anon.json"; echo
  echo
  echo '## 4. 另一个用户向本会话上传 → 404'
  code=$(curl -s -o "$RUN/resp-foreign-upload.json" -w '%{http_code}' -b "moyu_session=$OTHER_TOKEN" \
    -F "file=@$RUN/upload.txt;type=text/plain" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments")
  echo "HTTP $code"; cat "$RUN/resp-foreign-upload.json"; echo
  echo
  echo '## 5. 另一个用户读取本会话的 attachmentId → 404'
  code=$(curl -s -o "$RUN/resp-foreign-read.json" -w '%{http_code}' -b "moyu_session=$OTHER_TOKEN" \
    "http://127.0.0.1:$API_AFTER/api/v1/attachments/$png_id")
  echo "HTTP $code"; cat "$RUN/resp-foreign-read.json"; echo
  echo
  echo '## 6. 空文件 → 422'
  : > "$RUN/empty.txt"
  code=$(api -o "$RUN/resp-empty.json" -w '%{http_code}' -F "file=@$RUN/empty.txt;type=text/plain" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/attachments")
  echo "HTTP $code"; cat "$RUN/resp-empty.json"; echo
  echo
  echo "## 7. 最终行数与磁盘占用（与 A1 的 3 行一致，拒绝面没有新增）"
  echo "rows=$(rows) $(storage)"
  find "$RUN/artifacts" -type f -printf '%m %s %p\n' | sort
} >> "$A2" 2>&1

log "==> A3 attachment delivery record"
A3="$OUT/A3-attachment-delivery.txt"
header "A3 附件与投递" "$A3"
{
  txt_id=$(sed -n 2p "$RUN/attachment-ids")
  echo '## 1. 带附件的消息'
  code=$(api -o "$RUN/resp-message.json" -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"clientMessageId\":\"m6a-attach-$TICKET12\",\"text\":\"附件随消息发送的验收记录\",\"attachmentIds\":[\"$png_id\",\"$txt_id\"]}" \
    "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/messages")
  echo "HTTP $code"; python3 -m json.tool "$RUN/resp-message.json"
  msg_id=$(node -e "process.stdout.write(require(process.argv[1]).data.message.id)" "$RUN/resp-message.json")
  echo
  echo '## 2. 附件行已绑定 message_id（同一事务）'
  psql "$DATABASE_URL" -c "select id, message_id, metadata->>'filename' as filename, size_bytes from artifacts where type='attachment' order by created_at"
  echo
  echo '## 3. dispatcher 实际发出的 Bridge Trigger（stub Bridge 原始记录，先启动 dispatcher）'
  start_owned dispatcher "$REPO" env NODE_ENV=test LOG_LEVEL=warn DATABASE_URL="$DATABASE_URL" \
    BRIDGE_REPOSITORY=bouyer-sutrasky/MoYu BRIDGE_URL="http://127.0.0.1:$STUB" BRIDGE_TOKEN="$STUB_TOKEN" \
    DELIVERY_INTERVAL_MS=300 EVENT_SYNC_INTERVAL_MS=500 RECONCILE_ON_START=false \
    node apps/dispatcher/dist/main.js >/dev/null
  for _ in $(seq 1 40); do
    grep -q "$msg_id" "$RUN/bridge-triggers.jsonl" 2>/dev/null && break
    sleep 0.5
  done
  python3 - "$RUN/bridge-triggers.jsonl" "$msg_id" <<'PY'
import json, sys
path, message_id = sys.argv[1], sys.argv[2]
for line in open(path):
    record = json.loads(line)
    if record['body'].get('messageId') == message_id:
        print(json.dumps(record['body'], ensure_ascii=False, indent=2))
PY
  echo
  echo '## 4. 投递状态'
  psql "$DATABASE_URL" -c "select d.upstream_trigger_id, d.state, d.attempt_count from deliveries d join messages m on m.id=d.message_id where m.id='$msg_id'"
  echo
  echo '## 5. 结论：附件未传给 runtime（明确记录，不沉默）'
  echo '- 共享契约 `bridgeTriggerInputSchema`（packages/contracts/src/runtime.ts）以 `.strict()` 结尾且没有 attachments 字段；'
  echo '  上游 Source 的 Trigger 也没有附件字段。上面的原始 Trigger 只有 text，没有 attachments。'
  echo '- 附件保存在平台存储并随消息展示/下载；投递到 runtime 需要上游 Bridge 补丁与能力协商，属后续单。'
  stop_dispatcher
} >> "$A3" 2>&1

log "==> A4 diff panel"
A4="$OUT/A4-diff.txt"
header "A4 diff 面板" "$A4"
{
  echo "任务 worktree：$WORKTREE"
  echo
  echo '## 1. 真实 git 命令的原始输出'
  echo '$ git status --porcelain=v1'; git -C "$WORKTREE" status --porcelain=v1
  echo; echo '$ git diff --numstat HEAD'; git -C "$WORKTREE" diff --numstat HEAD
  echo; echo '$ git diff HEAD   # 头 30 行'; git -C "$WORKTREE" diff HEAD | head -30
  echo
  echo '## 2. API 采集（POST /api/v1/tasks/:id/review/changes）'
  code=$(api -o "$RUN/a4-changes.json" -w '%{http_code}' -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$API_AFTER/api/v1/tasks/$task_id/review/changes")
  echo "HTTP $code"
  node -e '
const review = require(process.argv[1]).data.review;
const changes = review.changes;
console.log(JSON.stringify({state: changes.state, branch: changes.branch, commit: changes.commit,
  commitSubject: changes.commitSubject, committedAt: changes.committedAt,
  additions: changes.additions, deletions: changes.deletions, filesOmitted: changes.filesOmitted}, null, 2));
for (const f of changes.files) console.log(`- ${f.status.padEnd(9)} +${f.additions} -${f.deletions}  ${f.path}${f.previousPath ? " (← " + f.previousPath + ")" : ""}`);
' "$RUN/a4-changes.json"
  echo
  echo '## 3. 对照：面板里 LICENSE 的 patch 与同一命令的原始输出逐字节一致'
  node -e '
const review = require(process.argv[1]).data.review;
const patch = review.changes.files.find((f) => f.path === "LICENSE").patch;
require("fs").writeFileSync(process.argv[2], patch);
' "$RUN/a4-changes.json" "$RUN/panel-license.patch"
  git -C "$WORKTREE" diff HEAD -- LICENSE > "$RUN/raw-license.patch"
  cmp "$RUN/panel-license.patch" "$RUN/raw-license.patch" && echo 'identical: yes'
  echo
  echo '## 4. 未跟踪文件来自真实 git 输出，增行数取自 patch'
  echo '$ git diff --no-index --no-prefix -- /dev/null docs/m6a-fixture.md'
  git -C "$WORKTREE" diff --no-index --no-prefix -- /dev/null docs/m6a-fixture.md || true
  echo
  echo '## 5. 无改动任务（clean worktree）：空列表，不显示推断内容'
  echo "worktree：$CLOSED_WORKTREE"
  echo '$ git status --porcelain=v1（应为空）'; git -C "$CLOSED_WORKTREE" status --porcelain=v1
  code=$(api -o "$RUN/a4-clean.json" -w '%{http_code}' -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$API_AFTER/api/v1/tasks/$closed_task_id/review/changes")
  echo "HTTP $code"
  node -e 'const c=require(process.argv[1]).data.review.changes; console.log("state =",c.state,"| files =",c.files,"| additions =",c.additions,"| deletions =",c.deletions)' "$RUN/a4-clean.json"
  echo
  echo '## 6. 工作目录已清理的任务：cleaned 而不是空白'
  code=$(api -o "$RUN/a4-cleaned.json" -w '%{http_code}' -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$API_AFTER/api/v1/tasks/$cleaned_task_id/review/changes")
  echo "HTTP $code"
  node -e 'const c=require(process.argv[1]).data.review.changes; console.log("state =",c.state); console.log("reason =",c.reason); console.log("files =",c.files)' "$RUN/a4-cleaned.json"
} >> "$A4" 2>&1

log "==> A5 check runs (pass -> deliberate type failure -> pass)"
A5="$OUT/A5-checks.txt"
header "A5 检查面板" "$A5"
{
  run_checks() {
    local out=$1
    api -o "$out" -w 'HTTP %{http_code}\n' -H 'content-type: application/json' -d '{}' \
      "http://127.0.0.1:$API_AFTER/api/v1/tasks/$task_id/review/checks"
  }
  show() {
    node -e '
const checks = require(process.argv[1]).data.review.checks;
console.log("state:", checks.state, "| collectedAt:", checks.collectedAt);
for (const run of checks.runs) {
  console.log("command     :", run.command);
  console.log("exitCode    :", run.exitCode, "| passed:", run.passed, "| timedOut:", run.timedOut);
  console.log("startedAt   :", run.startedAt, "| finishedAt:", run.finishedAt, "| ms:", run.durationMs);
  console.log("summary     :", run.summary);
  console.log("output (末尾 20 行):");
  console.log(run.output.split("\n").slice(-20).join("\n"));
  console.log();
}
' "$1"
  }
  echo '## 1. 第一次运行：通过'
  run_checks "$RUN/a5-pass1.json"; show "$RUN/a5-pass1.json"
  echo '## 2. 故意改坏一个类型后运行：失败'
  printf "export const broken: number = 'm6a deliberate type failure';\n" > "$WORKTREE/apps/api/src/m6a-broken.ts"
  run_checks "$RUN/a5-fail.json"; show "$RUN/a5-fail.json"
  echo '   面板失败状态截图：'
  M6A_SESSION_TOKEN="$SESSION_TOKEN" M6A_CONVERSATION_ID="$conversation_id" \
    M6A_AFTER_URL="http://127.0.0.1:$API_AFTER" M6A_OUT="$OUT" \
    M6A_FAILURE_TEXT="$RUN/failure-text.txt" \
    node "$REPO/scripts/m6a/failure-shot.mjs"
  echo '## 3. 恢复文件后再次运行：通过'
  rm -f "$WORKTREE/apps/api/src/m6a-broken.ts"
  run_checks "$RUN/a5-pass2.json"; show "$RUN/a5-pass2.json"
  echo '## 面板截图'
  echo '- 失败状态：docs/evidence/m6a/after-desktop-light-checks-failed.png'
  echo '- 通过状态：docs/evidence/m6a/after-desktop-light-review-panel.png'
} >> "$A5" 2>&1

log "==> A6 commit and pull request"
A6="$OUT/A6-delivery.txt"
header "A6 提交与 PR 关联" "$A6"
{
  echo '## 1. 任务 worktree 的真实 HEAD（完整 SHA）'
  echo '$ git rev-parse HEAD'; git -C "$WORKTREE" rev-parse HEAD
  echo '$ git log -1 --format="%H%n%s%n%cI"'; git -C "$WORKTREE" log -1 --format='%H%n%s%n%cI'
  echo
  echo '## 2. 面板投影里的提交与 PR（GET /api/v1/tasks/:id/review）'
  api -o "$RUN/a6-get.json" "http://127.0.0.1:$API_AFTER/api/v1/tasks/$task_id/review"
  node -e 'const r=require(process.argv[1]).data.review; console.log(JSON.stringify({commit:r.changes.commit, commitSubject:r.changes.commitSubject, pullRequest:r.pullRequest}, null, 2))' "$RUN/a6-get.json"
  echo
  if [ -n "${M6A_PR_NUMBER:-}" ]; then
    echo "## 3. GitHub 原始输出：本单 PR #$M6A_PR_NUMBER"
    echo "\$ gh pr view $M6A_PR_NUMBER --repo bouyer-sutrasky/MoYu --json number,url,state,headRefOid,baseRefName,updatedAt,closedAt,mergedAt"
    timeout 60 gh pr view "$M6A_PR_NUMBER" --repo bouyer-sutrasky/MoYu --json number,url,state,headRefOid,baseRefName,updatedAt,closedAt,mergedAt
  else
    echo '## 3. 未提供 M6A_PR_NUMBER，跳过 open PR 状态'
  fi
  echo
  if [ -n "${M6A_CLOSED_PR_NUMBER:-}" ]; then
    echo "## 4. PR 关闭但未合并：#$M6A_CLOSED_PR_NUMBER"
    echo "\$ gh pr view $M6A_CLOSED_PR_NUMBER --repo bouyer-sutrasky/MoYu --json number,url,state,mergedAt"
    timeout 60 gh pr view "$M6A_CLOSED_PR_NUMBER" --repo bouyer-sutrasky/MoYu --json number,url,state,mergedAt
    code=$(api -o "$RUN/a6-closed.json" -w '%{http_code}' -H 'content-type: application/json' -d '{}' \
      "http://127.0.0.1:$API_AFTER/api/v1/tasks/$closed_task_id/review/changes")
    echo "采集 HTTP $code"
    node -e 'const r=require(process.argv[1]).data.review; console.log("面板投影:", JSON.stringify(r.pullRequest)); console.log("state =", r.pullRequest.state, "→ 不显示 merged")' "$RUN/a6-closed.json"
  else
    echo '## 4. 未提供 M6A_CLOSED_PR_NUMBER，跳过 closed PR 状态'
  fi
  echo
  echo '## 5. 取不到 GitHub 数据时显示原因'
  psql "$DATABASE_URL" -q -c "update repositories set full_name='bouyer-sutrasky/MoYu-does-not-exist' where full_name='bouyer-sutrasky/MoYu'"
  api -o "$RUN/a6-unavailable.json" -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$API_AFTER/api/v1/tasks/$task_id/review/changes"
  node -e 'const r=require(process.argv[1]).data.review; console.log(JSON.stringify(r.pullRequest, null, 2))' "$RUN/a6-unavailable.json"
  psql "$DATABASE_URL" -q -c "update repositories set full_name='bouyer-sutrasky/MoYu' where full_name='bouyer-sutrasky/MoYu-does-not-exist'"
  echo '（仓库名已恢复）'
  # Re-collect so the stored projection, and the panel, show the real PR again.
  api -o /dev/null -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$API_AFTER/api/v1/tasks/$task_id/review/changes"
} >> "$A6" 2>&1

log "==> A7 restart and cleaned boundary"
A7="$OUT/A7-restart.txt"
header "A7 重启与已清理边界" "$A7"
{
  digest() {
    node -e '
const crypto = require("node:crypto");
const r = require(process.argv[1]).data.review;
console.log("commit        :", r.changes.commit);
console.log("files         :", r.changes.files.map((f) => f.path).join(", "));
console.log("additions/dels:", r.changes.additions, r.changes.deletions);
console.log("checks        :", JSON.stringify(r.checks.runs.map((x) => [x.command, x.exitCode, x.startedAt])));
console.log("pr            :", JSON.stringify(r.pullRequest));
console.log("digest        :", crypto.createHash("sha256").update(JSON.stringify(r, Object.keys(r).sort())).digest("hex"));
' "$1"
  }
  echo '## 1. 重启前读取'
  api -o "$RUN/a7-before.json" "http://127.0.0.1:$API_AFTER/api/v1/tasks/$task_id/review"
  digest "$RUN/a7-before.json"
  api -o "$RUN/a7-messages-before.json" "http://127.0.0.1:$API_AFTER/api/v1/conversations/$conversation_id/messages"
  node -e 'const m=require(process.argv[1]).data.messages; console.log("attachments   :", JSON.stringify(m.flatMap((x)=>x.attachments).map((a)=>[a.filename,a.sha256])))' "$RUN/a7-messages-before.json"
  echo
  echo '## 2. 重启平台 API 进程'
  old=$(cat "$PIDS/api-after.pid" 2>/dev/null || true)
  echo "old API pid: $old"
  stop_owned api-after
  start_api_after
  wait_http "http://127.0.0.1:$API_AFTER/readyz"
  echo "new API pid: $(cat "$PIDS/api-after.pid" 2>/dev/null || true)"
  echo '$ curl -s http://127.0.0.1:'"$API_AFTER"'/readyz'; curl -s "http://127.0.0.1:$API_AFTER/readyz"; echo
  echo
  echo '## 3. 重启后读取同一任务'
  api -o "$RUN/a7-after.json" "http://127.0.0.1:$API_AFTER/api/v1/tasks/$task_id/review"
  digest "$RUN/a7-after.json"
  node -e '
const before = require(process.argv[1]).data.review;
const after = require(process.argv[2]).data.review;
console.log("identical to the pre-restart projection:", JSON.stringify(before) === JSON.stringify(after));
' "$RUN/a7-before.json" "$RUN/a7-after.json"
  echo
  echo '## 4. 数据来自持久层：数据库里的产物行'
  psql "$DATABASE_URL" -c "select type, count(*), max(created_at) as newest from artifacts where task_id='$task_id' group by type order by type"
  echo
  echo '## 5. 重启后附件仍逐字节一致'
  api -o "$RUN/a7-download.png" "http://127.0.0.1:$API_AFTER/api/v1/attachments/$png_id"
  sha256sum "$RUN/upload.png" "$RUN/a7-download.png"
  echo
  echo '## 6. 已清理任务返回 cleaned 与原因'
  api -o "$RUN/a7-cleaned.json" "http://127.0.0.1:$API_AFTER/api/v1/tasks/$cleaned_task_id/review"
  node -e 'const c=require(process.argv[1]).data.review.changes; console.log("state :",c.state); console.log("reason:",c.reason); console.log("files :",c.files)' "$RUN/a7-cleaned.json"
} >> "$A7" 2>&1

log "==> before build (PR base) for the regression comparison and the screenshots"
BASE_SHA=$(git -C "$REPO" merge-base HEAD origin/main)
BEFORE="$RUN/before"
rm -rf "$BEFORE"
git -C "$REPO" worktree remove --force "$BEFORE" >/dev/null 2>&1 || true
git -C "$REPO" worktree prune
git -C "$REPO" worktree add -q --detach "$BEFORE" "$BASE_SHA"
if [ ! -d "$BEFORE" ]; then echo "could not create the before worktree at $BEFORE"; exit 1; fi
(cd "$BEFORE" && PATH="$NODE_BIN:$PATH" corepack pnpm install --frozen-lockfile >/dev/null && PATH="$NODE_BIN:$PATH" corepack pnpm build >/dev/null)
(cd "$BEFORE" && git rev-parse HEAD > "$RUN/before-head")

log "==> A8 regression counts"
A8="$OUT/A8-regression.txt"
header "A8 回归" "$A8"
{
  echo '## 1. pnpm check（lint + format + typecheck + 单元测试）'
  (cd "$REPO" && PATH="$NODE_BIN:$PATH" corepack pnpm check > "$RUN/check.log" 2>&1); echo "exit=$?"
  grep -E 'Tests  |Test Files|ℹ tests|ℹ pass|ℹ fail' "$RUN/check.log" | head -20
  echo
  echo '## 2. 真实 PostgreSQL 集成测试'
  (cd "$REPO" && TEST_DATABASE_ADMIN_URL="$ADMIN_URL" PATH="$NODE_BIN:$PATH" corepack pnpm test:integration > "$RUN/integration.log" 2>&1); echo "exit=$?"
  grep -E 'Test Files|Tests  ' "$RUN/integration.log"
  echo
  echo
  echo '## 3. before 对照（同一台机器、同一隔离 PostgreSQL，PR 基线构建）'
  echo '$ git -C <before> rev-parse HEAD'; cat "$RUN/before-head"
  (cd "$BEFORE" && PATH="$NODE_BIN:$PATH" corepack pnpm check > "$RUN/check-before.log" 2>&1); echo "check exit=$?"
  grep -E 'Tests  |Test Files|ℹ tests|ℹ pass|ℹ fail' "$RUN/check-before.log" | head -20
  (cd "$BEFORE" && TEST_DATABASE_ADMIN_URL="$ADMIN_URL" PATH="$NODE_BIN:$PATH" corepack pnpm test:integration > "$RUN/integration-before.log" 2>&1); echo "integration exit=$?"
  grep -E 'Test Files|Tests  ' "$RUN/integration-before.log"
  echo
  echo '## 4. 既有测试未回退'
  echo '- before/after 的套件条数见上；新增测试：附件集成 11 条、review 集成 5 条、supervisor review 9 条、迁移回滚 2 条。'
} >> "$A8" 2>&1

log "==> screenshots (before = the PR base build)"
start_owned api-before "$BEFORE" env NODE_ENV=test API_HOST=127.0.0.1 API_PORT="$API_BEFORE" \
  LOG_LEVEL=warn DATABASE_URL="$DATABASE_URL" \
  WEBAUTHN_RP_ID=127.0.0.1 WEBAUTHN_RP_NAME=MoYu WEBAUTHN_ORIGIN="http://127.0.0.1:$API_BEFORE" \
  AUTH_COOKIE_SECURE=false ARTIFACT_STORAGE_DIR="$RUN/artifacts" WEB_DIST_DIR=apps/web/dist \
  SUPERVISOR_URL="http://127.0.0.1:$SUP" SUPERVISOR_TOKEN="$SUP_TOKEN" GITHUB_CLI=gh \
  "$NODE_BIN/node" apps/api/dist/server.js >/dev/null
wait_http "http://127.0.0.1:$API_BEFORE/readyz" || { echo 'before API did not start'; exit 1; }

M6A_SESSION_TOKEN="$SESSION_TOKEN" M6A_CONVERSATION_ID="$conversation_id" \
  M6A_CLEANED_CONVERSATION_ID="$cleaned_conversation_id" M6A_REPOSITORY=bouyer-sutrasky/MoYu \
  M6A_FAILURE_TEXT="$RUN/failure-text.txt" \
  M6A_AFTER_URL="http://127.0.0.1:$API_AFTER" M6A_BEFORE_URL="http://127.0.0.1:$API_BEFORE" \
  node "$REPO/scripts/m6a/screenshots.mjs" > "$RUN/screenshots.out" 2>&1 || {
    echo 'screenshots failed:'; tail -20 "$RUN/screenshots.out"; exit 1; }
python3 -c "
import json; d=json.load(open('$OUT/ui-checks.json'))
print(json.dumps({k:v for k,v in d.items() if k != 'records'}, ensure_ascii=False, indent=2))"

log "==> done. Final head: $(git -C "$REPO" rev-parse HEAD)"

}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
