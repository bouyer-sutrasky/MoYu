#!/usr/bin/env bash
# Gives the matrix stack a dedicated non-root identity and dedicated credentials.
#
# The services must read the built artifact, the runtime profile source and the
# pinned node distribution, and write their own state. They must NOT be able to
# write host configuration: the shared m5b DSH home, the bootstrap home, the
# agent SSH key or the shared /root/.config/gh-agent token. This script grants
# read/traverse access only; write grants that an earlier version of the harness
# created are removed by `--revoke`, which is an owner action.
#
# Credentials:
#   $M5B_MATRIX_SSH_KEY        dedicated key authorized only for the probe repo
#   $M5B_MATRIX_GH_CONFIG_DIR  dedicated gh config authorized only for the probe repo
# Both are refused if they copy the host agent key or the shared gh token. The
# guard's `audit-*` commands verify the result; the harness refuses to start
# without them.
#
#   scripts/m5b/matrix/prepare-nonroot.sh            # apply read grants + install credentials
#   scripts/m5b/matrix/prepare-nonroot.sh --check    # read-only facts and isolation audit
#   scripts/m5b/matrix/prepare-nonroot.sh --revoke   # owner action: drop the old write grants
#
# Restoring: --revoke prints and applies the original host ownership/mode for
# every path an earlier harness widened.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

MODE=apply
case ${1:-} in
  --check) MODE=check ;;
  --revoke) MODE=revoke ;;
  --apply | '') MODE=apply ;;
  *)
    echo "usage: $0 [--check|--apply|--revoke]" >&2
    exit 2
    ;;
esac

GROUP=$M5B_MATRIX_GROUP
USER_=$M5B_MATRIX_USER
REPO=$M5B_MATRIX_ROOT
UPSTREAM_BUILD=$M5B_MATRIX_UPSTREAM_BUILD
GH_CLI_DIR=/root/.local/bin
# Host configuration that an earlier harness made group-writable. Only the
# owner may narrow it (--revoke); this script never touches it on --apply.
LEGACY_WRITE_PATHS=(/root/.dsh-m5 /root/.config/gh-agent)
GH_HOST_CONFIG=/root/.config/gh-agent
MATRIX_SSH_KEY=$M5B_MATRIX_SSH_KEY
MATRIX_GH_CONFIG_DIR=$M5B_MATRIX_GH_CONFIG_DIR
MATRIX_HOME=/home/$USER_
MATRIX_SSH_DIR=$MATRIX_HOME/.ssh

fail() {
  echo "FAIL: $*"
  exit 1
}

report() {
  printf '  %-58s owner=%-12s group=%-10s mode=%s\n' "$1" "$(stat -c %U "$1")" "$(stat -c %G "$1")" "$(stat -c %a "$1")"
}

grant_dir() {
  local path=$1 mode=$2
  [[ -e $path ]] || return 0
  report "$path"
  [[ $MODE == check ]] && return 0
  chgrp "$GROUP" "$path"
  chmod "$mode" "$path"
  printf '  -> %-55s group=%s mode=%s\n' "$path" "$(stat -c %G "$path")" "$(stat -c %a "$path")"
}

# Read/execute only: `find ... chmod` never adds write bits.
grant_tree() {
  local path=$1 dir_mode=$2 file_mode=$3
  [[ -e $path ]] || return 0
  report "$path"
  [[ $MODE == check ]] && return 0
  chgrp -R "$GROUP" "$path"
  find "$path" -type d -exec chmod "$dir_mode" {} +
  find "$path" -type f -exec chmod "$file_mode" {} +
  printf '  -> %-55s group=%s dirs=%s files=%s (recursive)\n' \
    "$path" "$(stat -c %G "$path")" "$dir_mode" "$file_mode"
}

as_user() {
  if runuser -u "$USER_" -- "$@" >/dev/null 2>&1; then echo "  ok   $*"; else echo "  DENY $*"; fi
}

revoke_legacy_write_grants() {
  echo "## narrowing the write grants an earlier harness created (owner action)"
  local path
  for path in "${LEGACY_WRITE_PATHS[@]}"; do
    [[ -e $path ]] || {
      echo "  missing $path"
      continue
    }
    [[ -L $path ]] && fail "refusing to recurse through the symbolic link $path"
    report "$path"
    if [[ $MODE == check ]]; then
      continue
    fi
    chgrp -R root "$path"
    find "$path" -type d -exec chmod 0700 {} +
    find "$path" -type f -exec chmod 0600 {} +
    printf '  -> %-55s owner=%s group=%s dirs=0700 files=0600\n' \
      "$path" "$(stat -c %U "$path")" "$(stat -c %G "$path")"
  done
}

