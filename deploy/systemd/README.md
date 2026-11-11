# M5-B system boundary (isolated test service)

The M5-B resource model has two layers:

1. **One enforceable cgroup boundary** — `moyu-m5b.slice` with `MemoryMax=8G`
   (and `MemoryHigh=6G`). Platform API, dispatcher, supervisor, the isolated
   PostgreSQL and every runtime instance must be in this slice. Per-instance
   `memory.max` is only the second layer; it does not replace the slice.
2. **Measured admission** — the supervisor samples `memory.current`,
   `memory.peak`, `memory.events` and host `MemAvailable`, then admits a new
   instance only below the scheduling budget or with real host headroom up to
   the hard limit. Sampling alone is not presented as enforcement.

## Test-service layout

systemd nests a slice whose name contains a dash under the shorter parent slice; verify the
real path instead of hard-coding it:

```bash
systemctl show -p ControlGroup moyu-m5b.slice
# example: /moyu.slice/moyu-m5b.slice
```

```text
/sys/fs/cgroup/moyu.slice/moyu-m5b.slice/                          memory.max = 8G (systemd)
/sys/fs/cgroup/moyu.slice/moyu-m5b.slice/platform/                 API + dispatcher cgroup
/sys/fs/cgroup/moyu.slice/moyu-m5b.slice/postgres/                 isolated test cluster
/sys/fs/cgroup/moyu.slice/moyu-m5b.slice/moyu-m5b-supervisor.service/
    payload/                                                       the supervisor's own processes
    instances/<profile>-<timestamp>/                               per-instance cgroups (supervisor-created)
```

The instance cgroups live in a directory the supervisor creates inside its own
delegated unit cgroup; nothing has to be pre-created and no controller has to be
enabled by hand. On a blank delegated directory the supervisor

1. creates `MOYU_CGROUP_ROOT` (and any missing level),
2. enables `+memory +pids` there, and on its immediate parent when the parent is
   the level that still has to hand the controllers down,
3. verifies that the new per-instance cgroup really has `memory.current`,
   `memory.max` and `pids.current`.

Any failure is reported as `cgroup_unavailable` with the exact step and OS error,
and no runtime is started outside the boundary. This needs the unit cgroup to be
empty of the service's own processes, which is why the unit uses
`Delegate=yes` + `DelegateSubgroup=payload`. If a delegated level cannot hand
the controllers down, the supervisor says so instead of starting an unmetered
runtime; do not "fix" it by pre-creating directories as root, because the
unprivileged service could not manage what root created.

Set these variables for the supervisor:

```dotenv
AGGREGATE_CGROUP=/sys/fs/cgroup/moyu.slice/moyu-m5b.slice
PLATFORM_CGROUP=/sys/fs/cgroup/moyu.slice/moyu-m5b.slice/platform
POSTGRES_CGROUP=/sys/fs/cgroup/moyu.slice/moyu-m5b.slice/postgres
# Inside the unit's own delegated cgroup; verify the real path with
#   systemctl show -p ControlGroup moyu-m5b-supervisor.service
MOYU_CGROUP_ROOT=/sys/fs/cgroup/moyu.slice/moyu-m5b.slice/moyu-m5b-supervisor.service/instances
MEMORY_TARGET_MB=4096
MEMORY_BUDGET_MB=6144
MEMORY_HARD_LIMIT_MB=8192
MEMORY_RESERVE_MB=1024
MEMORY_HYSTERESIS_MB=256
INSTANCE_MEMORY_MAX_MB=3072
INSTANCE_MEMORY_HIGH_MB=2560
```

The supervisor refuses admission when the live slice limit is above
`MEMORY_HARD_LIMIT_MB`, when the aggregate is above the hard limit, when a
managed cgroup or the slice boundary cannot be measured, or when the host has no
measured headroom. An unreadable cgroup is shown as unknown and counted at the
instance estimate; estimated bytes are never written to measured fields.

Verify the effective membership:

```bash
systemctl show -p ControlGroup moyu-m5b-supervisor.service
systemd-cgls --unit moyu-m5b-supervisor.service
```

## Verification and rollback

Read-only check: `bash scripts/m5b/aggregate-cgroup-check.sh`.

Rollback of the test service is `systemctl stop` of the M5-B units followed by
removal of the slice; no production unit or shared cgroup configuration is
changed by this repository.

## Review check identity

Review checks are repository-controlled code, so they do not run as the
supervisor. The supervisor stays as `moyu-m5b` with `NoNewPrivileges=yes`; the
unit gets only `CAP_SETUID`/`CAP_SETGID`, and `runChecks` wraps each command in
`setpriv --reuid=<uid> --regid=<gid> --init-groups --no-new-privs`. A check
without the identity is refused in production instead of falling back to the
supervisor's uid.

