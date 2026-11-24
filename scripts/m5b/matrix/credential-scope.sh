#!/usr/bin/env bash
# Proves the installed matrix SSH credential reaches the probe repository and is
# refused by a controlled private repository, using a real `git push --dry-run`.
#
# No ref is updated (--dry-run) and no token is printed. The command runs as the
# matrix identity with its own HOME and SSH configuration.
#
#   scripts/m5b/matrix/credential-scope.sh --probe OWNER/REPO --deny OWNER/REPO
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

PROBE=Bouyer12/m5a-beta-adf10ad9
DENY=Bouyer12/m5a-epsilon-adf10ad9
while [[ $# -gt 0 ]]; do
  case $1 in
    --probe) PROBE=$2; shift 2 ;;
    --deny) DENY=$2; shift 2 ;;
    *) echo "usage: $0 [--probe OWNER/REPO] [--deny OWNER/REPO]" >&2; exit 2 ;;
  esac
done

[[ $(id -u) -eq 0 ]] || { echo "FAIL: run as root"; exit 1; }
id "$M5B_MATRIX_USER" >/dev/null 2>&1 || { echo "FAIL: missing identity $M5B_MATRIX_USER"; exit 1; }
[[ -r /home/$M5B_MATRIX_USER/.ssh/probe_deploy ]] || { echo "FAIL: probe key not installed"; exit 1; }

failed=0
sandbox=$(mktemp -d /tmp/m5b-scope.XXXXXX)
chmod 0700 "$sandbox"
chown "$M5B_MATRIX_USER:$M5B_MATRIX_GROUP" "$sandbox"
trap 'rm -rf "$sandbox"' EXIT

run_as_identity() {
  runuser -u "$M5B_MATRIX_USER" -- env HOME="/home/$M5B_MATRIX_USER" "$@"
}

run_as_identity git -C "$sandbox" init -q || { echo "FAIL: git init"; exit 1; }
run_as_identity git -C "$sandbox" -c user.name=m5b-scope -c user.email=scope@example.invalid \
  commit -q --allow-empty -m "m5b credential scope probe" || { echo "FAIL: git commit"; exit 1; }
branch="m5b-scope-$(date +%s)-$$"

probe_out=$(run_as_identity git -C "$sandbox" push --dry-run \
  "ssh://git@ssh.github.com:443/${PROBE}.git" "HEAD:refs/heads/${branch}" 2>&1)
probe_status=$?
if [[ $probe_status -eq 0 ]]; then
  echo "probe_allowed=${PROBE} exit=${probe_status} (dry-run, no ref updated)"
else
  echo "probe_denied=${PROBE} exit=${probe_status}"
  printf '%s\n' "$probe_out" | sed 's/^/  /' | tail -4
  failed=1
fi

deny_out=$(run_as_identity git -C "$sandbox" push --dry-run \
  "ssh://git@ssh.github.com:443/${DENY}.git" "HEAD:refs/heads/${branch}" 2>&1)
deny_status=$?
if [[ $deny_status -ne 0 ]]; then
  echo "private_denied=${DENY} exit=${deny_status}"
else
  echo "private_allowed=${DENY} exit=${deny_status} (unexpected)"
  failed=1
fi

if [[ $failed -eq 0 ]]; then
  echo "scope_validated=probe-only"
  exit 0
fi
echo "scope_validated=failed"
exit 1
