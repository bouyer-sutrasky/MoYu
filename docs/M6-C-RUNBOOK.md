# MoYu M6-C runbook

This runbook describes the **current** candidate/production-capable stack on
`jd-mc`. It is written to be executable without guessing paths, ports,
migration counts or service identities. Re-read `docs/environment-baseline.md`
and the latest `docs/evidence/m6c/<run-id>/release-manifest.json` before a
release window; the values below are a 2026-11-16 baseline, not a permanent
promise.

## Current entry and services

| component | unit | user | listen |
| --- | --- | --- | --- |
| API + web | `moyu-m6c-api.service` | `moyu-m6c` | `127.0.0.1:4310` |
| supervisor | `moyu-m6c-supervisor.service` | `moyu-m6c` | `127.0.0.1:4491` |
| dispatcher | `moyu-m6c-dispatcher.service` | `moyu-m6c` | none |
| runtime instances | started by the supervisor | per-repository identity when configured; otherwise the candidate fallback | `3461/3462`, `3463/3464`, `3465/3466` |
| review checks | child of the supervisor | `moyu-m6c-check` / per-repository check identity when configured | none |

As of 2026-11-16 the public entry `https://moyu.sutrasky.com` is nginx →
`127.0.0.1:4310` and therefore reaches the candidate stack. The old
`moyu.service` is stopped but still enabled; do not start it while the M6-C
stack owns the entry. The three M6-C services must always run from the same
immutable release and manifest.

## Paths

```
/opt/moyu-m6c/current                     atomic symlink to one release
/opt/moyu-m6c/releases/<sha>              immutable release directories
/opt/moyu-m6c/artifacts/superagent-<sha>  pinned dsh-superagent artifact
/opt/moyu-m6c/profile-template            DSH profile template
/opt/moyu-m6c/runtime/{node24,pnpm}       Node 24 and standalone pnpm
/etc/moyu-m6c/{api,supervisor,dispatcher}.env   0600 root-owned values
/etc/moyu-m6c/instances.json              repository -> profile/port mapping
/var/lib/moyu-m6c/{dsh,credentials,instances,logs,worktrees,artifacts}
```

Never edit files inside `/opt/moyu-m6c/releases/<sha>` after it is built. A new
release is a new directory; `current` changes atomically.

## Start and stop

Migrations run **before** the supervisor starts because it reads
`repositories.check_commands`:

```bash
cd /opt/moyu-m6c/current
set -a; . /etc/moyu-m6c/api.env; set +a
/opt/moyu-m6c/runtime/node24/bin/node \
  /opt/moyu-m6c/runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs \
  --filter @moyu/db db:migrate

systemctl start moyu-m6c.slice
systemctl start moyu-m6c-api.service
# Wait for /readyz before starting the supervisor.
systemctl start moyu-m6c-supervisor.service
systemctl start moyu-m6c-dispatcher.service
```

Stop in the reverse order so no dispatcher delivers into a runtime whose
supervisor is already gone:

```bash
systemctl stop moyu-m6c-dispatcher.service
systemctl stop moyu-m6c-supervisor.service
systemctl stop moyu-m6c-api.service
systemctl stop moyu-m6c.slice
```

Instances start on demand. They are deliberately not enabled at boot: a
repository that was sleeping before a host reboot must not be resurrected by
the reboot. The supervisor's persisted `desired_state` is authoritative.

## Health and actual-artifact verification

```bash
curl -fsS http://127.0.0.1:4310/readyz
TOKEN=$(grep '^SUPERVISOR_TOKEN=' /etc/moyu-m6c/supervisor.env | cut -d= -f2-)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4491/control/v1/health
curl -fsS https://moyu.sutrasky.com/readyz
```

The dispatcher has no HTTP health endpoint. Prove it with the process, its
`dispatcher.ready` log, the durable `runtime_cursors`, and an actual
`deliveries` row.

For every release, run the manifest verifier. It reads `systemctl MainPID`,
`/proc/<pid>/cwd`, `/proc/<pid>/cmdline`, the artifact SHA-256 under the actual
cwd, and the health endpoints:

```bash
node scripts/m6c/verify-running.mjs \
  --manifest docs/evidence/m6c/<run-id>/release-manifest.json \
  --unit-prefix moyu-m6c \
  --release-root /opt/moyu-m6c/current \
  --supervisor-token-file /etc/moyu-m6c/supervisor-token
```

All three lines must say `OK`. A healthy HTTP response alone is not enough; a
mixed-release stack can still answer one endpoint.

## Logs and credentials

Logs: `/var/lib/moyu-m6c/logs/{api,supervisor,dispatcher}.log` and
`/var/lib/moyu-m6c/logs/<profile>.log`.

