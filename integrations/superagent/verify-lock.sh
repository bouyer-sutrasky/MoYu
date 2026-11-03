#!/usr/bin/env bash
# Read-only check that the installed superagent and Harness artifacts still match
# integrations/superagent/upstream.lock.json. It never writes to either tree.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lock="$root/upstream.lock.json"
superagent_dir=${SUPERAGENT_DIR:-/root/dsh-superagent}
dsh_dir=${DSH_DIR:-/usr/lib/node_modules/@deepseek-ai/dsh}
fail=0

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 2; }; }
need find
need sort
need xargs
need sha256sum
need node

lock_value() {
  node -e 'const lock = require(process.argv[1]); const path = process.argv[2].split("."); let value = lock; for (const part of path) value = value[part]; if (typeof value !== "string" && typeof value !== "number") { console.error("missing lock field: " + process.argv[2]); process.exit(2) } process.stdout.write(String(value))' "$lock" "$1"
}

manifest() {
  local dir=$1; shift
  local excludes=()
  for pattern in "$@"; do excludes+=( -not -path "$pattern" ); done
  ( cd "$dir" && find . -type f "${excludes[@]}" -print0 | sort -z | xargs -0 sha256sum | sed 's#  \./#  #' | sha256sum | cut -d' ' -f1 )
}

check() {
  local label=$1 expected=$2 actual=$3
  if [[ "$expected" == "$actual" ]]; then
    printf 'ok   %-52s %s\n' "$label" "$actual"
  else
    printf 'FAIL %-52s expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    fail=1
  fi
}

[[ -f "$lock" ]] || { echo "missing lock file: $lock" >&2; exit 2; }
[[ -d "$superagent_dir" ]] || { echo "missing superagent dir: $superagent_dir" >&2; exit 2; }
[[ -d "$dsh_dir" ]] || { echo "missing Harness dir: $dsh_dir" >&2; exit 2; }

harness_version=$(lock_value harness.version)
superagent_version=$(lock_value superagent.version)
check 'Harness package version' "$harness_version" "$(node -p "require('$dsh_dir/package.json').version")"
check 'superagent package version' "$superagent_version" "$(node -p "require('$superagent_dir/package.json').version")"

dsh_manifest=$(manifest "$dsh_dir" './node_modules/*')
check 'Harness package files manifest' "$(lock_value harness.install.packageFilesManifestSha256)" "$dsh_manifest"
check 'Harness entry sha256' "$(lock_value harness.install.entrySha256)" "$(sha256sum "$dsh_dir/lib/bin.js" | cut -d' ' -f1)"
check 'Harness package file count' "$(lock_value harness.install.packageFiles)" "$(cd "$dsh_dir" && find . -type f -not -path './node_modules/*' | wc -l | tr -d ' ')"

superagent_source_manifest=$(manifest "$superagent_dir" './node_modules/*' './lib/*' './.artifacts/*')
check 'superagent source manifest' "$(lock_value superagent.install.sourceFilesManifestSha256)" "$superagent_source_manifest"
check 'superagent source file count' "$(lock_value superagent.install.sourceFiles)" "$(cd "$superagent_dir" && find . -type f -not -path './node_modules/*' -not -path './lib/*' -not -path './.artifacts/*' | wc -l | tr -d ' ')"

superagent_lib_manifest=$(cd "$superagent_dir" && find lib -type f -print0 | sort -z | xargs -0 sha256sum | sed 's#  lib/#  #' | sha256sum | cut -d' ' -f1)
check 'superagent lib manifest' "$(lock_value superagent.install.libFilesManifestSha256)" "$superagent_lib_manifest"
check 'superagent lib file count' "$(lock_value superagent.install.libFiles)" "$(cd "$superagent_dir" && find lib -type f | wc -l | tr -d ' ')"

if [[ -n "${SUPERAGENT_TARBALL:-}" ]]; then
  check 'superagent tarball sha256' "$(lock_value superagent.tarball.sha256)" "$(sha256sum "$SUPERAGENT_TARBALL" | cut -d' ' -f1)"
fi
if [[ -n "${DSH_TARBALL:-}" ]]; then
  check 'Harness tarball sha256' "$(lock_value harness.npm.sha256)" "$(sha256sum "$DSH_TARBALL" | cut -d' ' -f1)"
fi

if (( fail )); then
  echo >&2
  echo "baseline mismatch: installed artifacts differ from $lock" >&2
  exit 1
fi
echo
echo "baseline ok: installed artifacts match $lock"
