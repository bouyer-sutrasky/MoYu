# M6-C verification record

Status: **in progress**. Only rows marked Pass were executed and observed.
`Not run` means no evidence exists; it is never a pass.

Run id: `M6C-CAND-20261115`. Host: jd-mc (117.72.211.55). Isolated candidate stack;
production untouched.

## Baselines

| item | value | source |
| --- | --- | --- |
| main before this work | `115d43d166465f211ba0a8d177fad3712e9162a0` | `git ls-remote` on jd-mc |
| PR #64 head | `ad9650631bc3289cff7d7da9a79e7cc0800e68d7` | GitHub API |
| PR #64 required CI | run 43159152350, check + integration both `pass` | `gh pr checks 64` |
| merge | squash with `--match-head-commit`, 2026-11-15T10:21:42Z | GitHub API |
| main after merge | `ff4785f026c9f26fb6d29d868454313858a0b650` | `git rev-parse origin/main` |
| pinned upstream | `6337fc823ce20251c8de8085948165c81aaa701e` | `integrations/superagent/upstream.lock.json` |

## Artifact

| item | value |
| --- | --- |
| build | `integrations/superagent/build-patched.sh`, pristine tree, patches 0001–0025 |
| output | `/opt/moyu-m6c/artifacts/superagent-ad9650631bc3` |
| `lib/index.js` sha256 | `07f46473b150ec97e35f1fe45090946df8e966f847c5269bcd5b2190a9fdd49b` |
| reproducibility | byte-identical to the previously verified `/root/src/upstream/l113-build1/lib/index.js` |

## Acceptance matrix

| # | Scenario | Expectation | Actual evidence | Result |
| --- | --- | --- | --- | --- |
| 1 | Baseline re-read (main, PR, CI, services, DB, ports, upstream lock, docs) | facts recorded with commands | `docs/evidence/m6c/RUN-20261115-candidate.md` | Pass |
| 2 | Two-chain trace (Web→API→dispatcher→supervisor→Bridge→Ticket/worker and GitHub→Trigger→Bridge→dispatcher) | every hop named | trace report; gaps listed in `M6-C-SETTINGS-MAPPING.md` | Pass |
| 3 | Pinned artifact build reproducible | same sha on rebuild | table above | Pass |
| 4 | Isolated candidate database | own DB, migrations applied | `moyu_m6c`: 19 migrations, 25 tables, `check_commands` column present | Pass |
| 5 | Non-root service identity | no unit runs as root | `User=moyu-m6c` on api/supervisor/dispatcher; check identity `987:981` | Pass |
| 6 | API health | `/readyz` 200 | 200 | Pass |
| 7 | Supervisor health | 200 with machine token, 401 without | 200 / 401 | Pass |
| 8 | Candidate HTTPS | own certificate, isolated upstream | `https://moyu-m6c.117-72-211-55.sslip.io/healthz` 200 | Pass |
| 9 | Production untouched | production still serves; nginx valid | `https://moyu.sutrasky.com/healthz` 200, `nginx -t` ok, sites list unchanged | Pass |
| 10 | Real browser passkey registration | owner created, setup entry closes | `candidate-bootstrap.json`: `initialized:true`, `setupOpen:false`, `/api/v1/auth/me` 200 | Pass (CDP virtual authenticator, **not** a real device) |
| 11 | Real browser passkey login | new session established | `candidate-login.json`: `me.status 200` | Pass (virtual authenticator) |
| 12 | Three repositories added | GitHub permission checked first | `owners=1 repositories=3` | Pass |
| 13 | Online cap = 2 | never >2 online; 3rd queued; idle eviction instead of over-cap | two `state=online` with distinct profile/panel/bridge/pid; `supervisor.evict_idle` | Pass |
| 14 | Owner config survives wake/restart | only invariants re-asserted, no spurious saves | `apps/supervisor/test/profile-config.test.ts` 10/10; `pnpm check` green | Pass (unit); live save→sleep→wake replay **Not run** |
| 15 | #64 supplemental verification | browser save, two repos with distinct commands, fail-closed, fresh worktree dependency install, check identity, timeout child cleanup | — | Not run |
| 16 | Instance settings API + Deployment adapter | revision/409 passthrough, per-instance mutate | — | Not run |
| 17 | Superagent settings UI port (5 groups) | upstream components adapted | — | Not run |
| 18 | Home page convergence | current repo, instance status, new task, short pending list | — | Not run |
| 19 | Real task → worker → PR | ticket, assignment, worker process, PR URL | — | Not run |
| 20 | Dual-entrance dedup (GitHub first / Web first) | exactly one effective execution | — | Not run |
| 21 | Backup / restore / migration rollback drill | restored dump compared field by field | — | Not run |
| 22 | Platform and plugin rollback rehearsal | previous build served then restored | — | Not run |
| 23 | Desktop + mobile, light + dark screenshots | four real screenshots | one desktop light screenshot | Not run |

