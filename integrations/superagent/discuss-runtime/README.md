# Isolated discussion runtime

The executing runtime may keep GitHub/Bridge write credentials; a discussion must
not. This directory contains the environment-level mechanism used by M4:

- `discuss-sandbox.sh` runs as root, copies the ticket worktree to a root-owned
  read-only snapshot (`/srv/m4-discuss/workspace`, directories 555, files 444),
  then `setpriv`s to a dedicated user (`moyu-discuss`, configurable) and boots a
  headless DSH profile. The snapshot is readable by that user and cannot be
  written or chmodded by it; `/root` credentials are inaccessible by UID.
- `cordis.patch.yml` is the discussion profile patch: no bash/pwsh/jobs/subagent/
  workflow/working-directory tools, `tool-fs` write/edit disabled, read-only
  sandbox with `workspaceRoot: /srv/m4-discuss/workspace`, and the model provider.

Deployment steps:

```sh
useradd -r -m -d /home/moyu-discuss -s /usr/sbin/nologin moyu-discuss
install -d -m 755 /srv/m4-discuss /home/moyu-discuss/.dsh/profiles/discuss
install -m 755 integrations/superagent/discuss-runtime/discuss-sandbox.sh /usr/local/bin/m4-discuss-sandbox
install -m 644 integrations/superagent/discuss-runtime/cordis.patch.yml \
  /home/moyu-discuss/.dsh/profiles/discuss/cordis.patch.yml
# Put only COMMAND_CODE_API_KEY in /home/moyu-discuss/.dsh/.env (mode 600).
# Point the executor setting at the script:
#   discussCommand=/usr/local/bin/m4-discuss-sandbox
```

The script writes sanitized evidence to `/tmp/m4-discuss-evidence.log`: host UID,
discussion UID, snapshot mode/owner, whether `/root/.dsh-m4/env` and the SSH key
are readable, and whether a worktree write is denied.