Per-repository Bridge credentials are written by the supervisor to
`/var/lib/moyu-m6c/credentials/<repositoryId>.json` (0600). The database stores
only `file:<repositoryId>.json` and a SHA-256 of the callback token. The DSH
credential source is `/var/lib/moyu-m6c/dsh/.env`; never print or commit it.

## Release switch and rollback

A release switch is a **maintenance operation**, not a symlink-only action.

1. Freeze new admission: stop `moyu-m6c-dispatcher.service` first. Wait for
   in-flight deliveries and leases to settle; record the last cursor, delivery,
   operation and lease generation per repository.
2. Stop the supervisor and API. Verify no runtime worker or Bridge port remains.
3. Take a fresh consistent backup set with `scripts/m6c/backup.mjs` and verify
   every part hash before continuing.
4. Point `current` at the already-built candidate release, then start
   API → supervisor → dispatcher. Run `verify-running` after each service is
   healthy.
5. Run one real task, a stop/resume, and a settings readback before reopening
   admission.

Rollback to a **compatible** previous release uses the same sequence with the
previous immutable release:

```bash
systemctl stop moyu-m6c-dispatcher.service moyu-m6c-supervisor.service moyu-m6c-api.service
readlink -f /opt/moyu-m6c/current                 # record current and target SHA
ln -sfn /opt/moyu-m6c/releases/<previous-sha> /opt/moyu-m6c/current
systemctl start moyu-m6c-api.service
systemctl start moyu-m6c-supervisor.service
systemctl start moyu-m6c-dispatcher.service
node scripts/m6c/verify-running.mjs --manifest /opt/moyu-m6c/releases/<previous-sha>/release-manifest.json --release-root /opt/moyu-m6c/current
```

The database migration ledger must be compatible with the target release. Do
**not** delete the live database, delete users, or `rm -rf` the live release to
“roll back”. If schema compatibility is not proven, restore the matching
backup into a dedicated restore database, validate it, and perform an
owner-approved data cutover.

`dropdb`, `userdel`, `rm -rf /opt/moyu-m6c`, and similar commands are **not** part
of upgrade or rollback. They are historical teardown actions that require a
separate owner-approved decommissioning request, a fresh verified backup, and a
confirmed replacement stack.

## Backups and restores

Use the scripts; do not copy a live SQLite file manually.

```bash
node scripts/m6c/backup.mjs --status \
  --db-url-file /etc/moyu-m6c/api.env \
  --dsh-home /var/lib/moyu-m6c/dsh

node scripts/m6c/backup.mjs \
  --set RUN-<timestamp> \
  --out /root/m6c-backups/RUN-<timestamp> \
  --db-url-file /etc/moyu-m6c/api.env \
  --dsh-home /var/lib/moyu-m6c/dsh \
  --worktrees /var/lib/moyu-m6c/worktrees \
  --release-root /opt/moyu-m6c/current \
  --stop-writers --start-after
```

The backup set contains a PostgreSQL custom dump, consistent SQLite backups
made with `node:sqlite`'s backup API, the DSH state archive, optional worktrees,
and a `manifest.json` with every SHA-256. Restore into a dedicated database
only:

```bash
node scripts/m6c/restore.mjs \
  --set-dir /root/m6c-backups/RUN-<timestamp> \
  --target-db-url-file /root/m6c-restore-db.env \
  --admin-url-file /root/m6c-admin.env \
  --target-dsh-home /var/lib/moyu-m6c-restore/dsh \
  --restore-state
```

Before enabling delivery after a restore, reconcile the recorded GitHub
Issue/PR/comment/commit ids and the `ticket/trigger/delivery/lease/cursor`
rows. The restore script deliberately does not start services or consume
GitHub.

## Plugin rollback

The runtime plugin is loaded through each profile's
`node_modules/dsh-superagent` link. A plugin rollback must update **every**
active profile, then sleep/wake or restart the affected instances and verify
the new PID plus `panel/settings` and `/deployment` values:

```bash
for link in /var/lib/moyu-m6c/dsh/profiles/*/node_modules/dsh-superagent; do
  ln -sfn /opt/moyu-m6c/artifacts/<target-artifact> "$link"
done
```

A link change alone is not evidence: the instance must reload, and the actual
plugin entry hash must be read back from the running process.

## Migrations

The migration count is the number of entries in
`packages/db/migrations/meta/_journal.json`, not a hard-coded 19. As of the
2026-11-16 baseline the journal ends at
`0019_event_dedupe_per_repository`; the live `moyu_m6c` ledger has 20 rows.
Always verify the actual ledger and the target database name before running
`db:migrate`. The `0019` rollback script is guarded and refuses when a later
migration, a duplicate ledger row, a drifted index, or cross-repository event
ids make the old global index unsafe.

## Evidence

Every operation belongs in `docs/evidence/m6c/<run-id>/`: environment, UTC
time, full Git SHA, artifact hash, command, exit code, actual result, and a
locatable path. Sensitive backups and credentials stay in a restricted store,
never in the repository.
