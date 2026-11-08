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
OPEN_PR_FILE="$M5B_MATRIX_TMP/open-pr.txt"
PR_NUMBER_FILE="$M5B_MATRIX_TMP/pr-number.txt"
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
printf '%s\n' "$M5B_MATRIX_ROOT/scripts/m5b/matrix/fixture-open-pr.sh" >"$OPEN_PR_FILE"
chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$OPEN_PR_FILE"
chmod 0640 "$OPEN_PR_FILE"
rm -f "$PR_NUMBER_FILE"
: >"$PR_NUMBER_FILE"
chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$PR_NUMBER_FILE"
chmod 0660 "$PR_NUMBER_FILE"
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
