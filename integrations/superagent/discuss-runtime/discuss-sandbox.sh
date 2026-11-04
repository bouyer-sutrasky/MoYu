#!/bin/bash
set -euo pipefail
WORK="${DSH_DISCUSS_WORKTREE:?}"
PROMPT="${DSH_DISCUSS_PROMPT_FILE:?}"
KEY=$(grep '^COMMAND_CODE_API_KEY=' ${MODEL_ENV_FILE:-/root/.dsh-m4/.env} | cut -d= -f2-)
EVIDENCE=/tmp/m4-discuss-evidence.log
VIEW=${DISCUSS_VIEW:-/srv/m4-discuss/workspace}
rm -rf "$VIEW"
mkdir -p "$VIEW" ${DISCUSS_HOME:-/home/${DISCUSS_USER:-moyu-discuss}}/run
# A read-only snapshot: the discussion runtime never sees the writable worktree
# or its owner. Root owns the copy at 555/444, so the dedicated user cannot chmod it.
cp -a "$WORK"/. "$VIEW"/
chmod -R a+rX "$VIEW"
chmod -R a-w "$VIEW"
chown -R root:root "$VIEW"
chmod 755 /srv /srv/m4-discuss "$VIEW"
{
  echo "at=$(date -u +%FT%TZ)"
  echo "worktree_source=$WORK"
  echo -n "host_uid="; id -u
  echo -n "discuss_identity="; setpriv --reuid=${DISCUSS_USER:-moyu-discuss} --regid=${DISCUSS_USER:-moyu-discuss} --init-groups id
  stat -c 'workdir=%U %G %a %n' "$VIEW"
  if setpriv --reuid=${DISCUSS_USER:-moyu-discuss} --regid=${DISCUSS_USER:-moyu-discuss} --init-groups test -r /root/.dsh-m4/env; then echo "root_env_readable=yes"; else echo "root_env_readable=no"; fi
  if setpriv --reuid=${DISCUSS_USER:-moyu-discuss} --regid=${DISCUSS_USER:-moyu-discuss} --init-groups touch "$VIEW/.write-probe" 2>/dev/null; then echo "worktree_write=allowed"; else echo "worktree_write=denied"; fi
  if setpriv --reuid=${DISCUSS_USER:-moyu-discuss} --regid=${DISCUSS_USER:-moyu-discuss} --init-groups test -r /root/.ssh/id_ed25519; then echo "ssh_key_readable=yes"; else echo "ssh_key_readable=no"; fi
} >> "$EVIDENCE"
cd ${DISCUSS_HOME:-/home/${DISCUSS_USER:-moyu-discuss}}/run
exec setpriv --reuid=${DISCUSS_USER:-moyu-discuss} --regid=${DISCUSS_USER:-moyu-discuss} --init-groups env -i \
  HOME=${DISCUSS_HOME:-/home/${DISCUSS_USER:-moyu-discuss}} DSH_HOME=${DISCUSS_HOME:-/home/${DISCUSS_USER:-moyu-discuss}}/.dsh COMMAND_CODE_API_KEY="$KEY" \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  dsh --profile discuss headless "$(cat "$PROMPT")"
