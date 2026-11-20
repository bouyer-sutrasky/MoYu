#!/usr/bin/env bash
# M5-B 遗留第 4 步 — 暂停停止证据超时后的重新核对与恢复（Web + 独立 GitHub 身份）。
#
# 在 scripts/m5b/matrix/stack.sh 刚启动的隔离栈上运行（#92 的隔离环境）。脚本只读生产 3082 之外
# 这轮栈自己的 API、PostgreSQL、Bridge 与 runtime 制品；不打印任何凭据，关键断言失败时退出非零。
#
#   scripts/m5b/matrix/stack.sh up
#   scripts/m5b/matrix/item4-pause-recheck.sh all
#
# 强制超时阶段需要一个把停止上限缩短到 1 ms 的测试栈：按 #92 的方式启动 runtime 时设置
#   MOYU_TEST_HOOKS=1 MOYU_TEST_PAUSE_LAUNCH_MS=1
# 并给本脚本 M5B_MATRIX_FORCE_LAUNCH_TIMEOUT=1（否则该阶段记 SKIP，不伪报通过）。
#
# GitHub 阶段需要所有者独立签发的探测身份令牌，通过受限输入传入：
#   M5B_MATRIX_PROBE_GH_TOKEN_FILE=<0600 权限、仅所有者可读的文件>
#   M5B_MATRIX_PROBE_LOGIN=<该身份 login，必须不是 Bouyer12>
#   M5B_MATRIX_REPOSITORY=<被测仓库 owner/name>
#   M5B_MATRIX_GITHUB_ISSUE=<上面仓库里的 issue/PR 编号>
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"
# stack.sh 把这轮的真实数据库、会话和 Bridge 值写在这里。
[[ -n ${M5B_BRIDGE_URL:-} ]] || { set -a; . "$M5B_MATRIX_STATE"; set +a; }

PHASE=${1:-all}
LIVE="node $M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs"
SESSIONS=$M5B_MATRIX_DSH_HOME/sessions
PROFILE_LINK=$M5B_MATRIX_DSH_HOME/profiles/$M5B_MATRIX_PROFILE/node_modules/dsh-superagent
OPERATIONS=$M5B_MATRIX_DSH_HOME/state/$M5B_MATRIX_PROFILE/bridge/operations.jsonl
PATCH=$M5B_MATRIX_ROOT/integrations/superagent/patches/0031-pause-recheck.patch
AGENT_LOGIN=${M5B_MATRIX_AGENT_LOGIN:-Bouyer12}

CHECKS=0
FAILS=0
SKIPS=0
CREATED_TASKS=()

