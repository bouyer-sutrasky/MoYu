#!/usr/bin/env bash
# Provisions (or inspects) the dedicated SSH credential the matrix identity uses
# for its probe repository.
#
# The matrix identity must never hold the host agent key. This script creates a
# fresh ed25519 key, authorizes it as a write deploy key on the probe repository
# only, and leaves the private half in a root-only directory. The key is therefore
# independent of the host key and scoped by GitHub to that one repository: a push
# to any other repository is refused by the remote, not by a local convention.
#
# This is an owner/root action: it changes remote deploy-key state on the probe
# repository. It never runs as the low-privilege identity and never prints key
# material.
#
#   scripts/m5b/matrix/provision-probe-credential.sh --check   # read-only facts
#   scripts/m5b/matrix/provision-probe-credential.sh --apply   # create + authorize
#   scripts/m5b/matrix/provision-probe-credential.sh --revoke  # remove key + authorization
#
# The gh API credential used here is the trusted identity's own configuration;
# it is never copied into the matrix tree or made readable by the matrix user.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

MODE=check
case ${1:-} in
  --check) MODE=check ;;
  --apply) MODE=apply ;;
  --revoke) MODE=revoke ;;
  *)
    echo "usage: $0 [--check|--apply|--revoke]" >&2
    exit 2
    ;;
esac

KEY=$M5B_MATRIX_SSH_KEY
KEY_PUB=$KEY.pub
KEY_TITLE=${M5B_MATRIX_PROBE_KEY_TITLE:-m5b-matrix-probe}
PROBE_REPOS=${M5B_MATRIX_PROBE_REPOSITORIES:-Bouyer12/m5a-beta-adf10ad9}
PROBE_DIR=$(dirname "$KEY")
HOST_KEY_DIR=/root/.ssh
GH_CLI=${M5B_MATRIX_PROVISION_GH_CLI:-gh}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

report() {
  printf '  %-56s owner=%-8s group=%-10s mode=%s\n' \
    "$1" "$(stat -c %U "$1")" "$(stat -c %G "$1")" "$(stat -c %a "$1")"
}

require_root() {
  [[ $(id -u) -eq 0 ]] || fail "must run as root (the key belongs to the trusted identity)"
}

fingerprint() {
  ssh-keygen -lf "$KEY_PUB" 2>/dev/null | awk '{print $2}' || true
}

# Refuses a key that is a renamed copy of a host agent key: provenance must be
# independent, not merely a different file name.
assert_not_host_key() {
  local digest host
  digest=$(sha256sum "$KEY" | cut -d' ' -f1)
  for host in "$HOST_KEY_DIR"/*; do
    [[ -f $host ]] || continue
    if [[ $(sha256sum "$host" | cut -d' ' -f1) == "$digest" ]]; then
      fail "$KEY is a copy of the host key $host; remove it and run --apply again"
    fi
  done
}

deploy_key_ids() {
  local repo=$1
  "$GH_CLI" api "repos/$repo/keys" --paginate \
    --jq ".[] | select(.title == \"$KEY_TITLE\") | .id" 2>/dev/null || true
}

key_matches() {
  local repo=$1 expected=$2
  local keys
  keys=$("$GH_CLI" api "repos/$repo/keys" --paginate --jq '.[].key' 2>/dev/null || true)
  [[ -n $keys ]] && grep -qF "$expected" <<<"$keys"
}

check() {
  echo "# matrix probe credential (read-only)"
  echo "recorded=$(date -Is)"
  echo "key=$KEY"
  echo "repositories=$PROBE_REPOS"
  if [[ -e $KEY ]]; then
    report "$KEY"
    [[ $(stat -c %U "$KEY") == root ]] || fail "$KEY is not owned by root"
    [[ $(stat -c %a "$KEY") == 600 ]] || fail "$KEY must be mode 0600"
    assert_not_host_key
    echo "  fingerprint=$(fingerprint)"
  else
    echo "  key=missing (run --apply)"
  fi
  local repo
  for repo in ${PROBE_REPOS//,/ }; do
    local ids
    ids=$(deploy_key_ids "$repo")
    if [[ -n $ids ]]; then
      echo "  deploy_key=$repo id=$(tr '\n' ',' <<<"$ids" | sed 's/,$//') title=$KEY_TITLE"
    else
      echo "  deploy_key=$repo missing title=$KEY_TITLE"
    fi
    if [[ -e $KEY_PUB ]] && key_matches "$repo" "$(cut -d' ' -f2 "$KEY_PUB")"; then
      echo "  authorized=$repo yes"
    else
      echo "  authorized=$repo no"
    fi
  done
}

apply() {
  require_root
  echo "# provisioning the dedicated probe key"
  echo "recorded=$(date -Is)"
  if [[ -e $KEY ]]; then
    assert_not_host_key
    report "$KEY"
    [[ $(stat -c %a "$KEY") == 600 ]] || chmod 0600 "$KEY"
  else
    install -d -m 0700 -o root -g root "$PROBE_DIR"
    echo "\$ ssh-keygen -t ed25519 -N '' -C '$KEY_TITLE' -f $KEY"
    ssh-keygen -q -t ed25519 -N '' -C "$KEY_TITLE" -f "$KEY" || fail "ssh-keygen failed"
    chown root:root "$KEY" "$KEY_PUB"
    chmod 0600 "$KEY"
    chmod 0644 "$KEY_PUB"
    report "$KEY"
  fi
  assert_not_host_key
  echo "  fingerprint=$(fingerprint)"
  local repo
  for repo in ${PROBE_REPOS//,/ }; do
    local ids
    ids=$(deploy_key_ids "$repo")
    if [[ -n $ids ]]; then
      echo "  authorized=$repo already id=$(tr '\n' ',' <<<"$ids" | sed 's/,$//')"
      continue
    fi
    echo "\$ $GH_CLI api repos/$repo/keys -f title=$KEY_TITLE -f key=<public-key> -F read_only=false"
    local output
    output=$("$GH_CLI" api "repos/$repo/keys" --method POST \
      -f "title=$KEY_TITLE" -f "key=$(cat "$KEY_PUB")" -F read_only=false 2>&1) \
      || { printf '%s\n' "$output"; fail "could not authorize the probe key on $repo"; }
    echo "  authorized=$repo id=$(printf '%s' "$output" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id"))')"
  done
  echo "verdict: dedicated probe key present; authorization is limited by the deploy key itself"
}

revoke() {
  require_root
  echo "# revoking the dedicated probe key"
  local repo
  for repo in ${PROBE_REPOS//,/ }; do
    local ids id
    ids=$(deploy_key_ids "$repo")
    for id in $ids; do
      echo "\$ $GH_CLI api -X DELETE repos/$repo/keys/$id"
      "$GH_CLI" api --method DELETE "repos/$repo/keys/$id" || fail "could not delete key $id on $repo"
      echo "  revoked=$repo id=$id"
    done
  done
  local name
  for name in "$KEY" "$KEY_PUB"; do
    [[ -e $name ]] || continue
    echo "  remove $name"
    rm -f -- "$name"
  done
  echo "verdict: probe key authorization removed"
}

echo "# M5-B matrix probe credential"
echo "host=$(hostname)"
echo "mode=$MODE"
echo
case $MODE in
  check) check ;;
  apply) apply ;;
  revoke) revoke ;;
esac
