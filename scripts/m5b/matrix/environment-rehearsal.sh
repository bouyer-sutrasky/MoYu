#!/usr/bin/env bash
# Two-round lifecycle rehearsal of the isolated matrix environment.
#
# This exercises the real bootstrap/cleanup entry points on the host, without
# starting the seven-item platform matrix:
#
#   init       guard prepare-run creates the protected layout (root-owned run
#              root and protected/config, identity-owned runtime directories)
#   crash      a matrix process is killed and a half-written state is left behind
#   cleanup    protected secrets are removed and identity-owned state is emptied
#   restart    the same layout is prepared again and the privileged writes are
#              repeated
#
# Every round asserts that a root-owned sentinel outside the run root keeps its
# content and metadata, that a pre-created symlink in the identity tree cannot
# redirect a cleanup, and that the installed probe credential is authorized only
# for the probe repository (the controlled private repository is refused).
#
# It never runs `prepare-nonroot.sh --apply`, never changes host configuration,
# and never touches production services or the shared 55432 PostgreSQL.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

RUN=$M5B_MATRIX_RUN
SENTINEL=${M5B_MATRIX_REHEARSAL_SENTINEL:-/var/tmp/m5b-host-sentinel}
PROBE_REPO=$M5B_MATRIX_REPOSITORY
DENY_REPO=${M5B_MATRIX_REHEARSAL_DENY_REPO:-${M5B_MATRIX_CONTROL_REPOSITORY:-Bouyer12/m5a-epsilon-adf10ad9}}
FAILURES=0

fail_case() {
  echo "FAIL: $*"
  FAILURES=$((FAILURES + 1))
}

pass_case() {
  echo "PASS: $*"
}

[[ $(id -u) -eq 0 ]] || {
  echo "SKIP: run as root"
  exit 0
}
id "$M5B_MATRIX_USER" >/dev/null 2>&1 || {
  echo "SKIP: the ${M5B_MATRIX_USER} identity does not exist; run prepare-nonroot.sh --apply first"
  exit 0
}

facts() {
  # Content hash plus the metadata a privileged write or chmod would change.
  printf 'sha256=%s mode=%s uid=%s size=%s mtime=%s\n' \
    "$(sha256sum "$1" | cut -d' ' -f1)" "$(stat -c %a "$1")" "$(stat -c %u "$1")" \
    "$(stat -c %s "$1")" "$(stat -c %y "$1")"
}

make_sentinel() {
  printf 'M5B-HOST-SENTINEL-%s\n' "$(head -c 16 /dev/urandom | base64 | tr -d '=+/')" >"$SENTINEL"
  chown root:root "$SENTINEL"
  chmod 0600 "$SENTINEL"
}

identity_shell() {
  runuser -u "$M5B_MATRIX_USER" -- "$@"
}

# Writes one file as the identity through the low-priv helper (no root write
# below an identity-owned directory).
identity_write() {
  local dir=$1 name=$2 mode=$3 content=$4
  printf '%s' "$content" | m5b_lowpriv write --user "$M5B_MATRIX_USER" --dir "$dir" \
    --name "$name" --mode "$mode"
}