remove_legacy_key_copy() {
  local legacy=$MATRIX_SSH_DIR/sa_agent2
  if [[ -e $legacy ]]; then
    report "$legacy"
    if [[ $MODE == check ]]; then
      echo "  refused=copy-of-host-agent-key (run --revoke to remove)"
      return 0
    fi
    echo "  fingerprint_before_removal=$(sha256sum "$legacy" | cut -d' ' -f1 | cut -c1-16)"
    rm -f "$legacy"
    echo "  -> removed; the matrix identity no longer holds the host agent key"
  fi
}

install_ssh_credential() {
  if [[ -L $MATRIX_SSH_DIR ]] || [[ -L $MATRIX_HOME ]]; then
    fail "refusing to install a key through a symbolic link: $MATRIX_SSH_DIR"
  fi
  if [[ ! -r $MATRIX_SSH_KEY ]]; then
    echo "  ssh_credential=missing path=$MATRIX_SSH_KEY"
    echo "  owner_action: create a dedicated key authorized only for the probe repository,"
    echo "                install it at $MATRIX_SSH_KEY (root:root 0600), then rerun --apply"
    return 3
  fi
  # Refuses a copy of the host agent key: same bytes, any name.
  local digest host
  digest=$(sha256sum "$MATRIX_SSH_KEY" | cut -d' ' -f1)
  for host in /root/.ssh/*; do
    [[ -f $host ]] || continue
    if [[ $(sha256sum "$host" | cut -d' ' -f1) == "$digest" ]]; then
      fail "$MATRIX_SSH_KEY is a copy of the host key $host; provision a dedicated key"
    fi
  done
  report "$MATRIX_SSH_KEY"
  if [[ $MODE == check ]]; then
    return 0
  fi
  install -d -m 0700 -o "$USER_" -g "$GROUP" "$MATRIX_SSH_DIR"
  install -m 0600 -o "$USER_" -g "$GROUP" "$MATRIX_SSH_KEY" "$MATRIX_SSH_DIR/probe_deploy"
  cat >"$MATRIX_SSH_DIR/config" <<SSHCONF
Host ssh.github.com
  HostName ssh.github.com
  Port 443
  IdentityFile $MATRIX_SSH_DIR/probe_deploy
  IdentitiesOnly yes

Host github.com
  HostName github.com
  Port 22
  IdentityFile $MATRIX_SSH_DIR/probe_deploy
  IdentitiesOnly yes
SSHCONF
  chown "$USER_:$GROUP" "$MATRIX_SSH_DIR/config"
  chmod 0600 "$MATRIX_SSH_DIR/config"
  ssh-keyscan -p 443 ssh.github.com >"$MATRIX_SSH_DIR/known_hosts" 2>/dev/null || true
  chown "$USER_:$GROUP" "$MATRIX_SSH_DIR/known_hosts"
  chmod 0600 "$MATRIX_SSH_DIR/known_hosts"
  echo "  ssh_material=$MATRIX_SSH_DIR (probe_deploy 0600, known_hosts entries: $(wc -l < "$MATRIX_SSH_DIR/known_hosts"))"
  return 0
}

install_gh_credential() {
  if [[ -L $MATRIX_GH_CONFIG_DIR ]]; then
    fail "refusing to use the symbolic link $MATRIX_GH_CONFIG_DIR"
  fi
  case "$MATRIX_GH_CONFIG_DIR" in
    "$GH_HOST_CONFIG" | "$GH_HOST_CONFIG"/*)
      fail "refusing to use the shared gh configuration $GH_HOST_CONFIG; set M5B_MATRIX_GH_CONFIG_DIR"
      ;;
  esac
  if [[ ! -f $MATRIX_GH_CONFIG_DIR/hosts.yml ]]; then
    echo "  gh_credential=missing path=$MATRIX_GH_CONFIG_DIR/hosts.yml"
    echo "  owner_action: create a fine-grained token limited to the probe repository and"
    echo "                its Contents/Issues/Pull requests permissions, sign it in with"
    echo "                GH_CONFIG_DIR=$MATRIX_GH_CONFIG_DIR gh auth login --with-token,"
    echo "                then chgrp $GROUP $MATRIX_GH_CONFIG_DIR && chmod 0750 ... && chmod 0640 hosts.yml"
    return 3
  fi
  if grep -q '^ *oauth_token: *[^ ]' "$MATRIX_GH_CONFIG_DIR/hosts.yml" 2>/dev/null; then
    report "$MATRIX_GH_CONFIG_DIR"
    if [[ $MODE == check ]]; then
      return 0
    fi
    chgrp "$GROUP" "$MATRIX_GH_CONFIG_DIR"
    chmod 0750 "$MATRIX_GH_CONFIG_DIR"
    chgrp "$GROUP" "$MATRIX_GH_CONFIG_DIR"/*.yml 2>/dev/null || true
    chmod 0640 "$MATRIX_GH_CONFIG_DIR"/*.yml 2>/dev/null || true
    echo "  -> $MATRIX_GH_CONFIG_DIR group=$GROUP mode=$(stat -c %a "$MATRIX_GH_CONFIG_DIR")"
    return 0
  fi
  echo "  gh_credential=present-without-token path=$MATRIX_GH_CONFIG_DIR/hosts.yml"
  echo "  owner_action: sign the dedicated probe-only token into that file"
  return 3
}

echo "# matrix non-root identity"
echo "recorded=$(date -Is)"
echo "host=$(hostname)"
echo "mode=$MODE"
echo

if [[ $MODE == apply ]]; then
  getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
  id "$USER_" >/dev/null 2>&1 || useradd --system --gid "$GROUP" --no-create-home \
    --shell /usr/sbin/nologin "$USER_"
fi
id "$USER_" || fail "the matrix user does not exist; run --apply first"
echo "primary_group=$(id -gn "$USER_")"
echo "supplementary_groups=$(id -Gn "$USER_" | tr ' ' ',')"
echo "uid=$(id -u "$USER_") gid=$(id -g "$USER_")"
echo

if [[ $MODE == revoke ]]; then
  revoke_legacy_write_grants
  echo
  remove_legacy_key_copy
  echo
  echo "revoked; host configuration is back to 0700/0600 for $GROUP"
  echo "re-run: $0 --apply"
  exit 0
fi

echo "## read/traverse grants (before -> after)"
grant_dir /root 0710
grant_dir /root/src 0710
grant_tree "$REPO" g+rX g+r
grant_dir /root/src/upstream 0710
grant_tree "$UPSTREAM_BUILD" g+rX g+r
grant_dir /root/.local 0710
grant_dir "$GH_CLI_DIR" 0750
grant_dir /root/.config 0710
# The pinned node distribution: the build/test process runs under the same
# identity as the services, so it needs read+execute here. Never writable.
grant_tree /opt/moyu-node24 g+rx g+r
# The matrix gh wrapper must be executable by the identity; the host umask may
# otherwise leave the checkout's copy at 0700.
[[ -f $REPO/scripts/m5b/matrix/gh-m5b.sh ]] && chmod 0755 "$REPO/scripts/m5b/matrix/gh-m5b.sh"
echo

echo "## removing the shared credential copy"
remove_legacy_key_copy
echo

echo "## dedicated probe credentials"
install_ssh_credential
SSH_STATUS=$?
install_gh_credential
GH_STATUS=$?
echo

echo "## what the identity can actually do, checked as that user"
as_user test -r "$REPO/apps/dispatcher/dist/main.js"
as_user test -r "$UPSTREAM_BUILD/package.json"
as_user test -r "$GH_CLI_DIR/gh-agent"
as_user test -r "$MATRIX_GH_CONFIG_DIR/hosts.yml"
as_user test -x "$REPO/scripts/m5b/matrix/gh-m5b.sh"
as_user /usr/bin/node --version
if [[ -e $MATRIX_SSH_DIR/probe_deploy ]]; then
  ssh_probe=$(runuser -u "$USER_" -- ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -p 443 -T git@ssh.github.com 2>&1 || true)
  case "$ssh_probe" in
    *"successfully authenticated"*)
      echo "  ok   ssh git@ssh.github.com:443 authenticated ($(printf '%s' "$ssh_probe" | head -1 | sed 's/[[:cntrl:]]//g'))" ;;
    *) echo "  DENY ssh authentication: $(printf '%s' "$ssh_probe" | head -1)" ;;
  esac
fi
echo

echo "## host configuration boundary (read-only audit)"
m5b_audit_host
HOST_STATUS=$?
echo

echo "## credentials boundary (dedicated, probe-only)"
m5b_audit_credentials
CREDENTIAL_STATUS=$?
echo

echo "## the dispatcher artifact the units will execute"
echo "  path=$REPO/apps/dispatcher/dist/main.js"
echo "  sha256=$(sha256sum "$REPO/apps/dispatcher/dist/main.js" | cut -d' ' -f1)"
echo "  bytes=$(stat -c %s "$REPO/apps/dispatcher/dist/main.js")"
echo
echo "verdict: every service unit of the matrix stack runs as ${USER_}:${GROUP} (uid $(id -u "$USER_"))."
echo "host_write_boundary=$([[ $HOST_STATUS -eq 0 ]] && echo clean || echo violated)"
echo "dedicated_credentials=$([[ $CREDENTIAL_STATUS -eq 0 ]] && echo verified || echo incomplete)"

if [[ $MODE == check ]]; then
  exit $(( HOST_STATUS != 0 || CREDENTIAL_STATUS != 0 ? 1 : 0 ))
fi
if (( HOST_STATUS != 0 )); then
  echo
  echo "owner_action: the test identity can write host configuration. Run '$0 --revoke'"
  echo "              (it narrows /root/.dsh-m5 and /root/.config/gh-agent to root:root 0700)."
  exit 1
fi
if (( SSH_STATUS != 0 || GH_STATUS != 0 )); then
  exit 1
fi