Provision once (owner action; the unit fails to start if the group is missing):

```bash
groupadd --system moyu-check
useradd --system --gid moyu-check --home-dir /var/lib/moyu-check \
  --shell /usr/sbin/nologin moyu-check
install -m 0644 deploy/systemd/moyu-check.tmpfiles.conf /etc/tmpfiles.d/moyu-check.conf
systemd-tmpfiles --create /etc/tmpfiles.d/moyu-check.conf
usermod -aG moyu-check moyu-m5b
```

The worktree root is shared through a group instead of a recursive chown: new
files are created with the supervisor unit's `UMask=0002`, and the root is
setgid so the runtime's worktrees inherit `moyu-check`:

```bash
install -d -o moyu-m5b -g moyu-check -m 2775 "$WORKTREE_ROOT"
chgrp -R moyu-check "$WORKTREE_ROOT"   # only for trees created before this change
chgrp moyu-check "$(dirname "$WORKTREE_ROOT")"
chmod 0750 "$(dirname "$WORKTREE_ROOT")"
```

The supervisor env file then carries the identity:

```dotenv
REVIEW_CHECK_UID=<id -u moyu-check>
REVIEW_CHECK_GID=<id -g moyu-check>
REVIEW_CHECK_HOME=/var/lib/moyu-check/home
# REVIEW_CHECK_SETPRIV=/usr/bin/setpriv
```

`REVIEW_CHECK_HOME` is the check user's HOME (`/var/lib/moyu-check/home`), not
the supervisor's. `pnpm` writes its cache there; the check user's HOME stays
mode 700 and the supervisor cannot read it. `TMPDIR` remains the unit's private
`/tmp`, which is writable by the check user.

The check user must also be able to execute the Node/pnpm toolchain the
worktree's `node_modules` shebangs resolve through `PATH`. On the current host
`/opt/moyu-node24` is `0750 root:m5bmatrix`; either make that tree readable by
the service users or add `moyu-m5b` and `moyu-check` to its group. The
rehearsal in `scripts/m6a/check-identity-rehearsal.sh` uses a world-readable
copy of the same toolchain for this reason.

Verify from the supervisor log (`review.checks_finished` carries `identity`) and
from the raw process table while a check is running:

```bash
ps -o pid,ppid,uid,gid,cmd -C bash
```

The child's uid/gid must differ from the supervisor's; a same-uid or root
identity is refused before the first command.

## Production web shell identity

`moyu.service` is the web shell (API + built Web) behind nginx. Install the
non-root unit only after the owner has staged the build, created the user and
moved the env file; the live unit is not changed by this repository.

```bash
useradd --system --home-dir /var/lib/moyu --shell /usr/sbin/nologin moyu-web
install -d -m 0755 /opt/moyu/web
rsync -a --delete /root/src/widgets/ /opt/moyu/web/
chmod -R a+rX /opt/moyu/web
install -d -m 0750 -o moyu-web -g moyu-web /var/lib/moyu /var/lib/moyu/artifacts
install -d -m 0750 -o moyu-web -g moyu-web /var/log/moyu
install -d -m 0750 /etc/moyu
install -m 0600 -o root -g root /root/.moyu.env /etc/moyu/moyu.env
# In /etc/moyu/moyu.env: ARTIFACT_STORAGE_DIR=/var/lib/moyu/artifacts
install -m 0644 deploy/systemd/moyu.service /etc/systemd/system/moyu.service
systemctl daemon-reload
systemctl restart moyu.service
curl -fsS http://127.0.0.1:4300/readyz
```

`ProtectSystem=strict` leaves only `StateDirectory=moyu` and `LogsDirectory=moyu`
writable. A relative `ARTIFACT_STORAGE_DIR` (the development default
`.local/artifacts`) would point inside the read-only build and fail; set it in
the env file. `ProtectHome=yes` also means the old `/root/src/widgets` path is
not usable: the staged copy is the deployment. The log path moves from
`/var/log/moyu.log` to `/var/log/moyu/moyu.log`; update any logrotate rule to
match before switching.

The unit keeps the live `/usr/bin/node`. If the staged build requires the
repository's pinned Node 24, point `ExecStart=` at a Node 24 binary the service
user can execute (the host's `/opt/moyu-node24` is currently `0750
root:m5bmatrix`, so it is not usable as-is); the check identity note above
applies the same requirement to the supervisor and check users.

Rollback: reinstall the previous unit, `systemctl daemon-reload`, then
`systemctl restart moyu.service`. The live unit before this change and its
health output are recorded in `docs/evidence/m6a/P1A3b-check-identity.txt`.
