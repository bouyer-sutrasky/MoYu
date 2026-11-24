#!/usr/bin/env bash
# M5-B matrix item 5 — the awaiting_review sub-state under the criterion the owner
# ruled: a ticket that follows a real open PR.
#
# Flow (all real entrances):
#   1. a task is created through the owner API;
#   2. the worker's turn runs a real `git push` of its ticket branch (fixture);
#   3. the harness opens a real draft PR from that branch in the TEST repository;
#   4. the worker reports `state=ready` with that `pr_number`, so the runtime claims
#      the PR thread and the ticket stays open -> `awaiting_review`;
#   5. the PR is CLOSED (never merged) and the ticket must end as `closed_unmerged`.
#
#   scripts/m5b/matrix/item5-awaiting-review.sh
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

RUN=$M5B_MATRIX_RUN
FIXTURE_REPO=${M5B_MATRIX_FIXTURE_REPO:-Bouyer12/m5a-beta-adf10ad9}
OPEN_PR_FILE="$M5B_MATRIX_CONTROL/open-pr.txt"
PR_NUMBER_FILE="$M5B_MATRIX_CONTROL/pr-number.txt"
LIVE="node $M5B_MATRIX_ROOT/scripts/m5b/matrix/live.mjs"

fail() {
  echo "FAIL: $*"
  exit 1
}

gh_agent() {
  # The matrix uses its dedicated probe-only gh configuration, never the
  # shared /root/.config/gh-agent token.
  "$M5B_MATRIX_GH_CLI" "$@"
}

ticket_json() {
  python3 - "$M5B_BRIDGE_URL" "$M5B_BRIDGE_TOKEN" "$1" <<'PYRUN'
import json, sys, urllib.request
url, token, ticket = sys.argv[1], sys.argv[2], sys.argv[3]
request = urllib.request.Request(f'{url}/bridge/v1/tickets/{ticket}',
                                 headers={'authorization': 'Bearer ' + token})
print(json.dumps(json.load(urllib.request.urlopen(request)), indent=2))
PYRUN
}

ticket_field() {
  python3 - "$M5B_BRIDGE_URL" "$M5B_BRIDGE_TOKEN" "$1" "$2" <<'PYRUN'
import json, sys, urllib.request
url, token, ticket, field = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
request = urllib.request.Request(f'{url}/bridge/v1/tickets/{ticket}',
                                 headers={'authorization': 'Bearer ' + token})
value = json.load(urllib.request.urlopen(request))
for part in field.split('.'):
    value = (value or {}).get(part) if isinstance(value, dict) else None
print('' if value is None else value)
PYRUN
}

echo "# item 5 — awaiting_review with a real open PR (criterion change accepted by the owner)"
echo "recorded=$(date -Is)"
echo "head=$(cd "$M5B_MATRIX_ROOT" && git rev-parse HEAD)"
echo "dispatcher_artifact=$(sha256sum "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js" | cut -d' ' -f1) ($(stat -c %s "$M5B_MATRIX_ROOT/apps/dispatcher/dist/main.js") bytes)"
echo "fixture_repository=${FIXTURE_REPO} (test repository only; never the MoYu repository)"
echo

echo "## the worker fixture: push its ticket branch"
echo "script=scripts/m5b/matrix/fixture-open-pr.sh (push only; the PR is opened by the harness)"
# Root writes the fixture pointer in its own control directory; the provider
# reads it. pr-number is written by the provider (matrix identity); root only
# removes a stale entry as that identity, never by writing/chmod-ing it.
printf '%s\n' "$M5B_MATRIX_ROOT/scripts/m5b/matrix/fixture-open-pr.sh" >"$OPEN_PR_FILE"
chmod 0644 "$OPEN_PR_FILE"
rm -f "$PR_NUMBER_FILE"
echo "open_pr_fixture=$(cat "$OPEN_PR_FILE")"
echo

echo "## create the ticket through the real owner API"
CREATED=$($LIVE new-task --text "Matrix awaiting_review probe: push a branch, open a PR, claim it and report ready." \
  --client-request-id "item5-review-$(date +%s)")
echo "$CREATED"
TASK=$(printf '%s' "$CREATED" | python3 -c 'import json,sys;print(json.load(sys.stdin)["taskId"])')
echo