say() { printf '%s\n' "$*"; }
pass() { CHECKS=$((CHECKS + 1)); printf '  PASS %s\n' "$*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); printf '  FAIL %s\n' "$*" >&2; }
skip() { SKIPS=$((SKIPS + 1)); printf '  SKIP %s\n' "$*"; }
eq() {
  local label=$1 want=$2 got=$3
  if [[ "$want" == "$got" ]]; then pass "$label = $got"; else fail "$label: want [$want] got [$got]"; fi
}
contains() {
  local label=$1 needle=$2 haystack=$3
  if [[ "$haystack" == *"$needle"* ]]; then pass "$label contains $needle"; else fail "$label: [$haystack] does not contain [$needle]"; fi
}

# --- 制品与凭据 -------------------------------------------------------------
say "# item4 — pause stop recheck (${PHASE})"
say "recorded=$(date -Is)"
say "runtime_loaded=$(readlink -f "$PROFILE_LINK" 2>/dev/null)"
say "runtime_artifact=$(sha256sum "$(readlink -f "$PROFILE_LINK" 2>/dev/null)/lib/index.js" 2>/dev/null | cut -d' ' -f1)"
say "dispatcher_artifact=$(sha256sum "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js" 2>/dev/null | cut -d' ' -f1)"
say "api_artifact=$(sha256sum "$M5B_MATRIX_ROOT/apps/api/dist/server.js" 2>/dev/null | cut -d' ' -f1)"
say "patch_artifact=$(sha256sum "$PATCH" 2>/dev/null | cut -d' ' -f1)"
say "script_artifact=$(sha256sum "$0" | cut -d' ' -f1)"

PROBE_TOKEN=''
cleanup() { PROBE_TOKEN=''; }
trap cleanup EXIT

read_probe_credential() {
  local file=${M5B_MATRIX_PROBE_GH_TOKEN_FILE:-}
  if [[ -z $file ]]; then
    fail "M5B_MATRIX_PROBE_GH_TOKEN_FILE is required for the GitHub phase (owner-issued probe identity)"
    return 1
  fi
  if [[ ! -f $file ]]; then
    fail "probe credential file is missing: $file"
    return 1
  fi
  local mode owner
  mode=$(stat -c '%a' "$file")
  owner=$(stat -c '%U' "$file")
  if (( (8#$mode & 077) != 0 )); then
    fail "probe credential file mode $mode is group/other-readable; restrict it to 0600"
    return 1
  fi
  if [[ $owner != "$(id -un)" && $owner != root ]]; then
    fail "probe credential file owner $owner is neither this user nor root"
    return 1
  fi
  # The token is read through the restricted file and never echoed or written to the log.
  PROBE_TOKEN=$(<"$file")
  if [[ -z $PROBE_TOKEN ]]; then
    fail "probe credential file is empty"
    return 1
  fi
  say "probe_credential=restricted mode=$mode owner=$owner"
}

probe_gh() { GH_TOKEN=$PROBE_TOKEN gh "$@"; }

# --- 数据库与 runtime 读取（只读） -----------------------------------------
sql() { m5b_sql "$1"; }
task_state() { sql "select state from task_links where id='$1'"; }
task_version() { sql "select version from task_links where id='$1'"; }
task_ticket() { sql "select coalesce(upstream_ticket_id,'') from task_links where id='$1'"; }
task_evidence() { sql "select stop_evidence::text from task_links where id='$1'"; }
task_lease() { sql "select coalesce(runtime_lease_id::text,'') from task_links where id='$1'"; }
lease_state() { sql "select state from runtime_leases where id='$1'"; }

task_field() {
  sql "select coalesce(stop_evidence->>'$2','') from task_links where id='$1'"
}

runtime_ticket() {
  local ticket=$1
  python3 - "$M5B_BRIDGE_URL" "$M5B_BRIDGE_TOKEN" "$ticket" <<'PY'
import json, sys, urllib.request
url, token, ticket = sys.argv[1], sys.argv[2], sys.argv[3]
request = urllib.request.Request(f'{url}/bridge/v1/tickets/{ticket}', headers={'authorization': 'Bearer ' + token})
body = json.load(urllib.request.urlopen(request))
paused = body.get('paused') or {}
print(json.dumps({
    'state': body.get('state'),
    'assignmentId': body.get('assignmentId'),
    'assignments': [{'id': item.get('id'), 'state': item.get('state'), 'startedAt': item.get('startedAt')}
                    for item in body.get('assignments') or []],
    'paused': {key: paused.get(key) for key in ('operationId', 'stoppedAt', 'error') if paused.get(key) is not None},
    'evidence': paused.get('evidence') or {},
    'execution': body.get('execution') or None,
}, sort_keys=True))
PY
}

worker_sessions() {
  ls -d "$SESSIONS"/*/worker-"$1" 2>/dev/null | wc -l
}

wait_state() {
  local task=$1 want=$2 timeout=${3:-120}
  local deadline=$(( $(date +%s) + timeout ))
  while (( $(date +%s) < deadline )); do
    [[ $(task_state "$task") == "$want" ]] && return 0
    sleep 0.5
  done
  return 1
}

wait_ticket() {
  local task=$1 timeout=${2:-120}
  local deadline=$(( $(date +%s) + timeout ))
  while (( $(date +%s) < deadline )); do
    [[ -n $(task_ticket "$task") ]] && return 0
    sleep 0.25
  done
  return 1
}

new_task() {
  local label=$1 out task
  out=$($LIVE new-task --text "item4 $label" --client-request-id "item4-${label}-$(date +%s%N)") || true
  task=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("taskId", ""))' 2>/dev/null || true)
  [[ -n $task ]] || { fail "new task ($label) did not return a task id: $out"; return 1; }
  CREATED_TASKS+=("$task")
  wait_ticket "$task" 120 || { fail "new task ($label) never got a runtime ticket"; return 1; }
  printf '%s' "$task"
}

# Bounded pause: the dispatcher may not have recorded the ticket yet, which is a stale version and not a product answer.
pause_command() {
  local task=$1 attempt
  for attempt in $(seq 1 12); do
    if $LIVE pause --task "$task" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  return 1
}

resume_command() {
  local task=$1
  $LIVE resume --task "$task" >/dev/null 2>&1
}

# --- 场景 -------------------------------------------------------------------
phase_before_start() {
  say "## web: pause before the worker starts"
  local task ticket state evidence
  task=$(new_task before) || return
  # 票刚创建就暂停：launch 可能还在队列或 prepare 中，属于「启动前/启动中」。
  pause_command "$task" || { fail "pause was refused for $task"; return; }
  wait_state "$task" stopped 120 || { fail "task $task did not reach stopped (state=$(task_state "$task"))"; return; }
  ticket=$(task_ticket "$task")
  state=$(task_state "$task")
  eq "before: platform state" stopped "$state"
  eq "before: platform stopped_at present" 1 "$(sql "select (stopped_at is not null)::int from task_links where id='$task'")"
  evidence=$(task_evidence "$task")
  contains "before: evidence launch recorded" '"launch"' "$evidence"
  local op; op=$(task_field "$task" operationId)
  eq "before: evidence names the pause operation" 1 "$([[ -n $op ]] && echo 1 || echo 0)"
  say "  worker_sessions=$(worker_sessions "$ticket") lease=$(task_lease "$task")"
  # 继续：只创建一代新 Assignment，重复 resume 不再生效。
  local before_assignments after_assignments
  before_assignments=$(runtime_ticket "$ticket" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["assignments"]))')
  resume_command "$task" || { fail "resume was refused for $task"; return; }
  wait_state "$task" queued 60 || wait_state "$task" running 60 || { fail "resume did not queue $task"; return; }
  after_assignments=$(runtime_ticket "$ticket" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["assignments"]))')
  eq "before: one resume creates one Assignment" $((before_assignments + 1)) "$after_assignments"
  if resume_command "$task"; then fail "a second resume was accepted for a task that is no longer stopped"; else pass "a second resume is refused"; fi
}

phase_after_start() {
  say "## web: pause after the worker is running"
  local task ticket
  task=$(new_task after) || return
  if ! $LIVE wait --task "$task" --state running --timeout 180000 >/dev/null 2>&1; then
    fail "task $task never reached running before the after-start pause"
    return
  fi
  ticket=$(task_ticket "$task")
  [[ $(worker_sessions "$ticket") -ge 1 ]] && pass "after: worker Session exists" || fail "after: no worker Session for $ticket"
  pause_command "$task" || { fail "after-start pause was refused"; return; }
  wait_state "$task" stopped 120 || { fail "task $task did not stop (state=$(task_state "$task"))"; return; }
  local evidence agent jobs
  evidence=$(task_evidence "$task")
  agent=$(task_field "$task" agentStatus)
  jobs=$(printf '%s' "$evidence" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("jobsAfter", [])))' 2>/dev/null || echo '?')
  eq "after: worker idle or absent" 1 "$([[ $agent == idle || $agent == absent ]] && echo 1 || echo 0)"
  eq "after: no background job remains" 0 "$jobs"
}

phase_forced_timeout() {
  say "## web: forced launch-abort timeout, stop check, one resume"
  if [[ ${M5B_MATRIX_FORCE_LAUNCH_TIMEOUT:-0} != 1 ]]; then
    if [[ ${M5B_MATRIX_REQUIRE_FORCED:-0} == 1 ]]; then
      fail "forced-timeout phase was required but the stack was not booted with MOYU_TEST_HOOKS=1 MOYU_TEST_PAUSE_LAUNCH_MS=1"
    else
      skip "forced launch-timeout phase needs a stack booted with MOYU_TEST_HOOKS=1 MOYU_TEST_PAUSE_LAUNCH_MS=1"
    fi
    return
  fi
  local task='' attempt found=0
  for attempt in $(seq 1 6); do
    task=$(new_task "timeout-$attempt") || return
    pause_command "$task" || { fail "forced: pause refused on attempt $attempt"; return; }
    if wait_state "$task" blocked 60; then found=1; break; fi
    # The shortened bound is a race: a stop that still landed in time is not the branch under test.
    wait_state "$task" stopped 30 || true
  done
  (( found == 1 )) || { fail "forced: no pause reached the timed-out/blocked branch after 6 attempts"; return; }
  local ticket evidence next
  ticket=$(task_ticket "$task")
  evidence=$(task_evidence "$task")
  next=$(task_field "$task" nextStep)
  eq "forced: blocked placeholder keeps the next step" recheck-stop "$next"
  eq "forced: blocked task is not stopped" '' "$(sql "select coalesce(stopped_at::text,'') from task_links where id='$task'")"
  contains "forced: evidence records the launch timeout" 'timed-out' "$evidence"
  local lease; lease=$(task_lease "$task")
  eq "forced: the retained lease stays active" active "$(lease_state "$lease")"
  say "  recheck_operation=$(task_field "$task" pauseOperationId) lease=$lease"
  # 重新核对原暂停操作：成功即原子结清并释放该代次租约。
  pause_command "$task" || { fail "forced: stop check was refused"; return; }
  wait_state "$task" stopped 120 || { fail "forced: stop check did not settle (state=$(task_state "$task"), next=$(task_field "$task" nextStep))"; return; }
  evidence=$(task_evidence "$task")
  eq "forced: evidence names this ticket" "$ticket" "$(printf '%s' "$evidence" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ticketId",""))')"
  eq "forced: evidence binds the lease generation" "$lease" "$(printf '%s' "$evidence" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("leaseId",""))')"
  eq "forced: task released the generation" '' "$(task_lease "$task")"
  eq "forced: lease released" released "$(lease_state "$lease")"
  local before after
  before=$(runtime_ticket "$ticket" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["assignments"]))')
  resume_command "$task" || { fail "forced: resume after the stop proof was refused"; return; }
  wait_state "$task" queued 60 || wait_state "$task" running 60 || { fail "forced: resume did not start the original task"; return; }
  after=$(runtime_ticket "$ticket" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["assignments"]))')
  eq "forced: resume starts the original task once" $((before + 1)) "$after"
  if resume_command "$task"; then fail "forced: repeated resume was accepted"; else pass "forced: repeated resume is refused"; fi
}

phase_github() {
  say "## github: independent probe identity pauses, checks and resumes"
  read_probe_credential || return
  local login
  login=$(probe_gh api user --jq .login 2>/dev/null || true)
  eq "github: probe identity is independent" 1 "$([[ -n $login && $login != "$AGENT_LOGIN" ]] && echo 1 || echo 0)"
  say "  probe_identity=$login agent_identity=$AGENT_LOGIN"
  if [[ -n ${M5B_MATRIX_PROBE_LOGIN:-} && $login != "$M5B_MATRIX_PROBE_LOGIN" ]]; then
    fail "github: probe identity is $login, not the expected $M5B_MATRIX_PROBE_LOGIN"
    return
  fi
  local repo=${M5B_MATRIX_REPOSITORY:-} issue=${M5B_MATRIX_GITHUB_ISSUE:-}
  if [[ -z $repo || -z $issue ]]; then
    fail "github: M5B_MATRIX_REPOSITORY and M5B_MATRIX_GITHUB_ISSUE are required"
    return
  fi
  # 独立身份 @ agent：这条评论由探测身份发出，不是 agent 自己的评论。
  probe_gh issue comment "$issue" --repo "$repo" --body "@$AGENT_LOGIN item4 pause/recheck probe $(date -Is)" >/dev/null \
    || { fail "github: probe identity could not comment on $repo#$issue"; return; }
  local task='' deadline
  deadline=$(( $(date +%s) + 180 ))
  while (( $(date +%s) < deadline )); do
    task=$(sql "select t.id from task_links t join conversations c on c.id=t.conversation_id
                 where c.source='github' and c.external_key like '%$issue' order by t.created_at desc limit 1")
    [[ -n $task ]] && break
    sleep 1
  done
  [[ -n $task ]] || { fail "github: no imported task appeared for $repo#$issue"; return; }
  CREATED_TASKS+=("$task")
  wait_ticket "$task" 180 || { fail "github: imported task has no runtime ticket"; return; }
  pause_command "$task" || { fail "github: pause was refused"; return; }
  wait_state "$task" stopped 180 || { fail "github: imported task did not stop (state=$(task_state "$task"))"; return; }
  local evidence ticket
  ticket=$(task_ticket "$task")
  evidence=$(task_evidence "$task")
  contains "github: evidence records a launch phase" '"launch"' "$evidence"
  contains "github: evidence names the operation" '"operationId"' "$evidence"
  say "  github_state=stopped ticket=$ticket evidence=$(printf '%s' "$evidence" | cut -c1-240)"
  resume_command "$task" || { fail "github: resume was refused"; return; }
  wait_state "$task" queued 60 || wait_state "$task" running 60 || { fail "github: resume did not start the imported task"; return; }
  pass "github: resume started the imported task"
}

case "$PHASE" in
  web) phase_before_start; phase_after_start ;;
  forced) phase_forced_timeout ;;
  github) phase_github ;;
  all) phase_before_start; phase_after_start; phase_forced_timeout; phase_github ;;
  *) echo "usage: $0 [web|forced|github|all]" >&2; exit 2 ;;
esac

say
say "# summary: checks=${CHECKS} failed=${FAILS} skipped=${SKIPS} tasks=${#CREATED_TASKS[@]}"
if (( FAILS > 0 )); then
  say "# RESULT: FAIL"
  exit 1
fi
say "# RESULT: PASS"
exit 0