## Environment faults found and fixed in this run

1. Supervisor aborted with `filesystem_error: Permission denied [/root/src/upstream/...]`:
   the profile template linked the artifact under `/root`, unreadable by the service user.
   Fixed by publishing the artifact to `/opt/moyu-m6c/artifacts/` and re-pointing the template.
2. `memory_limit_unavailable`: `ProtectSystem=strict` made `/sys/fs/cgroup` read-only and the
   unit cgroup still held the service process, so the memory controller could not be enabled
   for child cgroups. Fixed with `ReadWritePaths=/sys/fs/cgroup` plus
   `DelegateSubgroup=supervisor` (systemd 255), which empties the unit cgroup and allows
   `+memory +pids` in `cgroup.subtree_control`.
3. The distribution corepack shim reads `/root/.corepack.env` and cannot be used by a
   non-root service. Replaced with a standalone `pnpm@11.7.0` under
   `/opt/moyu-m6c/runtime/pnpm` plus a `pnpm` shim on the service `PATH`.
4. The first Let's Encrypt issuance failed with `Timeout during connect` during secondary
   validation; the immediate retry succeeded. Port 80 of the candidate vhost was reachable
   from an external client while the failure was reported.

## Not verified anywhere in this document

Settings UI port, instance settings API, Deployment adapter, home page redesign, real task
execution, dual-entrance dedup, backup/restore, platform and plugin rollback, mobile and dark
theme screenshots, and the live save→sleep→wake configuration replay.

## 2026-11-15 18:34 (+08:00) — first real end-to-end execution

The Web → API → dispatcher → Bridge → Ticket → DSH worker → Git push → PR chain was executed
once against the isolated candidate stack (repository `Bouyer12/m5a-alpha-adf10ad9`).

| step | observed |
| --- | --- |
| task created (web API) | conversation `942b50de…` then `1693adde-5029-458e-a309-557b7714b55b` |
| delivery to the repository Bridge | `deliveries.state=delivered`, `upstream_trigger_id=workspace:<messageId>` |
| ticket created by the Bridge | `253f6afcf4c2b3eaaa9e3ce3904303b2` (first attempt `80845ef8…`) |
| worker execution | `task_links.state=running` → `completed` |
| commit | `a3865370dfc26314264cacf3f6ca7c53082f4ea2`, author `Bouyer12 <202233540+Bouyer12@users.noreply.github.com>` |
| pull request | `https://github.com/Bouyer12/m5a-alpha-adf10ad9/pull/6`, OPEN, non-draft, 1 addition, file `M6C-PROBE.md` |
| file content read back from GitHub | `m6c candidate probe ok` |

Two real defects were found and fixed on the way:

1. **Worker had no Git identity.** The prepare command clones over
   `ssh://git@ssh.github.com:443` and the service user had no key or `known_hosts`;
   the first attempt failed with `Host key verification failed` and the runtime reported
   `The prepare command failed`. Fixed for the candidate by installing a 0600 SSH identity
   and `known_hosts` for `moyu-m6c` and verifying `git clone` as that user.
2. **A failed task wedged the repository forever.** `maintainLeases()` released a lease only
   for `waiting_input|awaiting_review|completed|closed_unmerged` and proven `stopped`. A task
   that reached `failed` kept `runtime_leases.state='active'` permanently; the next delivery
   retried with `waitingFor=execution_slot` and never progressed (observed 39 attempts), and
   `recovery_state` never becomes `recovered`, so nothing could clear it. `failed` is terminal
   and the runtime has already ended the assignment, so it was added to the release set.
   After the fix the stuck lease was released and the retry delivered on the next pass.