round() {
  local n=$1
  echo "########## round ${n} ##########"
  echo "## init: prepare the protected layout"
  m5b_prepare_run || { fail_case "round ${n}: prepare-run failed"; return 1; }
  local token seed
  token=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
  seed=$(head -c 24 /dev/urandom | base64 | tr -d '=+/')
  m5b_protected_write supervisor-token "$token" >/dev/null || {
    fail_case "round ${n}: protected token write failed"
    return 1
  }
  m5b_protected_write seed.env "export M5B_SESSION_TOKEN=$seed" >/dev/null || {
    fail_case "round ${n}: protected seed write failed"
    return 1
  }
  m5b_config_write instances.json '{"instances":[]}' >/dev/null || {
    fail_case "round ${n}: config write failed"
    return 1
  }
  [[ $(stat -c %a "$M5B_MATRIX_PROTECTED") == 700 ]] ||
    fail_case "round ${n}: protected mode is $(stat -c %a "$M5B_MATRIX_PROTECTED")"
  [[ $(stat -c %a "$M5B_MATRIX_PROTECTED/supervisor-token") == 600 ]] ||
    fail_case "round ${n}: token mode is not 0600"
  if identity_shell test -w "$M5B_MATRIX_PROTECTED"; then
    fail_case "round ${n}: the identity can write the protected directory"
  else
    pass_case "round ${n}: protected secrets are root-only and the identity cannot write them"
  fi

  echo "## identity runtime state"
  identity_write "$M5B_MATRIX_CREDENTIALS" worker.json 600 '{"bridgeToken":"fixture"}' >/dev/null ||
    fail_case "round ${n}: identity credential write failed"
  identity_write "$M5B_MATRIX_TMP" worker-report.json 600 '{"state":"ready"}' >/dev/null ||
    fail_case "round ${n}: identity scratch write failed"
  identity_shell mkdir -p "$M5B_MATRIX_DSH_HOME/state/$M5B_MATRIX_PROFILE" ||
    fail_case "round ${n}: identity could not create its state directory"
  pass_case "round ${n}: identity wrote its own runtime state"

  echo "## abnormal exit: kill a matrix process and leave a half-written state"
  local pid
  identity_shell sleep 300 &
  pid=$!
  sleep 0.3
  kill -9 "$pid" 2>/dev/null || true
  pkill -9 -u "$M5B_MATRIX_USER" -f 'sleep 300' 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if kill -0 "$pid" 2>/dev/null; then
    fail_case "round ${n}: the killed process is still alive"
  else
    pass_case "round ${n}: the matrix process was killed; the next start must clean its state"
  fi
  identity_write "$M5B_MATRIX_TMP" half-written.json 600 '{"partial":' >/dev/null ||
    fail_case "round ${n}: could not leave a half-written state"

  echo "## malicious path replacement: cleanup must not follow a link"
  identity_shell ln -sfn "$SENTINEL" "$M5B_MATRIX_TMP/worker-report.json.link"
  local before_replacement
  before_replacement=$(facts "$SENTINEL")
  m5b_lowpriv remove --user "$M5B_MATRIX_USER" --root "$M5B_MATRIX_TMP" \
    --path "$M5B_MATRIX_TMP/worker-report.json.link" >/dev/null 2>&1 || true
  if [[ $before_replacement == "$(facts "$SENTINEL")" ]]; then
    pass_case "round ${n}: unlinking the replaced path left the host sentinel unchanged"
  else
    fail_case "round ${n}: path replacement changed the host sentinel"
  fi

  echo "## cleanup: empty identity state and remove protected secrets"
  local dir
  for dir in "$M5B_MATRIX_TMP" "$M5B_MATRIX_CREDENTIALS" "$M5B_MATRIX_INSTANCE_ENV" \
    "$M5B_MATRIX_INSTANCE_LOGS" "$M5B_MATRIX_WORKTREES" "$M5B_MATRIX_DSH_HOME"; do
    [[ -d $dir ]] || continue
    m5b_clean_owned "$dir" >/dev/null || fail_case "round ${n}: could not clean $dir"
  done
  m5b_protected_remove supervisor-token >/dev/null || true
  m5b_protected_remove seed.env >/dev/null || true
  local leftovers
  leftovers=$(ls -A "$M5B_MATRIX_PROTECTED" 2>/dev/null | wc -l)
  [[ $leftovers -eq 0 ]] ||
    fail_case "round ${n}: ${leftovers} protected file(s) left after cleanup"
  [[ ! -e $M5B_MATRIX_PROTECTED/supervisor-token ]] ||
    fail_case "round ${n}: the supervisor token survived cleanup"
  if find "$M5B_MATRIX_TMP" -mindepth 1 -type f -print -quit | grep -q .; then
    fail_case "round ${n}: identity scratch files survived cleanup"
  else
    pass_case "round ${n}: protected secrets removed and identity state emptied"
  fi

  echo "## restart: prepare the layout again"
  m5b_prepare_run || { fail_case "round ${n}: restart prepare-run failed"; return 1; }
  m5b_protected_write supervisor-token "$token" >/dev/null ||
    fail_case "round ${n}: restart token write failed"
  [[ $(stat -c %a "$M5B_MATRIX_PROTECTED/supervisor-token") == 600 ]] ||
    fail_case "round ${n}: restart token mode is not 0600"
  [[ $(stat -c %u "$RUN") == 0 ]] ||
    fail_case "round ${n}: restart left the run root owned by uid $(stat -c %u "$RUN")"
  pass_case "round ${n}: restart re-created the protected layout with root ownership"

  echo "## credential scope: probe authorized, controlled private repository denied"
  local scope
  scope=$(bash "$HERE/credential-scope.sh" --probe "$PROBE_REPO" --deny "$DENY_REPO" 2>&1)
  local scope_status=$?
  printf '%s\n' "$scope"
  [[ $scope_status -eq 0 ]] || fail_case "round ${n}: credential scope check failed"
  echo
}

echo "# M5-B isolated environment lifecycle rehearsal"
echo "recorded=$(date -Is)"
echo "host=$(hostname)"
echo "run=$RUN"
echo "identity=$(id "$M5B_MATRIX_USER")"
echo "probe_repository=$PROBE_REPO"
echo "deny_repository=$DENY_REPO"
echo

make_sentinel
sentinel_before=$(facts "$SENTINEL")
echo "sentinel=$SENTINEL"
echo "sentinel_before=${sentinel_before}"
echo

round 1
round 2

echo "########## final checks ##########"
if [[ $sentinel_before == "$(facts "$SENTINEL")" ]]; then
  pass_case "host sentinel content and metadata are unchanged after both rounds"
else
  fail_case "host sentinel changed: ${sentinel_before} -> $(facts "$SENTINEL")"
fi
if identity_shell test -w "$M5B_MATRIX_PROTECTED"; then
  fail_case "the identity can write the protected directory"
else
  pass_case "the identity still cannot write the protected directory"
fi
if identity_shell test -r /root/.dsh-m5/.credentials.yaml; then
  fail_case "the identity can read the shared m5b credentials"
else
  pass_case "the identity cannot read the shared m5b credentials"
fi
if identity_shell test -w /root/.config/gh-agent; then
  fail_case "the identity can write the shared gh configuration"
else
  pass_case "the identity cannot write the shared gh configuration"
fi

echo
if (( FAILURES > 0 )); then
  echo "verdict=FAILED failures=${FAILURES}"
  exit 1
fi
echo "verdict=PASS rounds=2"
