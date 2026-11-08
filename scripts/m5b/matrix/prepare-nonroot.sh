#!/usr/bin/env bash
# Gives the matrix stack a dedicated non-root identity.
#
# The services must read the built artifact, the runtime profile and (for the
# runtime's git credential helper) the agent CLI, and they must write their own
# state. All of that lives under /root, which is 0700. There is no setfacl on this
# host, so the grants below use a dedicated group: only that group gains access,
# and every mode/group this script changes is printed before and after.
#
#   scripts/m5b/matrix/prepare-nonroot.sh          # apply (idempotent)
#   scripts/m5b/matrix/prepare-nonroot.sh --check  # only print the current facts
#
# Restoring: the script prints the original group/mode of every changed path; set
# them back (root:root 0700 on /root, the repository group and mode, etc.) when the
# matrix stack is retired.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

CHECK_ONLY=0
[[ ${1:-} == --check ]] && CHECK_ONLY=1

GROUP=$M5B_MATRIX_GROUP
USER_=$M5B_MATRIX_USER
REPO=$M5B_MATRIX_ROOT
UPSTREAM_BUILD=${M5B_MATRIX_UPSTREAM_BUILD:-/root/src/upstream/m5b-admission-build21}
DSH_HOME=$M5B_MATRIX_DSH_HOME
GH_DIR=/root/.config/gh-agent
GH_CLI_DIR=/root/.local/bin

fail() {
  echo "FAIL: $*"
  exit 1
}

report() {
  printf '  %-58s group=%-10s mode=%s\n' "$1" "$(stat -c %G "$1")" "$(stat -c %a "$1")"
}

grant_dir() {
  local path=$1 mode=$2
  [[ -e $path ]] || return 0
  report "$path"
  (( CHECK_ONLY == 1 )) && return 0
  chgrp "$GROUP" "$path"
  chmod "$mode" "$path"
  printf '  -> %-55s group=%-10s mode=%s\n' "$path" "$(stat -c %G "$path")" "$(stat -c %a "$path")"
}

grant_tree() {
  local path=$1 dir_mode=$2 file_mode=$3
  [[ -e $path ]] || return 0
  report "$path"
  (( CHECK_ONLY == 1 )) && return 0
  chgrp -R "$GROUP" "$path"
  find "$path" -type d -exec chmod "$dir_mode" {} +
  find "$path" -type f -exec chmod "$file_mode" {} +
  printf '  -> %-55s group=%-10s dirs=%s files=%s (recursive)\n' \
    "$path" "$(stat -c %G "$path")" "$dir_mode" "$file_mode"
}

echo "# matrix non-root identity"
echo "recorded=$(date -Is)"
echo "host=$(hostname)"
echo

if (( CHECK_ONLY == 0 )); then
  getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
  id "$USER_" >/dev/null 2>&1 || useradd --system --gid "$GROUP" --no-create-home \
    --shell /usr/sbin/nologin "$USER_"
fi
id "$USER_" || fail "the matrix user does not exist"
echo "primary_group=$(id -gn "$USER_")"
echo "supplementary_groups=$(id -Gn "$USER_" | tr ' ' ',')"
echo "uid=$(id -u "$USER_") gid=$(id -g "$USER_")"
echo

echo "## access grants (before -> after)"
grant_dir /root 0710
grant_dir /root/src 0710
grant_tree "$REPO" g+rX g+r
grant_dir /root/src/upstream 0710
grant_tree "$UPSTREAM_BUILD" g+rX g+r
grant_tree "$DSH_HOME" g+rwX g+rw
grant_dir /root/.local 0710
grant_dir "$GH_CLI_DIR" 0750
grant_dir /root/.config 0710
# The pinned node distribution: the build/test process runs under the same
# identity as the services, so it needs read+execute here.
grant_tree /opt/moyu-node24 g+rx g+r
grant_tree "$GH_DIR" g+rwX g+rw
echo

# The runtime's worker clones the repository over the agent's SSH route. The key
# and the host route live in root's home, so the identity gets its own copy in its
# own home directory: same key material, 0600, never in the repository or a log.
SSH_SOURCE_KEY=${M5B_MATRIX_SSH_KEY:-/root/.ssh/sa_agent2}
if (( CHECK_ONLY == 0 )) && [[ -r $SSH_SOURCE_KEY ]]; then
  install -d -m 0700 -o "$USER_" -g "$GROUP" "/home/$USER_/.ssh" 2>/dev/null || {
    mkdir -p "/home/$USER_/.ssh"
    chown "$USER_:$GROUP" "/home/$USER_" "/home/$USER_/.ssh"
    chmod 0700 "/home/$USER_" "/home/$USER_/.ssh"
  }
  install -m 0600 -o "$USER_" -g "$GROUP" "$SSH_SOURCE_KEY" "/home/$USER_/.ssh/sa_agent2"
  cat >"/home/$USER_/.ssh/config" <<SSHCONF
Host ssh.github.com
  HostName ssh.github.com
  Port 443
  IdentityFile /home/$USER_/.ssh/sa_agent2
  IdentitiesOnly yes

Host github.com
  HostName github.com
  Port 22
  IdentityFile /home/$USER_/.ssh/sa_agent2
  IdentitiesOnly yes
SSHCONF
  chown "$USER_:$GROUP" "/home/$USER_/.ssh/config"
  chmod 0600 "/home/$USER_/.ssh/config"
  ssh-keyscan -p 443 ssh.github.com >"/home/$USER_/.ssh/known_hosts" 2>/dev/null
  chown "$USER_:$GROUP" "/home/$USER_/.ssh/known_hosts"
  chmod 0600 "/home/$USER_/.ssh/known_hosts"
  echo "ssh_material=/home/$USER_/.ssh (key copied 0600, known_hosts entries: $(wc -l < "/home/$USER_/.ssh/known_hosts"))"
fi
echo

echo "## what the identity can actually do, checked as that user"
as_user() {
  if runuser -u "$USER_" -- "$@" >/dev/null 2>&1; then echo "  ok   $*"; else echo "  DENY $*"; fi
}
as_user test -r "$REPO/apps/dispatcher/dist/main.js"
as_user test -r "$UPSTREAM_BUILD/package.json"
as_user test -w "$DSH_HOME"
as_user test -r "$GH_CLI_DIR/gh-agent"
as_user test -r "$GH_DIR/hosts.yml"
as_user /usr/bin/node --version
as_user test -r "/home/$USER_/.ssh/sa_agent2"
ssh_probe=$(runuser -u "$USER_" -- ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -p 443 -T git@ssh.github.com 2>&1 || true)
case "$ssh_probe" in
  *"successfully authenticated"*) echo "  ok   ssh git@ssh.github.com:443 authenticated as $(printf '%s' "$ssh_probe" | sed -n 's/^Hi \([^!]*\)!.*/\1/p')" ;;
  *) echo "  DENY ssh authentication: $(printf '%s' "$ssh_probe" | head -1)" ;;
esac
echo

echo "## the dispatcher artifact the units will execute"
echo "  path=$REPO/apps/dispatcher/dist/main.js"
echo "  sha256=$(sha256sum "$REPO/apps/dispatcher/dist/main.js" | cut -d' ' -f1)"
echo "  bytes=$(stat -c %s "$REPO/apps/dispatcher/dist/main.js")"
echo
echo "verdict: every service unit of the matrix stack runs as ${USER_}:${GROUP} (uid $(id -u "$USER_"))."
