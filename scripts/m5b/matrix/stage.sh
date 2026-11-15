#!/usr/bin/env bash
# Stage one runtime profile and install it into a matrix-owned harness home.
#
# The staging tree is root-owned and never handed to the low-privilege identity:
# root writes the profile fixture there, makes it group-readable, and the
# identity itself copies the verified tree into its own home. A second
# (extra-repository) profile re-enters the same root-owned stage, so a replaced
# path in the identity's home can never redirect a root write.
#
#   stage_profile_tree PROFILE PORT PROFILE_SOURCE UPSTREAM_BUILD \
#       STAGE_ROOT DSH_HOME USER GROUP
stage_profile_tree() {
  local profile=$1 port=$2 profile_source=$3 upstream_build=$4
  local stage_root=$5 dsh_home=$6 user=$7 group=$8
  local stage="$stage_root/profiles/$profile"
  local file
  rm -rf "${stage:?}"
  mkdir -p "$stage/node_modules"
  for file in package.json cordis.patch.yml cordis.yml; do
    [[ -f $profile_source/$file ]] && cp "$profile_source/$file" "$stage/$file"
  done
  ln -sfn "$upstream_build" "$stage/node_modules/dsh-superagent"
  # The staged profile must point its state at this harness home; the supervisor
  # verifies that exact path before it reports the instance online.
  sed -i "/^- id: webserver/{n;n;n;s#^    port: .*#    port: $port#}" "$stage/cordis.patch.yml"
  sed -i "s#^    stateDir: .*#    stateDir: $dsh_home/state/$profile#" "$stage/cordis.patch.yml"
  grep -n "stateDir:" "$stage/cordis.patch.yml"
  # The isolated matrix runs on the loopback provider only. This fixture is
  # applied to the staged copy, so the shared m5b profile stays untouched.
  python3 - "$stage/cordis.patch.yml" <<'PYEOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = text.replace(
    """          - id: local-test
            name: Local Test
            contextWindow: 32768
            maxTokens: 4096""",
    """          - id: local-test
            name: Local Test
            contextWindow: 32768
            maxTokens: 4096
            reasoningEfforts:
              off: null
              low: low
              high: high""",
)
text = text.replace(
    """- id: agent-default-model
  config:
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash""",
    """- id: agent-default-model
  config:
    provider: local-test
    model: local-test""",
)
text = re.sub(r"      commandcode:\n(?:        .*\n)+", "", text)
open(path, "w").write(text)
PYEOF
  grep -n "provider: local-test\|reasoningEfforts\|commandcode" "$stage/cordis.patch.yml" | head -6
  # The fixture provider key lives in the staged home, never in the shared one.
  printf 'version: 1\nrefs:\n  LOCAL_TEST_API_KEY: local-test-dummy\n' \
    >"$stage_root/.credentials.yaml"
  # Root-owned, group-readable: root may still write here on a later call, while
  # the identity can only read. No chown to the identity happens in this tree.
  chgrp -R "$group" "$stage_root"
  find "$stage_root" -type d -exec chmod 0750 {} +
  find "$stage_root" -type f -exec chmod 0640 {} +
  # From here the identity performs the copy; a pre-created destination link can
  # only point at a path the identity itself may write.
  runuser -u "$user" -- bash -c '
    set -euo pipefail
    dsh=$1
    stage=$2
    profile=$3
    mkdir -p "$dsh/profiles" "$dsh/state" "$dsh/sessions"
    rm -rf -- "$dsh/profiles/${profile:?}"
    cp -R -- "$stage/profiles/$profile" "$dsh/profiles/$profile"
    cp -- "$stage/.credentials.yaml" "$dsh/.credentials.yaml"
    chmod 0700 "$dsh" "$dsh/profiles" "$dsh/state" "$dsh/sessions" "$dsh/profiles/$profile"
    chmod 0600 "$dsh/.credentials.yaml"
  ' _ "$dsh_home" "$stage_root" "$profile" || return 1
  echo "dsh_home=$dsh_home profile=$stage/profile owner=$(stat -c %U:%G "$dsh_home")"
  echo "staged_stage=$stage_root owner=$(stat -c %U:%G "$stage_root") mode=$(stat -c %a "$stage_root")"
}
