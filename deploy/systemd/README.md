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
