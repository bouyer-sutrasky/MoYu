#!/usr/bin/env bash
# Helpers for paths owned by the low-privilege matrix identity.
#
# Root must never write (or chmod) inside such a tree: a pre-created symlink
# would redirect the write to a host file. These helpers perform every write as
# the target identity through lowpriv.mjs (temp file + rename, no link
# following), and only read from a root-owned staging tree.

# ensure_identity_home HOME USER GROUP
#
# The home itself may be root-owned and not writable by the identity; in that
# case root can safely create/chown the .ssh directory because the identity
# cannot pre-create entries in the home. When the home is identity-owned, the
# directory is created by the identity so a replaced path cannot become root's
# write target.
ensure_ssh_dir() {
  local user=$1 group=$2 home=$3 ssh_dir=$4
  local uid
  uid=$(id -u "$user")
  if runuser -u "$user" -- test -w "$home"; then
    m5b_lowpriv mkdir --user "$user" --dir "$ssh_dir" --mode 700
    return
  fi
  if [[ -L $ssh_dir ]]; then
    echo "FAIL: refusing the symbolic link $ssh_dir" >&2
    return 1
  fi
  if [[ ! -e $ssh_dir ]]; then
    install -d -m 0700 -o "$user" -g "$group" "$ssh_dir"
  fi
  if [[ ! -d $ssh_dir ]]; then
    echo "FAIL: not a directory: $ssh_dir" >&2
    return 1
  fi
  if [[ $(stat -c %u "$ssh_dir") != "$uid" ]]; then
    chown "$user:$group" "$ssh_dir"
  fi
  chmod 0700 "$ssh_dir"
}

# install_ssh_material USER GROUP KEYFILE SSH_DIR KEY_NAME
#
# The key material is read by the caller (root) and piped to the identity; root
# never opens a path below SSH_DIR for writing.
install_ssh_material() {
  local user=$1 group=$2 keyfile=$3 ssh_dir=$4 key_name=${5:-probe_deploy}
  ensure_ssh_dir "$user" "$group" "$(dirname "$ssh_dir")" "$ssh_dir" || return 1
  m5b_lowpriv write --user "$user" --dir "$ssh_dir" --name "$key_name" --mode 600 \
    <"$keyfile" || return 1
  printf '%s\n' \
    'Host ssh.github.com' \
    '  HostName ssh.github.com' \
    '  Port 443' \
    "  IdentityFile $ssh_dir/$key_name" \
    '  IdentitiesOnly yes' \
    '' \
    'Host github.com' \
    '  HostName github.com' \
    '  Port 22' \
    "  IdentityFile $ssh_dir/$key_name" \
    '  IdentitiesOnly yes' \
    | m5b_lowpriv write --user "$user" --dir "$ssh_dir" --name config --mode 600 || return 1
  timeout 15 ssh-keyscan -p 443 ssh.github.com 2>/dev/null \
    | m5b_lowpriv write --user "$user" --dir "$ssh_dir" --name known_hosts --mode 600 \
    || return 1
  echo "  ssh_material=$ssh_dir owner=$(stat -c %U:%G "$ssh_dir") mode=$(stat -c %a "$ssh_dir")"
}

# remove_ssh_legacy_copy USER SSH_DIR
#
# Removing a legacy copy of the host agent key happens as the identity: unlink
# never follows the link, and root does not touch the tree.
remove_ssh_legacy_copy() {
  local user=$1 ssh_dir=$2 name=$3
  m5b_lowpriv remove --user "$user" --root "$ssh_dir" --path "$ssh_dir/$name"
}
