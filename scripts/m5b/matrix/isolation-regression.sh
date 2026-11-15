#!/usr/bin/env bash
# Real-entry isolation regression for the matrix bootstrap paths (run as root).
#
# It reproduces the review finding: root must never write (or chmod) inside a
# directory the low-privilege identity owns, because a pre-created symlink would
# redirect the write to a host file. Each case pre-creates the attack leaf as the
# matrix identity, runs the same function the harness entry points use, then
# asserts the host sentinel kept its content *and* metadata.
#
#   scripts/m5b/matrix/isolation-regression.sh
#
# The script only touches a private /tmp sandbox plus (for the --check case) the
# read-only prepare entry point. It never runs --apply and never starts the
# matrix stack.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/m5b/matrix/lib.sh
source "$HERE/lib.sh"

USER_=$M5B_MATRIX_USER
GROUP=$M5B_MATRIX_GROUP
FAILURES=0

fail_case() {
  echo "FAIL: $*"
  FAILURES=$((FAILURES + 1))
}

pass_case() {
  echo "PASS: $*"
}

[[ $(id -u) -eq 0 ]] || {
  echo "SKIP: run as root (needs runuser and the $USER_ identity)"
  exit 0
}
id "$USER_" >/dev/null 2>&1 || {
  echo "SKIP: the $USER_ identity does not exist; run prepare-nonroot.sh --apply first"
  exit 0
}