echo "## wait for the ticket"
TICKET=""
for _ in $(seq 1 120); do
  TICKET=$(m5b_sql "select coalesce(upstream_ticket_id,'') from task_links where id='$TASK'")
  [[ -n $TICKET ]] && break
  sleep 1
done
[[ -n $TICKET ]] || fail "the runtime never created a ticket (task state: $(m5b_sql "select state from task_links where id='$TASK'"))"
echo "ticket=$TICKET"
TICKET_NAME=$(ticket_field "$TICKET" execution.name)
BRANCH="agent/${TICKET_NAME}"
echo "ticket_name=${TICKET_NAME}"
echo "ticket_branch=${BRANCH}"
echo

echo "## wait for the worker's push, then open a real draft PR from that branch"
PR=""
for _ in $(seq 1 180); do
  PR=$(gh_agent pr list --repo "$FIXTURE_REPO" --head "$BRANCH" --state open \
    --json number --jq '.[0].number // empty' 2>/dev/null || true)
  if [[ -z $PR ]]; then
    if gh_agent api "repos/${FIXTURE_REPO}/branches/${BRANCH}" >/dev/null 2>&1; then
      echo "\$ gh pr create --repo ${FIXTURE_REPO} --head ${BRANCH} --base main --draft"
      gh_agent pr create --repo "$FIXTURE_REPO" --head "$BRANCH" --base main --draft \
        --title "m5b-matrix-fixture: awaiting_review probe" \
        --body "矩阵取证用（M5-B item 5 awaiting_review）。会被删除，不合并。This is by an automated agent, not a human." \
        >/dev/null 2>&1 || true
      PR=$(gh_agent pr list --repo "$FIXTURE_REPO" --head "$BRANCH" --state open \
        --json number --jq '.[0].number // empty' 2>/dev/null || true)
    fi
  fi
  if [[ -n $PR ]]; then
    printf '%s\n' "$PR" >"$PR_NUMBER_FILE"
    # The provider runs as the matrix identity and must read this control file.
    chmod 0644 "$PR_NUMBER_FILE"
    break
  fi
  sleep 2
done
if [[ -z $PR ]]; then
  echo "## no PR after the wait; stopping and reporting the blocker"
  ticket_json "$TICKET" | head -40
  fail "no PR was opened from ${BRANCH}; the ticket is not awaiting_review and no state is claimed"
fi
echo "fixture_pr=${PR}"
gh_agent pr view "$PR" --repo "$FIXTURE_REPO" --json number,state,isDraft,headRefName,url 2>&1 | tail -3
echo

echo "## wait for awaiting_review"
STATE=""
for _ in $(seq 1 180); do
  STATE=$(ticket_field "$TICKET" state)
  [[ $STATE == awaiting_review ]] && break
  [[ $STATE == completed || $STATE == closed_unmerged ]] && break
  sleep 1
done
echo "runtime_ticket_state=${STATE}"
echo "## raw ticket snapshot while awaiting review"
ticket_json "$TICKET" | tee "$RUN/ticket-awaiting-review.json"
echo

