#!/usr/bin/env bash
# #58 rehearsal: a dedicated review-check identity and the hardened web unit.
#
# Runs on the deployment host as root. It creates the service users if they do
# not exist, starts isolated transient systemd units (the same directives as
# deploy/systemd/moyu.service and moyu-m5b-supervisor.service, with rehearsal
# paths and ports), and writes every command, raw output and exit code to
# docs/evidence/m6a/P1A3b-check-identity.txt.
#
# It never edits /etc/systemd/system/moyu.service, never restarts the live
# 3082/4300 services and never writes outside:
#   - the isolated database in TEST_DATABASE_ADMIN_URL
#   - /srv/moyu-rehearsal
#   - /var/lib/moyu-rehearsal (the API's StateDirectory in the rehearsal unit)
#   - the temporary units moyu-rehearsal-*
#
# Usage:
#   TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
#     bash scripts/m6a/check-identity-rehearsal.sh
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
NODE_BIN=${M6A_NODE_BIN:-/opt/moyu-node24/bin}
PATH="$NODE_BIN:$PATH"
export PATH
RUN=${M6A_ID_RUN:-/srv/moyu-rehearsal}
OUT=${M6A_OUT:-$REPO/docs/evidence/m6a}
EVIDENCE="$OUT/P1A3b-check-identity.txt"
ADMIN_URL=${TEST_DATABASE_ADMIN_URL:?TEST_DATABASE_ADMIN_URL is required}
DB=${M6A_ID_DB:-moyu_check_identity}
DB_URL=$(printf '%s' "$ADMIN_URL" | sed "s#/[^/]*\$#/$DB#")
API_PORT=${M6A_ID_API_PORT:-4630}
SUP_GREEN_PORT=${M6A_ID_SUP_PORT:-4691}
SUP_RED_PORT=${M6A_ID_SUP_RED_PORT:-4690}
SUP_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'ab' | cut -c1-40)
TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '/+' 'ef' | cut -c1-43)
TICKET="t_m6a_id_$(git -C "$REPO" rev-parse --short=8 HEAD)"
TICKET12=$(printf '%s' "$TICKET" | cut -c1-12)
WORKTREE="$RUN/worktrees/probe1/m6a-review-$TICKET12"
SENTINEL="$RUN/sentinel"
SUP_UNIT=moyu-rehearsal-supervisor
SUP_RED_UNIT=moyu-rehearsal-supervisor-red
API_UNIT=moyu-rehearsal-api

mkdir -p "$OUT"
: > "$EVIDENCE"

run() {
  printf '$ %s\n' "$*" >>"$EVIDENCE"
  set +e
  "$@" >>"$EVIDENCE" 2>&1
  local code=$?
  set -e
  printf '[exit code: %s]\n\n' "$code" >>"$EVIDENCE"
  return "$code"
}

run_sh() {
  printf '$ %s\n' "$1" >>"$EVIDENCE"
  set +e
  bash -c "$1" >>"$EVIDENCE" 2>&1
  local code=$?
  set -e
  printf '[exit code: %s]\n\n' "$code" >>"$EVIDENCE"
  return "$code"
}

stop_unit() {
  systemctl stop "$1" 2>/dev/null || true
  systemctl reset-failed "$1" 2>/dev/null || true
}