SANDBOX=$(mktemp -d /tmp/m5b-isolation-regression-XXXXXX)
chmod 0711 "$SANDBOX"
# The checkout itself may not be readable by the identity yet (prepare --apply is
# an owner action). Give the helper a readable copy inside the sandbox.
cp "$M5B_MATRIX_DIR/lowpriv.mjs" "$SANDBOX/lowpriv.mjs"
chmod 0755 "$SANDBOX/lowpriv.mjs"
export M5B_MATRIX_LOWPRIV="$SANDBOX/lowpriv.mjs"
cleanup() {
  chmod -R u+rwX "$SANDBOX" 2>/dev/null || true
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

facts() {
  # content hash + mode + owner + size + mtime; compares exactly what a root
  # write or chmod would otherwise change.
  printf 'sha256=%s mode=%s uid=%s size=%s mtime=%s\n' \
    "$(sha256sum "$1" | cut -d' ' -f1)" "$(stat -c %a "$1")" "$(stat -c %u "$1")" \
    "$(stat -c %s "$1")" "$(stat -c %y "$1")"
}

make_sentinel() {
  local path=$1 content=$2
  printf '%s\n' "$content" >"$path"
  chown root:root "$path"
  chmod 0600 "$path"
}

echo "# M5-B matrix isolation regression (real entry points)"
echo "recorded=$(date -Is)"
echo "host=$(hostname)"
echo "identity=$(id "$USER_")"
echo

# --- 1. SSH material install: pre-created leaf link, repeated execution ------
echo "## 1. install_ssh_material as the identity (leaf link + rerun)"
case_root="$SANDBOX/case-ssh"
home="$case_root/home"
mkdir -p "$case_root"
chmod 0755 "$case_root"
install -d -m 0700 -o "$USER_" -g "$GROUP" "$home"
sentinel="$case_root/host-sentinel"
make_sentinel "$sentinel" "HOST-SSH-SENTINEL"
before=$(facts "$sentinel")
fake_key="$case_root/fake-probe-key"
printf 'DEDICATED-PROBE-KEY-MATERIAL\n' >"$fake_key"
chown root:root "$fake_key"
chmod 0600 "$fake_key"
runuser -u "$USER_" -- mkdir -p -m 0700 "$home/.ssh"
runuser -u "$USER_" -- ln -s "$sentinel" "$home/.ssh/config"
if install_ssh_material "$USER_" "$GROUP" "$fake_key" "$home/.ssh" probe_deploy; then
  after=$(facts "$sentinel")
  if [[ $before != "$after" ]]; then
    fail_case "SSH install changed the root sentinel: ${before} -> ${after}"
  elif runuser -u "$USER_" -- test -L "$home/.ssh/config"; then
    fail_case "SSH install left the pre-created config link in place"
  elif ! grep -q "IdentityFile $home/.ssh/probe_deploy" "$home/.ssh/config"; then
    fail_case "SSH install did not write the expected config"
  elif ! install_ssh_material "$USER_" "$GROUP" "$fake_key" "$home/.ssh" probe_deploy; then
    fail_case "second install_ssh_material run failed"
  elif [[ $before != "$(facts "$sentinel")" ]]; then
    fail_case "second SSH install changed the root sentinel"
  else
    pass_case "SSH material is installed as the identity; sentinel content/metadata unchanged across reruns"
  fi
else
  fail_case "install_ssh_material failed"
fi
echo

# --- 2. extra-repository staging: leaf link + second profile ----------------
echo "## 2. stage_profile_tree twice (main + extra repo) with a pre-set leaf link"
case_root="$SANDBOX/case-stage"
source_profile="$case_root/profile-source"
upstream="$case_root/upstream"
stage_root="$case_root/stage"
dsh_home="$case_root/dsh-home"
mkdir -p "$source_profile" "$upstream"
chmod 0755 "$case_root" "$source_profile" "$upstream"
printf '{"name":"dsh-superagent","version":"0.1.0"}\n' >"$upstream/package.json"
cat >"$source_profile/cordis.patch.yml" <<'YAML'
- id: webserver
  config:
    host: 127.0.0.1
    port: 3404
    stateDir: /root/.dsh-m5/state/m5b
- id: agent-default-model
  config:
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash
- id: model-providers
  config:
    providers:
      - id: local-test
        name: Local Test
        contextWindow: 32768
        maxTokens: 4096
      commandcode:
        baseUrl: https://example.invalid
        apiKey: unused
YAML
mkdir -p "$stage_root"
chown root:root "$stage_root"
chgrp "$GROUP" "$stage_root"
chmod 0750 "$stage_root"
install -d -m 0700 -o "$USER_" -g "$GROUP" "$dsh_home"
sentinel="$case_root/host-sentinel"
make_sentinel "$sentinel" "HOST-STAGE-SENTINEL"
before=$(facts "$sentinel")
runuser -u "$USER_" -- mkdir -p -m 0700 "$dsh_home/profiles"
runuser -u "$USER_" -- ln -s "$sentinel" "$dsh_home/profiles/m5b"
if stage_profile_tree m5b 3404 "$source_profile" "$upstream" "$stage_root" "$dsh_home" \
  "$USER_" "$GROUP"; then
  runuser -u "$USER_" -- ln -s "$sentinel" "$dsh_home/profiles/m5b-b"
  if stage_profile_tree m5b-b 3406 "$source_profile" "$upstream" "$stage_root" "$dsh_home" \
    "$USER_" "$GROUP"; then
    after=$(facts "$sentinel")
    if [[ $before != "$after" ]]; then
      fail_case "staging changed the root sentinel: ${before} -> ${after}"
    elif [[ $(stat -c %U "$stage_root") != root ]]; then
      fail_case "the staging tree is no longer root-owned"
    elif [[ ! -f $dsh_home/profiles/m5b/cordis.patch.yml ]]; then
      fail_case "the main profile was not installed"
    elif [[ ! -f $dsh_home/profiles/m5b-b/cordis.patch.yml ]]; then
      fail_case "the extra-repository profile was not installed"
    else
      pass_case "main and extra-repository staging run as the identity; sentinel content/metadata unchanged"
    fi
  else
    fail_case "the extra-repository stage failed"
  fi
else
  fail_case "the main stage failed"
fi
echo

# --- 3. control/scratch partition ------------------------------------------
echo "## 3. root control inputs vs identity scratch"
case_root="$SANDBOX/case-control"
control="$case_root/control"
scratch="$case_root/tmp"
mkdir -p "$control" "$scratch"
chmod 0755 "$case_root" "$control"
chown root:root "$control"
chmod 0755 "$control"
chown "$USER_:$GROUP" "$scratch"
chmod 0700 "$scratch"
if runuser -u "$USER_" -- test -w "$control"; then
  fail_case "the identity can write the root-owned control directory"
else
  pass_case "the identity cannot write the root control directory"
fi
sentinel="$case_root/host-sentinel"
make_sentinel "$sentinel" "HOST-SCRATCH-SENTINEL"
before=$(facts "$sentinel")
runuser -u "$USER_" -- ln -s "$sentinel" "$scratch/worker-mem.txt"
if m5b_lowpriv remove --user "$USER_" --root "$scratch" --path "$scratch/worker-mem.txt" \
  >/dev/null 2>&1; then
  if [[ $before == "$(facts "$sentinel")" ]]; then
    pass_case "identity scratch cleanup unlinks the link, not the host sentinel"
  else
    fail_case "identity scratch cleanup changed the host sentinel"
  fi
else
  fail_case "identity scratch cleanup failed"
fi
echo

# --- 4. read-only --check does not mutate --------------------------------
echo "## 4. prepare-nonroot.sh --check is read-only"
wrapper="$M5B_MATRIX_ROOT/scripts/m5b/matrix/gh-m5b.sh"
before_wrapper=$(facts "$wrapper")
bash "$HERE/prepare-nonroot.sh" --check >/dev/null 2>&1 || true
after_wrapper=$(facts "$wrapper")
if [[ $before_wrapper == "$after_wrapper" ]]; then
  pass_case "--check left the gh wrapper content and mode unchanged"
else
  fail_case "--check mutated the gh wrapper: ${before_wrapper} -> ${after_wrapper}"
fi
echo

if (( FAILURES > 0 )); then
  echo "verdict=FAILED failures=${FAILURES}"
  exit 1
fi
echo "verdict=PASS"