if [[ ${M5B_MATRIX_RESTART_BEFORE_CLOSE:-0} == 1 && $STATE == awaiting_review ]]; then
  SUP_TOKEN=$(m5b_protected_read supervisor-token)
  supervisor_call() {
    curl -sS -X "$1" -H "authorization: Bearer ${SUP_TOKEN}" -H 'content-type: application/json' \
      -d "${3:-{\}}" "http://127.0.0.1:${M5B_MATRIX_SUP_PORT}$2"
  }
  instance_pid() {
    supervisor_call GET "/control/v1/instances/${M5B_REPOSITORY_ID}" |
      python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["pid"] or "")'
  }
  count_rows() { m5b_sql "select count(*) from $1 where $2"; }
  PR_URL_BEFORE=$(ticket_field "$TICKET" pr.url)
  PR_NUM_BEFORE=$(ticket_field "$TICKET" pr.number)
  ASSIGNMENT_BEFORE=$(ticket_field "$TICKET" assignmentId)
  OPERATIONS_BEFORE=$(count_rows task_operations "task_id='$TASK'")
  DELIVERIES_BEFORE=$(count_rows deliveries "message_id in (select id from messages where conversation_id=(select conversation_id from task_links where id='$TASK'))")
  BRIDGE_PID_BEFORE=$(instance_pid)
  DISPATCHER_PID_BEFORE=$(m5b_unit_pid "${M5B_MATRIX_SLICE%.slice}-dispatcher.service")
  PR_BEFORE=$(gh_agent pr view "$PR" --repo "$FIXTURE_REPO" --json number,state,isDraft,headRefName,url --jq '.')
  echo "## restart Bridge, dispatcher and both databases while awaiting_review"
  echo "before: bridge=${BRIDGE_PID_BEFORE} dispatcher=${DISPATCHER_PID_BEFORE} assignment=${ASSIGNMENT_BEFORE} operations=${OPERATIONS_BEFORE} deliveries=${DELIVERIES_BEFORE} pr=${PR_BEFORE}"
  echo '$ supervisor sleep --manual (idle assignment stops with its cgroup)'
  supervisor_call POST "/control/v1/instances/${M5B_REPOSITORY_ID}/sleep" '{"manual":true}' | head -c 240
  echo
  for _ in $(seq 1 120); do
    alive=0
    kill -0 "$BRIDGE_PID_BEFORE" 2>/dev/null && alive=1
    (( alive == 0 )) && break
    sleep 0.5
  done
  echo "old bridge pid alive after stop: ${alive:-0}"
  echo '$ systemctl stop dispatcher api supervisor (coordinated two-database restart)'
  systemctl stop "${M5B_MATRIX_SLICE%.slice}-dispatcher.service" "${M5B_MATRIX_SLICE%.slice}-api.service" \
    "${M5B_MATRIX_SLICE%.slice}-supervisor.service"
  echo '$ systemctl restart matrix PostgreSQL (the platform database)'
  systemctl restart "${M5B_MATRIX_SLICE%.slice}-pg.service"
  for _ in $(seq 1 60); do
    pg_isready -h 127.0.0.1 -p "$M5B_MATRIX_PG_PORT" >/dev/null 2>&1 && break
    sleep 0.5
  done
  pg_isready -h 127.0.0.1 -p "$M5B_MATRIX_PG_PORT" >/dev/null 2>&1 || fail "matrix PostgreSQL did not come back"
  echo '$ stack.sh services-up (recreate the stopped units over the same database)'
  bash "$M5B_MATRIX_ROOT/scripts/m5b/matrix/stack.sh" services-up
  sleep 4
  echo '$ supervisor prepare + wake (fresh runtime process)'
  supervisor_call POST "/control/v1/instances/${M5B_REPOSITORY_ID}/prepare" >/dev/null || true
  echo '$ supervisor wake (fresh runtime process)'
  supervisor_call POST "/control/v1/instances/${M5B_REPOSITORY_ID}/wake" '{"priority":20,"reason":"manual"}' | head -c 240
  echo
  for _ in $(seq 1 240); do
    row=$(supervisor_call GET "/control/v1/instances/${M5B_REPOSITORY_ID}")
    [[ $row == *'"state":"online"'* && $row == *'"reasonCode":"listening"'* ]] && break
    sleep 0.5
  done
  BRIDGE_PID_AFTER=$(instance_pid)
  DISPATCHER_PID_AFTER=$(m5b_unit_pid "${M5B_MATRIX_SLICE%.slice}-dispatcher.service")
  sleep 10
  PR_AFTER=$(gh_agent pr view "$PR" --repo "$FIXTURE_REPO" --json number,state,isDraft,headRefName,url --jq '.')
  TICKET_AFTER=$(ticket_field "$TICKET" state)
  TICKET_ENDED_AT=$(ticket_field "$TICKET" ended.at)
  PR_URL_AFTER=$(ticket_field "$TICKET" pr.url)
  PR_NUM_AFTER=$(ticket_field "$TICKET" pr.number)
  ASSIGNMENT_AFTER=$(ticket_field "$TICKET" assignmentId)
  TASK_ROW=$(m5b_sql "select state || '|' || coalesce(pr_url,'-') || '|' || coalesce(pr_number::text,'-') || '|' || coalesce(runtime_lease_id::text,'-') from task_links where id='$TASK'")
  OPERATIONS_AFTER=$(count_rows task_operations "task_id='$TASK'")
  DELIVERIES_AFTER=$(count_rows deliveries "message_id in (select id from messages where conversation_id=(select conversation_id from task_links where id='$TASK'))")
  echo "after: runtime_state=${TICKET_AFTER} ended_at=${TICKET_ENDED_AT:-null} pr=${PR_AFTER} assignment=${ASSIGNMENT_AFTER}"
  echo "platform_task=${TASK_ROW} operations=${OPERATIONS_AFTER} deliveries=${DELIVERIES_AFTER}"
  echo "pids: bridge=${BRIDGE_PID_BEFORE}->${BRIDGE_PID_AFTER} dispatcher=${DISPATCHER_PID_BEFORE}->${DISPATCHER_PID_AFTER}"
  [[ $TICKET_AFTER == awaiting_review ]] || fail "the restarted runtime no longer reports awaiting_review (${TICKET_AFTER})"
  [[ -z $TICKET_ENDED_AT ]] || fail "the restarted runtime reports ended.at=${TICKET_ENDED_AT}"
  [[ $PR_URL_AFTER == "$PR_URL_BEFORE" && $PR_NUM_AFTER == "$PR_NUM_BEFORE" ]] || fail "the ticket PR pointer changed across the restart"
  [[ $PR_BEFORE == "$PR_AFTER" ]] || fail "the real PR binding changed across the restart"
  [[ $ASSIGNMENT_AFTER == "$ASSIGNMENT_BEFORE" ]] || fail "the restart started a new Assignment"
  [[ $OPERATIONS_AFTER == "$OPERATIONS_BEFORE" && $DELIVERIES_AFTER == "$DELIVERIES_BEFORE" ]] || fail "the restart created work or deliveries"
  [[ $BRIDGE_PID_BEFORE != "$BRIDGE_PID_AFTER" && $DISPATCHER_PID_BEFORE != "$DISPATCHER_PID_AFTER" ]] || fail "the restart did not happen"
  [[ $TASK_ROW == "awaiting_review|${PR_URL_BEFORE}|${PR_NUM_BEFORE}|-" ]] || fail "the platform task lost its review state or lease binding: ${TASK_ROW}"
  echo "VERDICT: awaiting_review and the real open PR survived the Bridge/dispatcher/two-database restart; no new Assignment, operation or delivery."
