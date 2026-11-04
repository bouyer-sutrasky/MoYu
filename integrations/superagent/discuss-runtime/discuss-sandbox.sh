#!/bin/bash
set -euo pipefail
WORK="${DSH_DISCUSS_WORKTREE:?}"
PROMPT="${DSH_DISCUSS_PROMPT_FILE:?}"
RUN="${DSH_DISCUSS_RUN:?}"
VIEW="${DSH_DISCUSS_VIEW:?}"
USER="${DISCUSS_USER:-moyu-discuss}"
SOURCE_PROFILE="${DISCUSS_PROFILE_SOURCE:-/home/${USER}/.dsh/profiles/discuss}"
MODEL_ENV="${MODEL_ENV_FILE:-/root/.dsh-m4/.env}"
KEY=$(grep '^COMMAND_CODE_API_KEY=' "$MODEL_ENV" | cut -d= -f2-)
EVIDENCE="${DISCUSS_EVIDENCE:-/tmp/m4-discuss-evidence.log}"
# Remove only a run directory this script owns, under the fixed absolute root.
RUN=$(realpath -m -- "$RUN")
VIEW=$(realpath -m -- "$VIEW")
case "$RUN" in /srv/m4-discuss/runs/*/*) ;; *) echo "refusing run path $RUN" >&2; exit 64 ;; esac
case "$VIEW" in "$RUN"/workspace) ;; *) echo "refusing view path $VIEW" >&2; exit 64 ;; esac
[ -f "$RUN/.owned" ] && rm -rf -- "$RUN"
rm -rf -- "$RUN"; mkdir -p -- "$RUN/home" "$RUN/dsh/profiles/discuss" "$VIEW"
echo $$ > "$RUN/shell.pid"
: > "$RUN/.owned"
cp -- "$SOURCE_PROFILE/cordis.yml" "$SOURCE_PROFILE/package.json" "$SOURCE_PROFILE/cordis.patch.yml" "$RUN/dsh/profiles/discuss/"
cp -a -- "$WORK"/. "$VIEW"/
chmod -R a+rX -- "$VIEW"; chmod -R a-w -- "$VIEW"; chown -R root:root -- "$VIEW"
chmod 755 -- /srv /srv/m4-discuss /srv/m4-discuss/runs "$(dirname "$RUN")" "$RUN"; chmod 555 -- "$VIEW"
chown -R "$USER" -- "$RUN/home" "$RUN/dsh"
{
  echo "at=$(date -u +%FT%TZ) run=$RUN"
  echo "worktree_source=$WORK"
  echo "provider=${DSH_DISCUSS_PROVIDER:-default} model=${DSH_DISCUSS_MODEL:-default} reasoning=${DSH_DISCUSS_REASONING:-default}"
  echo -n "host_uid="; id -u
  echo -n "discuss_identity="; setpriv --reuid="$USER" --regid="$USER" --init-groups id
  stat -c 'workdir=%U %G %a %n' "$VIEW"
  if setpriv --reuid="$USER" --regid="$USER" --init-groups test -r /root/.dsh-m4/env; then echo "root_env_readable=yes"; else echo "root_env_readable=no"; fi
  if setpriv --reuid="$USER" --regid="$USER" --init-groups touch "$VIEW/.write-probe" 2>/dev/null; then echo "worktree_write=allowed"; else echo "worktree_write=denied"; fi
  if setpriv --reuid="$USER" --regid="$USER" --init-groups test -r /root/.ssh/id_ed25519; then echo "ssh_key_readable=yes"; else echo "ssh_key_readable=no"; fi
} >> "$EVIDENCE"
cleanup() { [ -f "$RUN/.owned" ] && rm -rf -- "$RUN"; }
trap cleanup EXIT
cd "$RUN/home"
MODEL=()
[ -n "${DSH_DISCUSS_PROVIDER:-}" ] && MODEL+=("DSH_DISCUSS_PROVIDER=$DSH_DISCUSS_PROVIDER")
[ -n "${DSH_DISCUSS_MODEL:-}" ] && MODEL+=("DSH_DISCUSS_MODEL=$DSH_DISCUSS_MODEL")
[ -n "${DSH_DISCUSS_REASONING:-}" ] && MODEL+=("DSH_DISCUSS_REASONING=$DSH_DISCUSS_REASONING")
setpriv --reuid="$USER" --regid="$USER" --init-groups env -i \
  HOME="$RUN/home" DSH_HOME="$RUN/dsh" DSH_DISCUSS_WORKSPACE="$VIEW" \
  COMMAND_CODE_API_KEY="$KEY" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "${MODEL[@]}" dsh --profile discuss headless "$(cat "$PROMPT")"