wait_supervisor() {
  local port=$1
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null --max-time 2 -H "authorization: Bearer $SUP_TOKEN" \
      "http://127.0.0.1:$port/control/v1/health"; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

wait_api() {
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$API_PORT/readyz"; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

cleanup_units() {
  stop_unit "$API_UNIT"
  stop_unit "$SUP_UNIT"
  stop_unit "$SUP_RED_UNIT"
}
trap cleanup_units EXIT

{
  printf '# P1A3b 检查子进程独立低权身份 + 服务加固 — %s\n\n' "$(date -Is)"
  printf '依据：Issue #58 的「判据」节；本文件是红→绿两段的原始命令、输出与 exit code。\n'
  printf '说明：哨兵内容是合成的 `m6a-sentinel-secret`，不是任何真实凭据。\n\n'
  printf '$ git rev-parse HEAD\n'
  git -C "$REPO" rev-parse HEAD
  printf '\n$ uname -a\n'
  uname -a
  printf '\n$ id\n'
  id
  printf '\n环境：隔离 DB `%s`；隔离 API `127.0.0.1:%s`；green supervisor `%s`；red supervisor `%s`。\n' \
    "$DB" "$API_PORT" "$SUP_GREEN_PORT" "$SUP_RED_PORT"
  printf 'host `/root/src/upstream/*` 未改；live `moyu.service` / 3082 / 4300 未重启、未改 unit。\n\n'
} >>"$EVIDENCE"

# ---------------------------------------------------------------------------
# 0. Users and isolated directories
# ---------------------------------------------------------------------------
log_section() { printf '\n## %s\n\n' "$1" >>"$EVIDENCE"; }

log_section '0. 固定身份（owner 在正式切换前创建；本脚本仅为预演创建）'
ensure_group() { getent group "$1" >/dev/null || groupadd --system "$1"; }
ensure_user() {
  local name=$1 home=$2
  getent passwd "$name" >/dev/null ||
    useradd --system --gid "$name" --home-dir "$home" --no-create-home --shell /usr/sbin/nologin "$name"
}
ensure_group moyu-check
ensure_group moyu-m5b
ensure_group moyu-web
ensure_user moyu-check /var/lib/moyu-check
ensure_user moyu-m5b /var/lib/moyu-m5b
ensure_user moyu-web /var/lib/moyu
usermod -aG moyu-check moyu-m5b
run sh -c 'getent passwd moyu-web moyu-m5b moyu-check; getent group moyu-check'
CHECK_UID=$(id -u moyu-check)
CHECK_GID=$(id -g moyu-check)
SUP_UID=$(id -u moyu-m5b)
SUP_GID=$(id -g moyu-m5b)
{
  printf 'CHECK_UID=%s CHECK_GID=%s SUP_UID=%s SUP_GID=%s\n\n' \
    "$CHECK_UID" "$CHECK_GID" "$SUP_UID" "$SUP_GID"
} >>"$EVIDENCE"

log_section '0.1 隔离目录（worktree 共享组 + 独立 HOME；不是递归 chown 到检查用户）'
rm -rf -- "$RUN"
install -d -m 0755 "$RUN"
# The service users cannot read /opt/moyu-node24 (0750 root:m5bmatrix), so give
# the rehearsal a world-readable copy of the same toolchain. A production
# deployment must provide an equivalent readable Node/pnpm path.
cp -a /opt/moyu-node24 "$RUN/node24"
chmod -R a+rX "$RUN/node24"
SERVICE_NODE_BIN="$RUN/node24/bin"
run setpriv --reuid=moyu-check --regid=moyu-check --init-groups "$SERVICE_NODE_BIN/node" -v
install -d -m 0755 "$RUN/app"
cp -a "$REPO/." "$RUN/app/"
rm -f "$RUN/app/.git"
chmod -R a+rX "$RUN/app"
install -d -o moyu-m5b -g moyu-check -m 2775 "$RUN/worktrees" "$RUN/worktrees/probe1"
install -d -o moyu-m5b -g moyu-m5b -m 0750 \
  "$RUN/sup-home" "$RUN/logs" "$RUN/dsh" "$RUN/creds" "$RUN/env"
install -d -o moyu-check -g moyu-check -m 0700 "$RUN/check-home" "$RUN/check-home/tmp"
install -d -o moyu-web -g moyu-web -m 0750 "$RUN/artifacts"
install -d -o moyu-web -g moyu-web -m 0755 /var/lib/moyu-rehearsal
install -d -o moyu-web -g moyu-web -m 0750 /var/lib/moyu-rehearsal/artifacts
printf 'm6a-sentinel-secret\n' >"$SENTINEL"
chmod 600 "$SENTINEL"
chown root:root "$SENTINEL"
chmod 0755 "$RUN"
run sh -c "stat -c '%U %G %a %n' '$RUN' '$RUN/worktrees' '$RUN/worktrees/probe1' '$RUN/check-home' '$SENTINEL'"

# ---------------------------------------------------------------------------
# 1. Isolated database, worktree and rows
# ---------------------------------------------------------------------------
log_section '1. 隔离数据库、真实 worktree 与 fixture 行'
run psql "$ADMIN_URL" -q \
  -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$DB\""
run bash -c "cd '$REPO' && DATABASE_URL='$DB_URL' pnpm --filter @moyu/db db:migrate"
run git clone -q --no-hardlinks "$REPO" "$WORKTREE"
# The rehearsal must check this working tree, not the last committed baseline:
# copy the changed sources over the clone so `pnpm check` sees the new identity
# code and tests even before the implementation commit exists.
for tree in apps packages scripts deploy docs; do
  cp -a "$REPO/$tree/." "$WORKTREE/$tree/"
done
printf '\nM6-A identity rehearsal change.\n' >>"$WORKTREE/README.md"
run bash -c "cd '$WORKTREE' && pnpm install --frozen-lockfile"
run bash -c "chown -R moyu-m5b:moyu-check '$WORKTREE' && chmod -R g+rwX '$WORKTREE' && find '$WORKTREE' -type d -exec chmod g+s {} +"
run git -c safe.directory="$WORKTREE" -C "$WORKTREE" rev-parse HEAD

SEED_JSON=$(DATABASE_URL="$DB_URL" M6A_SESSION_TOKEN="$TOKEN" M6A_TICKET_ID="$TICKET" \
  M6A_CLEANED_TICKET_ID="t_m6a_id_clean_$(git -C "$REPO" rev-parse --short=8 HEAD)" \
  M6A_CLOSED_TICKET_ID="t_m6a_id_closed_$(git -C "$REPO" rev-parse --short=8 HEAD)" \
  node "$REPO/scripts/m6a/seed-fixture.mjs")
printf '%s\n' "$SEED_JSON" >"$RUN/seed.json"
chmod 600 "$RUN/seed.json"
REPO_ID=$(printf '%s' "$SEED_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).repositoryId))')
TASK_ID=$(printf '%s' "$SEED_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).taskId))')
CONVERSATION_ID=$(printf '%s' "$SEED_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).conversationId))')
{
  printf 'repositoryId=%s\ntaskId=%s\nconversationId=%s\nticket=%s\nworktree=%s\n\n' \
    "$REPO_ID" "$TASK_ID" "$CONVERSATION_ID" "$TICKET" "$WORKTREE"
} >>"$EVIDENCE"
printf '{"instances":[{"repository":"bouyer-sutrasky/MoYu","profile":"probe1","dshPort":4692,"bridgePort":4693}],"portRange":{"start":4692,"end":4699}}\n' \
  >"$RUN/instances.json"
chmod 644 "$RUN/instances.json"

PROBE="id -u; id -g; grep -E 'NoNewPrivs|Cap(Eff|Amb)' /proc/self/status; ps -o pid,ppid,uid,gid,cmd -p \$\$ -p \$PPID; echo HOME=\$HOME TMPDIR=\$TMPDIR; cat $SENTINEL; echo sentinel-exit=\$?"
PROBE_JSON=$(node -e 'process.stdout.write(JSON.stringify([process.argv[1]]))' "$PROBE")

write_sup_env() {
  local file=$1 port=$2 commands=$3 extra=${4:-}
  cat >"$file" <<EOF
NODE_ENV=production
LOG_LEVEL=info
SUPERVISOR_HOST=127.0.0.1
SUPERVISOR_PORT=$port
SUPERVISOR_TOKEN=$SUP_TOKEN
DATABASE_URL=$DB_URL
INSTANCES_CONFIG=$RUN/instances.json
DSH_BIN=/usr/bin/dsh
DSH_HOME=$RUN/dsh
PLATFORM_URL=http://127.0.0.1:$API_PORT
RUNTIME_CREDENTIALS_DIR=$RUN/creds
INSTANCE_ENV_DIR=$RUN/env
INSTANCE_LOG_DIR=$RUN/logs
WORKTREE_ROOT=$RUN/worktrees
HOME=$RUN/sup-home
PATH=$SERVICE_NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REVIEW_CHECK_TIMEOUT_MS=900000
REVIEW_CHECK_COMMANDS=$commands
$extra
EOF
  chmod 600 "$file"
}

write_sup_env "$RUN/sup-probe.env" "$SUP_GREEN_PORT" "$PROBE_JSON" \
  "REVIEW_CHECK_UID=$CHECK_UID
REVIEW_CHECK_GID=$CHECK_GID
REVIEW_CHECK_HOME=$RUN/check-home"
write_sup_env "$RUN/sup-check.env" "$SUP_GREEN_PORT" '["pnpm check"]' \
  "REVIEW_CHECK_UID=$CHECK_UID
REVIEW_CHECK_GID=$CHECK_GID
REVIEW_CHECK_HOME=$RUN/check-home"
write_sup_env "$RUN/sup-red.env" "$SUP_RED_PORT" "$PROBE_JSON"
sed -i 's/^NODE_ENV=production$/NODE_ENV=test/' "$RUN/sup-red.env"
{
  printf '非密环境（token/DB URL 已省略）：\n'
  grep -E '^(NODE_ENV|SUPERVISOR_PORT|WORKTREE_ROOT|REVIEW_CHECK_|REVIEW_CHECK_COMMANDS)=' \
    "$RUN/sup-probe.env" "$RUN/sup-check.env" "$RUN/sup-red.env" || true
  printf '\n'
} >>"$EVIDENCE"

cat >"$RUN/api.env" <<EOF
NODE_ENV=test
API_HOST=127.0.0.1
API_PORT=$API_PORT
LOG_LEVEL=info
DATABASE_URL=$DB_URL
WEBAUTHN_RP_ID=127.0.0.1
WEBAUTHN_RP_NAME=MoYu
WEBAUTHN_ORIGIN=http://127.0.0.1:$API_PORT
AUTH_COOKIE_SECURE=false
ARTIFACT_STORAGE_DIR=/var/lib/moyu-rehearsal/artifacts
WEB_DIST_DIR=apps/web/dist
SUPERVISOR_URL=http://127.0.0.1:$SUP_GREEN_PORT
SUPERVISOR_TOKEN=$SUP_TOKEN
GITHUB_CLI=gh
HOME=/var/lib/moyu-rehearsal
EOF
chmod 600 "$RUN/api.env"
{
  printf 'API 环境（token/DB URL 已省略）：\n'
  grep -E '^(NODE_ENV|API_HOST|API_PORT|ARTIFACT_STORAGE_DIR|WEB_DIST_DIR|HOME)=' "$RUN/api.env" || true
  printf '\n'
} >>"$EVIDENCE"

# ---------------------------------------------------------------------------
# 2. Red: the current root supervisor, no check identity
# ---------------------------------------------------------------------------
log_section '2. 红段：supervisor 以 root 运行、检查子进程与父进程同 uid'
run systemctl show moyu.service -p User,Group,NoNewPrivileges,ProtectSystem,PrivateTmp --no-pager
LIVE_PID=$(systemctl show moyu.service -p MainPID --value)
run ps -o pid,ppid,uid,gid,cmd -p "$LIVE_PID"

stop_unit "$SUP_RED_UNIT"
run systemd-run --unit="$SUP_RED_UNIT" \
  --description='MoYu #58 red: root supervisor without a check identity' \
  --property=WorkingDirectory="$RUN/app" \
  --property=EnvironmentFile="$RUN/sup-red.env" \
  "$SERVICE_NODE_BIN/node" "$RUN/app/apps/supervisor/dist/main.js"
if ! wait_supervisor "$SUP_RED_PORT"; then
  journalctl -u "$SUP_RED_UNIT" -n 50 --no-pager >>"$EVIDENCE" 2>&1 || true
  echo 'red supervisor did not start' >&2
  exit 1
fi
run systemctl show "$SUP_RED_UNIT" -p User,Group,CapabilityBoundingSet,AmbientCapabilities,NoNewPrivileges --no-pager

red_json="$RUN/red.json"
printf '$ curl -sS -H "authorization: Bearer <redacted>" -H "content-type: application/json" -d %s http://127.0.0.1:%s/control/v1/instances/<repo>/review/checks\n' \
  "'{\"ticketId\":\"$TICKET\"}'" "$SUP_RED_PORT" >>"$EVIDENCE"
set +e
curl -sS -H "authorization: Bearer $SUP_TOKEN" -H 'content-type: application/json' \
  -d "{\"ticketId\":\"$TICKET\"}" \
  "http://127.0.0.1:$SUP_RED_PORT/control/v1/instances/$REPO_ID/review/checks" >"$red_json"
code=$?
set -e
printf '[exit code: %s]\n\n' "$code" >>"$EVIDENCE"
node -e '
const payload = require(process.argv[1]);
const runs = payload?.data?.runs;
if (!Array.isArray(runs)) { console.log(JSON.stringify(payload, null, 2)); process.exit(0); }
for (const run of runs) {
  console.log("command     :", run.command);
  console.log("exitCode    :", run.exitCode, "| passed:", run.passed, "| timedOut:", run.timedOut, "| ms:", run.durationMs);
  console.log("output      :");
  console.log(run.output);
  console.log("---");
}
' "$red_json" >>"$EVIDENCE" 2>&1
stop_unit "$SUP_RED_UNIT"

# ---------------------------------------------------------------------------
# 3. Green: the same supervisor as moyu-m5b, checks as moyu-check
# ---------------------------------------------------------------------------
log_section '3. 绿段：supervisor 非 root，仅 CAP_SETUID/CAP_SETGID，检查子进程切到专用 uid'
# The red supervisor ran as root and created its DSH directories owned by root;
# hand them to the green supervisor before it starts.
chown -R moyu-m5b:moyu-m5b "$RUN/dsh" "$RUN/logs" "$RUN/creds" "$RUN/env"
stop_unit "$SUP_UNIT"
run systemd-run --unit="$SUP_UNIT" \
  --description='MoYu #58 green: unprivileged supervisor with a dedicated check identity' \
  --property=User=moyu-m5b \
  --property=Group=moyu-m5b \
  --property=SupplementaryGroups=moyu-check \
  --property=WorkingDirectory="$RUN/app" \
  --property=EnvironmentFile="$RUN/sup-probe.env" \
  --property=NoNewPrivileges=yes \
  --property=PrivateTmp=yes \
  --property=ProtectSystem=strict \
  --property=ProtectHome=read-only \
  --property='CapabilityBoundingSet=CAP_SETUID CAP_SETGID' \
  --property='AmbientCapabilities=CAP_SETUID CAP_SETGID' \
  --property=UMask=0002 \
  --property="ReadWritePaths=$RUN/worktrees $RUN/check-home $RUN/sup-home $RUN/logs $RUN/dsh $RUN/creds $RUN/env" \
  "$SERVICE_NODE_BIN/node" "$RUN/app/apps/supervisor/dist/main.js"
if ! wait_supervisor "$SUP_GREEN_PORT"; then
  journalctl -u "$SUP_UNIT" -n 50 --no-pager >>"$EVIDENCE" 2>&1 || true
  echo 'green supervisor did not start' >&2
  exit 1
fi
run systemctl show "$SUP_UNIT" \
  -p User,Group,SupplementaryGroups,NoNewPrivileges,ProtectSystem,PrivateTmp,CapabilityBoundingSet,AmbientCapabilities --no-pager

green_json="$RUN/green.json"
printf '$ curl -sS -H "authorization: Bearer <redacted>" -H "content-type: application/json" -d %s http://127.0.0.1:%s/control/v1/instances/<repo>/review/checks\n' \
  "'{\"ticketId\":\"$TICKET\"}'" "$SUP_GREEN_PORT" >>"$EVIDENCE"
set +e
curl -sS -H "authorization: Bearer $SUP_TOKEN" -H 'content-type: application/json' \
  -d "{\"ticketId\":\"$TICKET\"}" \
  "http://127.0.0.1:$SUP_GREEN_PORT/control/v1/instances/$REPO_ID/review/checks" >"$green_json"
code=$?
set -e
printf '[exit code: %s]\n\n' "$code" >>"$EVIDENCE"
node -e '
const payload = require(process.argv[1]);
const runs = payload?.data?.runs;
if (!Array.isArray(runs)) { console.log(JSON.stringify(payload, null, 2)); process.exit(0); }
for (const run of runs) {
  console.log("command     :", run.command);
  console.log("exitCode    :", run.exitCode, "| passed:", run.passed, "| timedOut:", run.timedOut, "| ms:", run.durationMs);
  console.log("output      :");
  console.log(run.output);
  console.log("---");
}
' "$green_json" >>"$EVIDENCE" 2>&1
run sh -c "ps -eo pid,ppid,uid,gid,cmd | grep -E 'moyu-check|setpriv' | grep -v grep || true"
run sh -c "test -w '$RUN/check-home' && echo 'check HOME writable: yes'; cat '$SENTINEL' 2>&1 || true"

# ---------------------------------------------------------------------------
# 4. Green: a real pnpm check through the same identity
# ---------------------------------------------------------------------------
log_section '4. 绿段：真实 `pnpm check` 由检查身份执行，exit 0，耗时与产物正常'
stop_unit "$SUP_UNIT"
run systemd-run --unit="$SUP_UNIT" \
  --description='MoYu #58 green: real pnpm check under the dedicated identity' \
  --property=User=moyu-m5b --property=Group=moyu-m5b \
  --property=SupplementaryGroups=moyu-check \
  --property=WorkingDirectory="$RUN/app" \
  --property=EnvironmentFile="$RUN/sup-check.env" \
  --property=NoNewPrivileges=yes --property=PrivateTmp=yes \
  --property=ProtectSystem=strict --property=ProtectHome=read-only \
  --property='CapabilityBoundingSet=CAP_SETUID CAP_SETGID' \
  --property='AmbientCapabilities=CAP_SETUID CAP_SETGID' \
  --property=UMask=0002 \
  --property="ReadWritePaths=$RUN/worktrees $RUN/check-home $RUN/sup-home $RUN/logs $RUN/dsh $RUN/creds $RUN/env" \
  "$SERVICE_NODE_BIN/node" "$RUN/app/apps/supervisor/dist/main.js"
if ! wait_supervisor "$SUP_GREEN_PORT"; then
  journalctl -u "$SUP_UNIT" -n 50 --no-pager >>"$EVIDENCE" 2>&1 || true
  echo 'green supervisor did not start' >&2
  exit 1
fi
pnpm_json="$RUN/pnpm-check.json"
printf '$ curl -sS -H "authorization: Bearer <redacted>" -H "content-type: application/json" -d %s http://127.0.0.1:%s/control/v1/instances/<repo>/review/checks\n' \
  "'{\"ticketId\":\"$TICKET\"}'" "$SUP_GREEN_PORT" >>"$EVIDENCE"
START=$(date +%s)
set +e
curl -sS -H "authorization: Bearer $SUP_TOKEN" -H 'content-type: application/json' \
  -d "{\"ticketId\":\"$TICKET\"}" \
  "http://127.0.0.1:$SUP_GREEN_PORT/control/v1/instances/$REPO_ID/review/checks" >"$pnpm_json"
code=$?
set -e
END=$(date +%s)
printf '[exit code: %s; wall clock: %ss]\n\n' "$code" "$((END - START))" >>"$EVIDENCE"
node -e '
const payload = require(process.argv[1]);
for (const run of payload?.data?.runs ?? []) {
  console.log("command     :", run.command);
  console.log("exitCode    :", run.exitCode, "| passed:", run.passed, "| timedOut:", run.timedOut, "| ms:", run.durationMs);
  console.log("summary     :", run.summary);
  console.log("output tail :");
  console.log(run.output.split("\n").slice(-15).join("\n"));
}
' "$pnpm_json" >>"$EVIDENCE" 2>&1
run sh -c "ls -l '$WORKTREE/apps/api/dist/server.js' '$WORKTREE/apps/web/dist/index.html' 2>&1 || true"
run sh -c "du -sh '$RUN/check-home' && find '$RUN/check-home' -maxdepth 2 -printf '%M %u %g %p\\n' | head -20"

# ---------------------------------------------------------------------------
# 5. The API under the hardened unit, readyz, attachment round-trip, panel
# ---------------------------------------------------------------------------
log_section '5. 服务加固预演：非 root API unit 的 readyz、附件上传下载、检查面板三段'
stop_unit "$API_UNIT"
run systemd-run --unit="$API_UNIT" \
  --description='MoYu #58 rehearsal: hardened web shell unit' \
  --property=User=moyu-web --property=Group=moyu-web \
  --property=WorkingDirectory="$RUN/app" \
  --property=EnvironmentFile="$RUN/api.env" \
  --property=StateDirectory=moyu-rehearsal --property=LogsDirectory=moyu-rehearsal \
  --property=NoNewPrivileges=yes --property=PrivateTmp=yes --property=PrivateDevices=yes \
  --property=ProtectSystem=strict --property=ProtectHome=yes \
  --property=ProtectKernelTunables=yes --property=ProtectKernelModules=yes \
  --property=ProtectControlGroups=yes --property=ProtectClock=yes --property=ProtectHostname=yes \
  --property='RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
  --property=RestrictNamespaces=yes --property=RestrictSUIDSGID=yes --property=LockPersonality=yes \
  --property=CapabilityBoundingSet= --property=AmbientCapabilities= --property=UMask=0077 \
  "$SERVICE_NODE_BIN/node" apps/api/dist/server.js
if ! wait_api; then
  journalctl -u "$API_UNIT" -n 80 --no-pager >>"$EVIDENCE" 2>&1 || true
  echo 'rehearsal API did not start' >&2
  exit 1
fi
run systemctl show "$API_UNIT" \
  -p User,Group,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp,PrivateDevices,CapabilityBoundingSet,AmbientCapabilities,RestrictNamespaces,RestrictSUIDSGID --no-pager
run curl -sS -D - "http://127.0.0.1:$API_PORT/readyz"

python3 - "$RUN" <<'PY'
import base64, pathlib, sys
run = pathlib.Path(sys.argv[1])
(run / 'upload.png').write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))
PY
upload_json="$RUN/upload.json"
printf '$ curl -sS -b "moyu_session=<redacted>" -F "file=@upload.png;type=image/png" http://127.0.0.1:%s/api/v1/conversations/<conversation>/attachments\n' "$API_PORT" >>"$EVIDENCE"
code=$(curl -sS -o "$upload_json" -w '%{http_code}' -b "moyu_session=$TOKEN" \
  -F "file=@$RUN/upload.png;type=image/png" \
  "http://127.0.0.1:$API_PORT/api/v1/conversations/$CONVERSATION_ID/attachments")
printf 'HTTP %s\n' "$code" >>"$EVIDENCE"
node -e 'const r=require(process.argv[1]); console.log(JSON.stringify(r.data.attachment, null, 2))' "$upload_json" >>"$EVIDENCE" 2>&1
ATTACHMENT_ID=$(node -e 'process.stdout.write(require(process.argv[1]).data.attachment.id)' "$upload_json")
printf '$ curl -sS -b "moyu_session=<redacted>" -o dl.png http://127.0.0.1:%s/api/v1/attachments/%s\n' "$API_PORT" "$ATTACHMENT_ID" >>"$EVIDENCE"
curl -sS -b "moyu_session=$TOKEN" -o "$RUN/dl.png" \
  "http://127.0.0.1:$API_PORT/api/v1/attachments/$ATTACHMENT_ID"
run sh -c "sha256sum '$RUN/upload.png' '$RUN/dl.png'; cmp '$RUN/upload.png' '$RUN/dl.png' && echo 'byte-identical: yes'"

run_checks_api() {
  local label=$1 out=$2
  printf '\n### %s\n' "$label" >>"$EVIDENCE"
  printf '$ curl -sS -b "moyu_session=<redacted>" -H "content-type: application/json" -d {} http://127.0.0.1:%s/api/v1/tasks/<task>/review/checks\n' "$API_PORT" >>"$EVIDENCE"
  local code
  code=$(curl -sS -o "$out" -w '%{http_code}' -b "moyu_session=$TOKEN" \
    -H 'content-type: application/json' -d '{}' \
    "http://127.0.0.1:$API_PORT/api/v1/tasks/$TASK_ID/review/checks")
  printf 'HTTP %s\n' "$code" >>"$EVIDENCE"
  node -e '
const payload = require(process.argv[1]);
const checks = payload?.data?.review?.checks;
if (!checks) { console.log(JSON.stringify(payload, null, 2)); process.exit(0); }
console.log("state:", checks.state, "| collectedAt:", checks.collectedAt);
for (const run of checks.runs ?? []) {
  console.log("command     :", run.command);
  console.log("exitCode    :", run.exitCode, "| passed:", run.passed, "| timedOut:", run.timedOut, "| ms:", run.durationMs);
  console.log("summary     :", run.summary);
  console.log("output tail :", (run.output ?? "").split("\n").slice(-10).join("\n"));
  console.log("---");
}
' "$out" >>"$EVIDENCE" 2>&1
}

run_checks_api '5.1 通过' "$RUN/panel-pass1.json"
printf "export const broken: number = 'm6a deliberate type failure';\n" >"$WORKTREE/apps/api/src/m6a-broken.ts"
# The operator creates this file as root; the check user must be able to read
# it, or the run fails on EACCES before reaching the deliberate type error.
chmod 0644 "$WORKTREE/apps/api/src/m6a-broken.ts"
run_checks_api '5.2 失败（故意改坏类型）' "$RUN/panel-fail.json"
rm -f "$WORKTREE/apps/api/src/m6a-broken.ts"
run_checks_api '5.3 恢复后通过' "$RUN/panel-pass2.json"

log_section '6. Unit diff 与回滚'
run systemctl cat moyu.service
set +e
diff -u /etc/systemd/system/moyu.service "$REPO/deploy/systemd/moyu.service" >>"$EVIDENCE" 2>&1
code=$?
set -e
printf '[diff exit code: %s（1 = 有差异，符合预期）]\n\n' "$code" >>"$EVIDENCE"
{
  printf '回滚（owner 执行）：\n'
  printf '  install -m 0644 <上一版 moyu.service 备份> /etc/systemd/system/moyu.service\n'
  printf '  systemctl daemon-reload\n'
  printf '  systemctl restart moyu.service\n'
  printf '  curl -fsS http://127.0.0.1:4300/readyz\n\n'
  printf '本脚本未执行上面三条 systemctl 命令。\n\n'
} >>"$EVIDENCE"

log_section '7. 未验证项'
{
  printf '1. live `moyu.service`（4300）未重启；本文件只预演了同一组 unit 指令。\n'
  printf '2. 生产用户的 `/opt/moyu/web`、`/etc/moyu/moyu.env` 与 `moyu-check` 组/目录由 owner 按 deploy/systemd/README.md 创建。\n'
  printf '3. 真实 DSH runtime 实例未启动；检查的 worktree 是真实 git clone，命令是真实 `pnpm check`。\n'
  printf '4. 未在 3082 bootstrap 实例上做任何变更。\n'
} >>"$EVIDENCE"
printf '\n证据写入 %s\n' "$EVIDENCE"