fi

echo "## close the fixture PR (never merged) and watch the ticket end"
echo "\$ gh pr close ${PR} --repo ${FIXTURE_REPO}"
gh_agent pr close "$PR" --repo "$FIXTURE_REPO" 2>&1 | tail -3
AFTER=""
for _ in $(seq 1 120); do
  AFTER=$(ticket_field "$TICKET" state)
  [[ $AFTER == closed_unmerged || $AFTER == completed ]] && break
  sleep 1
done
echo "runtime_ticket_state_after_close=${AFTER}"
echo "## raw ticket snapshot after the close"
ticket_json "$TICKET" | tee "$RUN/ticket-after-close.json"
echo

echo "## the fixture PR as GitHub reports it now"
gh_agent pr view "$PR" --repo "$FIXTURE_REPO" \
  --json number,state,isDraft,merged,headRefName,url 2>&1 | tail -5
echo

echo "## the platform task as recorded"
m5b_sql "select id, state, version, upstream_ticket_id from task_links where id='$TASK'"
echo

echo "## verdict"
echo "awaiting_review_state=${STATE}"
echo "state_after_close=${AFTER}"
echo "fixture_pr=${PR} fixture_repo=${FIXTURE_REPO}"
if [[ $STATE == awaiting_review && $AFTER == closed_unmerged ]]; then
  echo "VERDICT: with a real open PR the ticket projects as awaiting_review, and closing that PR ends it as closed_unmerged. Sub-state passed."
else
  echo "VERDICT: not proven (awaiting_review=${STATE}, after close=${AFTER})."
fi
echo "note: the fixture PR exists only in ${FIXTURE_REPO} (the test repository). It was closed without merging; its branch remains on the test repository until pruned."
