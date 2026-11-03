#!/usr/bin/env bash
# Builds the MoYu M3 upstream half: applies the ordered patches in ./patches to a pristine pinned
# dsh-superagent tree, type-checks and builds it, and copies the package into an output directory.
#
# Usage: build-patched.sh [source-tree] [output-dir]
#   source tree   a pristine dsh-superagent 6337fc8… checkout; also read from $UPSTREAM_SRC
#   output dir    default: <this directory>/build
#
# The patches are applied with `git apply --check` and then `git apply` in order. Any failure stops the
# build with a non-zero exit: a patch is never fuzzed, forced, or partially applied. Node and pnpm are
# pinned (Node 22.23.3 semantics, corepack pnpm@11.7.0) and the same command environment as the M0
# baseline is used, so a dirty worker shell cannot change the result.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PATCH_DIR="$HERE/patches"
UPSTREAM_SRC=${1:-${UPSTREAM_SRC:-}}
OUT=${2:-"$HERE/build"}

if [ -z "$UPSTREAM_SRC" ]; then
  echo "error: give the pristine dsh-superagent tree as the first argument or in UPSTREAM_SRC" >&2
  exit 2
fi
if [ ! -f "$UPSTREAM_SRC/package.json" ] || [ ! -f "$UPSTREAM_SRC/pnpm-lock.yaml" ]; then
  echo "error: $UPSTREAM_SRC is not a dsh-superagent source tree (package.json/pnpm-lock.yaml missing)" >&2
  exit 2
fi
if [ -e "$UPSTREAM_SRC/src/app/bridge.ts" ] || [ -e "$UPSTREAM_SRC/src/sources/workspace.ts" ]; then
  echo "error: $UPSTREAM_SRC already contains the M3 patches; point at the pristine tree" >&2
  exit 2
fi

PATCHES=()
while IFS= read -r patch; do PATCHES+=("$patch"); done < <(find "$PATCH_DIR" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.patch' | sort)
if [ "${#PATCHES[@]}" -eq 0 ]; then
  echo "error: no ordered patches in $PATCH_DIR" >&2
  exit 2
fi

# The clean environment of the M0 evidence run; override the three directories if the host layout differs.
BUILD_HOME=${BUILD_HOME:-/root/src/upstream/m0-home}
BUILD_COREPACK_HOME=${BUILD_COREPACK_HOME:-/root/src/upstream/.corepack}
BUILD_PATH=${BUILD_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
pnpm() { env -i HOME="$BUILD_HOME" PATH="$BUILD_PATH" COREPACK_HOME="$BUILD_COREPACK_HOME" CI=1 corepack pnpm@11.7.0 "$@"; }

BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/moyu-m3-upstream.XXXXXX")
cleanup() { rm -rf "$BUILD_DIR"; }
trap cleanup EXIT

echo "==> source: $UPSTREAM_SRC"
echo "==> build:  $BUILD_DIR"
echo "==> output: $OUT"
# Copy the source tree only: node_modules, lib, and .artifacts are build products of the pinned tree, and a
# nested .git (when the source is a checkout) must not leak into the patched tree.
rsync -a --exclude node_modules --exclude lib --exclude .artifacts --exclude .git "$UPSTREAM_SRC"/ "$BUILD_DIR"/

echo "==> applying ${#PATCHES[@]} patches in order"
for patch in "${PATCHES[@]}"; do
  name=$(basename "$patch")
  echo "    git apply --check $name"
  if ! git -C "$BUILD_DIR" apply --check "$patch"; then
    echo "error: $name does not apply to the pristine tree; stopping without applying it" >&2
    exit 1
  fi
  git -C "$BUILD_DIR" apply "$patch"
done

# Reuse the dependencies of the tree this copy came from: the copy has the same package.json and lockfile,
# so pnpm would install exactly these. Anything else gets a real frozen-lockfile install.
if [ -d "$UPSTREAM_SRC/node_modules" ]; then
  echo "==> reusing node_modules of the same source tree"
  cp -a "$UPSTREAM_SRC/node_modules" "$BUILD_DIR/node_modules"
else
  echo "==> pnpm install --frozen-lockfile"
  (cd "$BUILD_DIR" && pnpm install --frozen-lockfile)
fi

echo "==> pnpm typecheck"
(cd "$BUILD_DIR" && pnpm typecheck)
echo "==> pnpm build"
(cd "$BUILD_DIR" && pnpm build)

for artifact in lib/index.js lib/workspace-watch.js; do
  if [ ! -f "$BUILD_DIR/$artifact" ]; then
    echo "error: the build did not produce $artifact" >&2
    exit 1
  fi
done
if ! grep -q "MOYU_BRIDGE_TOKEN" "$BUILD_DIR/lib/index.js"; then
  echo "error: lib/index.js does not contain the patched Runtime (no MOYU_BRIDGE_TOKEN)" >&2
  exit 1
fi

echo "==> copying the built package to $OUT"
mkdir -p "$OUT"
rm -rf "$OUT/lib" "$OUT/node_modules"
for item in lib package.json cordis.patch.yml prompts skills locale; do
  if [ -e "$BUILD_DIR/$item" ]; then cp -a "$BUILD_DIR/$item" "$OUT/"; fi
done
# The bundle resolves its external runtime dependencies (`zod`, `proper-lockfile`, `@deepseek-ai/*`)
# from its own directory, exactly like the installed bootstrap bundle. Ship them with the package so
# the out directory is a complete, loadable artifact.
cp -a "$BUILD_DIR/node_modules" "$OUT/node_modules"

echo "==> done"
echo "lib files: $(find "$OUT/lib" -maxdepth 1 -type f | wc -l)"
sha256sum "$OUT/package.json" "$OUT/cordis.patch.yml" "$OUT/lib/index.js" "$OUT/lib/workspace-watch.js"
