# M6-C verification record

> **Historical snapshot.** The final 2026-11-16 evidence, main SHA, release
> hashes and the remaining Pass/Partial/Blocked rows are in
> [`docs/M6-C-FINAL-STATUS-2026-11-16.md`](./M6-C-FINAL-STATUS-2026-11-16.md)
> and `docs/evidence/m6c/M6C-RUN-20261116-1250/matrix.json`. This file must not
> be used as a production sign-off.

Status: **in progress** (historical). Only rows marked Pass were executed and observed.
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

## 2026-11-15 18:44 (+08:00) — formal cutover to moyu.sutrasky.com (owner authorised)

The owner explicitly instructed "切换候选". `moyu.sutrasky.com` now serves the isolated
candidate stack.

Pre-change snapshot: `/root/m6c-cutover-pre-20261115T104312Z.txt`.
Candidate database dump taken before the owner reset:
`/root/m6c-candidate-20261115T104312Z.dump`
(sha256 `2e19a5912bbc872929cf2199e079a20967c1ba247b2a2281a47a6bb8da1f0432`).

| item | before | after |
| --- | --- | --- |
| nginx upstream for `moyu.sutrasky.com` | `127.0.0.1:4300` (production stack) | `127.0.0.1:4310` (candidate stack) |
| `moyu.service` | active, `User` unset (root), `WorkingDirectory=/root/src/widgets-m6` | stopped (unit kept, still enabled) |
| WebAuthn RP ID / origin | `moyu-m6c.117-72-211-55.sslip.io` | `moyu.sutrasky.com` / `https://moyu.sutrasky.com` |
| `WEB_DIST_DIR` | `/opt/moyu-m6c/app/apps/web/dist` (pre-merge build) | `/opt/moyu-m6c/current/apps/web/dist` |
| production database `moyu` | owners 0 / repositories 0 / task_links 0 | **unchanged** (never pointed at) |
| candidate database | owners 1 / repositories 3 / conversations 2 / tasks 2 | owner kept, previous credential revoked |

Verification: `https://moyu.sutrasky.com/` 200, `/healthz` 200, `/setup` 200,
`/api/v1/auth/state` returns `rpId=moyu.sutrasky.com`, `origin=https://moyu.sutrasky.com`,
`initialized=true`, `activeCredentialCount=0`, `recoveryOpen=true`. The candidate API on
`127.0.0.1:4310` reports a fresh uptime while `127.0.0.1:4300` was the 336058-second
production process, which proves nginx reached the candidate and not the old stack.

Only one line of `/etc/nginx/sites-available/moyu.conf` changed (verified with `diff`
against `/root/m6c-backup-20261115/`); no other vhost was modified and `nginx -t` passed.

The previous passkey was registered under the old RP ID and cannot authenticate at the new
origin, so it was revoked (`revoked_at` set, row kept) and the instance moved to the
recovery flow. A one-time recovery code was minted from the operator CLI; the owner registers
the real-device passkey at `https://moyu.sutrasky.com/setup`.

**Rollback (two commands):**

```bash
sed -i 's|proxy_pass http://127.0.0.1:4310;|proxy_pass http://127.0.0.1:4300;|' /etc/nginx/sites-available/moyu.conf
nginx -t && systemctl reload nginx && systemctl start moyu.service
```

## 2026-11-15 19:05 (+08:00) — per-repository settings relay

Added and verified the settings transport that the five Superagent settings groups need.

| endpoint (owner-authenticated) | behaviour |
| --- | --- |
| `GET /api/v1/repositories/:id/superagent/settings` | the runtime's settings view (blocks + sources + revisions) |
| `GET …/superagent/{state,sources,models,prompts,policy-history}` | the remaining read pages |
| `PUT …/superagent/settings/:block` `{value, revision}` | saves one block, relays 409/422 unchanged |
| `PUT …/superagent/prompts` `{config, baseRevision}` | saves prompts, relays 409/422 unchanged |

The browser names a repository it owns plus a block name; it never names a port, URL, profile or
token. The API calls the host supervisor, which resolves the port from `repository_instances`
and relays only an allow-listed panel call (`/state`, `/settings`, `/sources`, `/policy/history`,
`/models`, `/prompts`, plus `PUT /settings/:block` and `PUT /prompts`).

Live checks against repository B's running runtime:

| check | result |
| --- | --- |
| `GET settings` | **200**, blocks `policy,eval,executor`, sources `github@1 workspace@1` |
| real values read back | `repository=Bouyer12/m5a-beta-adf10ad9`, `cli=/opt/moyu-m6c/bin/gh-agent`, `pollSeconds=60`, `observeCi=false`, `maxWorkers=1`, `directory=/var/lib/moyu-m6c/worktrees/m6c-b`, `eval.mode=auto` |
| `GET models` / `prompts` / `policy-history` | 200 / 200 / 200 |
| `PUT settings/eval` with `revision: 0` | **409** `{"error":"Settings changed. Reload before saving."}` — the runtime's own message, not a flattened error |
| `PUT settings/whatever` | 422 |
| `GET panel/tickets` (not allow-listed) | 422 |
| request without the machine token | 401 |

Unit tests: block-name and read-path allow-lists including path-traversal attempts,
`source:`/`source:GitHub`/`source:github:pause` rejections, and error summarisation
(`apps/supervisor/test/panel-proxy.test.ts`). Full `pnpm check` green; supervisor suite 93 tests.

**Still not done:** the Deployment group's instance-level `snapshot/subscribe/mutate` adapter, the
ported five-group settings UI, the home page, and the browser-side save/conflict/draft acceptance.

## 2026-11-15 19:03 (+08:00) — a runtime is no longer reported online after its process died

Observed: after a supervisor restart two rows kept `state=online`, `reason_code=ownership_unverified`
and a pid that no longer existed. Nothing listened on the panel ports, so every panel call returned
503 while the projection and the API still claimed a live instance.

Root cause: both the restart reconcile and the tick path take the `ownership unverified` branch
*before* checking whether the recorded process is alive, and that branch returns early for
`state=online && desiredState=online`.

Fix: `requeueLostRuntime()` runs first in both paths. A row whose recorded pid is gone becomes
`state=sleeping`, keeps its `desiredState`, gets `reasonCode=instance_lost` and is scheduled again.

Live verification after deploy: log shows `supervisor.instance_lost` → `instance_spawned` ×2 →
`instance_online` ×2, both instances came back with new pids (3940915 / 3940923), both panel ports
listen again (3461 / 3463), and `reason_code` is now the truthful `listening`.

## 2026-11-15 19:20 (+08:00) — instance-level Deployment adapter

Upstream edits three machine limits through DSH's `ConfigForm`
(`snapshot` / `subscribe` / `mutate`). MoYu has no plugin-manager surface, so the equivalent is
the instance's own profile patch (`DSH_HOME/profiles/<profile>/cordis.patch.yml`):

| endpoint | behaviour |
| --- | --- |
| `GET /control/v1/instances/:id/deployment` | `{status,writable,mode,revision,value,stateDir,profile}` read from the patch |
| `PUT /control/v1/instances/:id/deployment` `{ops, revision}` | validates, writes, then restarts the instance |
| `GET/PUT /api/v1/repositories/:id/superagent/deployment` | the owner-authenticated surface |

Live verification on repository B's runtime:

| step | result |
| --- | --- |
| `GET deployment` | 200, `revision=815181629`, `promptMaxChars=100000`, `pages=10`, `timeout=15000`, `stateDir=/var/lib/moyu-m6c/dsh/state/m6c-b` |
| `PUT` set `promptMaxChars=200000` | 200 `{saved:true, revision:1883730372, applied:["promptMaxChars"], restarting:true}` |
| file on disk | line 9 became `promptMaxChars: 200000` — the save is real, not just a snapshot |
| reuse the old revision | **409** `{"error":"The Deployment settings changed. Reload before saving.","revision":1883730372}` |
| out-of-range value (999) | 422 |
| `stateDir` (platform-managed) | 422 `{"error":"Deployment key is platform-managed or unknown: stateDir"}` |
| restart | `instance_restarting` logged; instance came back `online` with a new pid |
| durability | after a further supervisor restart, `GET deployment` still returns revision 1883730372 and `promptMaxChars=200000` |

12 unit tests: in-place update that leaves every other line byte-identical, insertion inside the
config mapping, unset, multi-op save, `stateDir` refusal, unknown key, nested path, the three
upstream bounds, non-integers, and a missing `dsh-superagent` block.

## 2026-11-15 19:22 (+08:00) — two restart defects that made every restart fail

1. **Shutdown crashed the process.** `systemctl restart moyu-m6c-supervisor` exited 1 with
   `Cannot use a pool after calling end on the pool`: shutdown ended the pg pool while a tick's
   queries were still running, the rejection escaped, and systemd recorded a failed unit — which
   left the formal entry returning 502 until the unit was started by hand. `stop()` now waits on
   the same lock the tick holds before the caller closes the pool, and shutdown only reports a
   non-zero exit for a genuine failure. Verified: two consecutive restarts end with
   `ExecMainStatus=0`, `NRestarts=0`.
2. **Instances wedged in `stopping/stop_failed`.** A supervisor restart removes the unit cgroup,
   so the runtimes die with it; rows could stay `stopping`/`stop_failed` with a pid that no longer
   exists — a stop that can never be confirmed, holding an online slot while nothing runs. The
   dead-runtime handler now covers `stopping` as well as `online`. Verified: after a restart the log
   shows `supervisor.stop_settled` → `instance_spawned` ×2 → `instance_online` ×2, both instances
   back `online`/`listening` with new pids, gamma still `sleeping` because it was never wanted.

**Still not done:** the five-group settings UI, the home page, #64's five supplemental
verifications, dual-entrance dedup, backup/restore and rollback drills.

## 2026-11-15 20:20 (+08:00) — #64 supplemental verification on a real runtime

Executed against repository A's real ticket `253f6afcf4c2b3eaaa9e3ce3904303b2`
(worktree `/var/lib/moyu-m6c/worktrees/m6c-a/probe-file-ok-253f6afcf4c2`).

| # | scenario | observed | result |
| --- | --- | --- | --- |
| 1 | a repository's own check command is used | `check_commands=["echo repo-a-check-ok"]` → run `command="echo repo-a-check-ok"`, `exitCode 0`, `output "repo-a-check-ok"` | Pass |
| 2 | unconfigured repository falls back to the global default | `check_commands=NULL` → run `command="pnpm install --frozen-lockfile && pnpm check"`, `exitCode 1`, `output "[ERR_PNPM_NO_PKG_MANIFEST] No package.json found in …"` | Pass |
| 3 | a failing command is not silently passed | `["sh -c \"exit 7\""]` → `exitCode 7`, `passed false`, `summary "失败（exit 7）"` | Pass |
| 4 | an empty command list is refused | `update … set check_commands='[]'` → `ERROR: violates check constraint "repositories_check_commands_shape"`; the row kept its previous value | Pass (DB constraint) |
| 5 | checks run as a separate identity | command `id -un; id -u; id -g` → `moyu-m6c-check`, `987`, `981` — the supervisor runs as `moyu-m6c` (988) | Pass |
| 6 | a timed-out check is killed and leaves nothing behind | `REVIEW_CHECK_TIMEOUT_MS=8000` with `["sh -c \"sleep 30 & wait\""]` → `timedOut true`, `durationMs 8002`, and afterwards `ps` shows no `sleep 30` and no `sh -c sleep` | Pass |

**Not verified:** two *different repositories* running their own commands in the same
session. Repository B has `check_commands=["echo repo-b-check-ok"]`, but a review run needs a
real ticket there, and creating one needs the owner's signed-in session. That single row is
outstanding.

### Three defects this verification exposed and fixed

1. **The check identity could never write a worktree.** `provisionInstance()` called
   `ensurePrivateDir()` on the worktree root, chmod-ing it 0700 on every prepare, and the
   per-profile directory was created 0700 too. Every check failed closed with
   `检查身份 987:981 无法写入工作目录`. Fixed: root and per-profile directory are created 2775
   with the check group.
2. **`ProtectSystem=strict` hid the check identity's HOME.** `/var/lib/moyu-m6c-check` was not
   in `ReadWritePaths`, so inside the unit's mount namespace the check user's own HOME was
   read-only and the pre-flight refused every run. Fixed by adding the path.
3. **A timed-out check could not be killed.** The child runs as uid 987, the supervisor as 988,
   and the unit had no `CAP_KILL`: `process.kill()` returned EPERM, the command kept running
   after the timeout, and the run still reported only "timed out". Observed: a `sleep 30` tree
   alive after an 8 s timeout. Fixed by granting `CAP_KILL` to the unit and by enumerating the
   child's session after the group kill, retrying SIGKILL on survivors and carrying
   `lingeringPids` into the run summary. Re-tested: no process survived.

Also note: `/var/lib/moyu-m6c` had to become `0751` so the check identity can traverse into
`worktrees/` without being able to list it.

## 2026-11-15 21:20 (+08:00) — lessons intake and the three-repository capacity proof

Owner instruction: add the organisation's `lessons` repository, drop one test repository, and merge
PR #65.

**PR #65 merged.** Squash-merged at `2026-11-15T13:15:27Z` with
`--match-head-commit 5660ea1fb2555f524cfc9dac9a9fb54f535a082a` after re-reading the gate
(`MERGEABLE`, `CLEAN`, both required checks `pass`). Merge commit
`22f887d820d0cc2e28897983d7c398b6470f8446`; `git merge-base --is-ancestor` confirms the PR head is
in `main`.

**Test repository removed.** `Bouyer12/m5a-gamma-adf10ad9` — the unused one: 0 conversations, 0
tasks, 0 audit rows, never started. Its row was deleted (the instance row cascades), and its
credential file, log, worktree directory, state directory and profile seed were removed.

**`bouyer-sutrasky/lessons` added.** GitHub is the authority and it said `push: true`,
`default_branch: master`, id `1453958822`; the row was inserted with the same fields the create route
uses (`status` provisioning → then active), and the supervisor `prepare` call provisioned the fixed
boundary: profile `m6c-1`, ports 3471/3472, a per-repository credential file. Its runtime answers all
six panel reads with real content (`state`, `settings`, `sources`, `models`, `prompts`,
`policy-history` all 200), so it is a live runtime rather than a listening socket.

Not done through `POST /api/v1/repositories`: that route needs the owner's signed-in session and the
machine has none. The GitHub write check, the inserted fields and the `prepare` call are the ones the
route performs; only the authenticated request itself is missing, so the API path for a *new* add is
still unverified end to end.

**Capacity, three repositories, two online.** Waking `lessons` while alpha and beta were online was
accepted with `waitingFor: capacity`; the supervisor evicted the idle instance (alpha went
`stopping → sleeping` with `reason_code evicted`), then `lessons` went `starting → online`. Steady
state: `online = 2` of 3 repositories. Observed sequence:

```
t+0s   lessons=sleeping/wake_queued   alpha=stopping   beta=online   count=2
t+5s   lessons=starting/starting      alpha=sleeping/evicted  beta=online   count=2
t+10s  lessons=online/listening       alpha=sleeping/evicted  beta=online   count=2
```

`lessons` is an npm repository (`package-lock.json`, no pnpm lock) whose scripts are `build`, `test`,
`check:contract`, so its per-repository checks are set to
`["npm install --no-audit --no-fund", "npm test", "npm run check:contract"]` instead of the platform
default. That makes it the repository that can close the one outstanding #64 row (a real dependency
install in a fresh worktree) once its first ticket exists.
## 2026-11-15 22:50 (+08:00) — drills: backup/restore, migrations, platform and plugin rollback

All drills ran against the isolated candidate. The production database `moyu` was not opened,
written, or migrated.

### Backup and restore

`pg_dump -Fc` of `moyu_m6c` (12 MB, 25 tables) → 279 KB dump → restored into a throwaway database
`moyu_m6c_restore_*` created by the postgres superuser (`moyu_m6c` has no CREATEDB, which is correct).

| check | source | restored |
| --- | --- | --- |
| tables | 25 | 25 |
| owners / repositories / conversations / tasks / messages / events | 1 / 3 / 4 / 4 / 12 / 37 | identical |
| `drizzle.__drizzle_migrations` | 19 | 19 |
| indexes | 85 | 85 |
| `repositories_check_commands_shape` | present | present |

The restore was then proven **app-usable**, not merely present: a throwaway API process
(`apps/api/dist/server.js`, same release, `API_PORT=4399`, run as `moyu-m6c`) booted against the
restored database and answered `GET /readyz` 200 and `GET /api/v1/auth/state` with the real owner
state `{"initialized":true,"activeCredentialCount":1,"setupOpen":false,"recoveryOpen":false,
"rpId":"moyu.sutrasky.com"}`; `GET /api/v1/repositories` returned 401, so the auth gate is live on
the restored data too. Port released afterwards.

### Migrations, up and rollback

| step | observed |
| --- | --- |
| empty database + `pnpm db:migrate` | `migrate.completed`, 25 tables, 19 migrations |
| API on that fresh schema | `/readyz` 200, `{"initialized":false,"activeCredentialCount":0,"setupOpen":true}` — a genuine first-run state |
| rollback = restore the pre-drill dump into the same database | 19 migrations, 1 owner, 3 repositories, 2 credentials, `/readyz` 200, `{"initialized":true,"activeCredentialCount":1,"setupOpen":false}` |

The rollback story is restore-from-backup; this run proves that path returns the database to a
schema and data state the current release boots on. There are no down-migrations to apply, and no
attempt was made to invent them.

### Platform rollback

`/opt/moyu-m6c/current` repointed from `b6fa35bb5394-home` to the previous release
`e3a677e03b4d-kill`, API restarted: `/readyz` 200, served bundle changed
`index-BCMyha2F.js → index-BhUd1-FJ.js`, `auth/state` unchanged. Repointed back: bundle returned to
`index-BCMyha2F.js`, `/readyz` 200. The whole rollback is a symlink swap plus a service restart.

### Plugin rollback

Each profile loads the runtime through `profiles/<profile>/node_modules/dsh-superagent`, a symlink
into `/opt/moyu-m6c/artifacts/`. Rollback is that symlink plus a restart of the instance.

The drill staged a second artifact (`superagent-rollback-<ts>`, byte-identical `lib/index.js`
`07f46473…d49b`), repointed profile `m6c-b` at it, and forced a real reload with
`sleep` → `wake`. Observed: `sleep` 200 (`{}` is the schema; `{"reason":…}` is rejected 422),
`wake` 200, instance back `online` with **pid 4018258 → 4094447**, `policyVersion` unchanged
(`cda2cc40…`) and Deployment revision `1883730372` with `promptMaxChars=200000` intact. Repointed
back to `superagent-ad9650631bc3`, reloaded again: pid `4094447 → 4094763`, same settings. The
staged copy was deleted; only the real artifact remains.

This verifies the swap procedure and that a plugin rollback preserves the owner's settings. It does
**not** verify a downgrade to an older plugin build, because only one artifact exists.

### Dual-entrance de-duplication

Duplicate keys are enforced in the schema, and each was exercised against real rows:

| duplicate attempt | result |
| --- | --- |
| second delivery row for the same message | rejected — `deliveries_message_uq` |
| second task for the same conversation (web-first repeat) | rejected — `task_links_conversation_uq` |
| same upstream ticket linked from another conversation (GitHub-first repeat) | rejected — `task_links_repository_upstream_ticket_uq` |
| second event with the same `(source, source_event_id)` | rejected — `events_source_event_uq` |

Row counts were unchanged afterwards. Note the fourth index has no repository dimension, so the same
source event id cannot exist in two repositories at all: stronger de-duplication, but it is the
repository-isolation gap already recorded under the isolation findings.

**Not verified end to end.** The GitHub-first entrance needs a second GitHub actor: an issue created
by the agent's own account produced no notification and the runtime's GitHub source stayed
`received=0` for the whole observation window (the probe issue was closed afterwards). The web-first
entrance needs the owner's session. Only the de-duplication invariants above are proven.

### Dependency install and checks under the check identity

The outstanding #64 row asked for a real dependency install in a fresh worktree. Done at the
identity and toolchain level: a fresh copy of this repository (783 files, lockfile present, no
`node_modules`) owned by `moyu-m6c:moyu-m6c-check`, installed and tested **as `moyu-m6c-check`**:

```
pnpm install --frozen-lockfile  → 392 packages, 1m53.6s, exit 0
pnpm --filter @moyu/supervisor test → 10 passed | 1 skipped (11 files), 100 passed | 5 skipped (105 tests), 8s, exit 0
```

This exercises the parts that used to fail: the check identity's own HOME as the pnpm store, network
access, and a real build/test toolchain resolving from a lockfile. It is **not** the review API path
on `lessons`: that still needs a real lessons ticket, which needs the owner to create the task.

## 2026-11-15 23:20 (+08:00) — three gaps closed, one of my own claims retracted

**Correction first.** I recorded that `runtime_cursors` was empty and that the Bridge cursor was
in-memory only. That was wrong: the table holds three rows with advancing cursors (12 / 5 / 0,
`updated_at` matching each repository's last consumed event) and `syncOnce()` does
`insert … on conflict do nothing`, `select cursor`, then updates inside the transaction. I sampled it
during a restart window and read "no new row right now" as "never written". The claim is retracted in
`M6-C-ACCEPTANCE.md`.

**`events_source_event_uq` is now repository-scoped.** Migration `0019_event_dedupe_per_repository`
(replaces the index with `(repository_id, source, source_event_id)`), generated with drizzle-kit and
drilled on an isolated copy first:

| step | observed |
| --- | --- |
| isolated copy + migrate | 19 → 20 migrations, `migrate.completed` |
| index definition | `(repository_id, source, source_event_id) WHERE source_event_id IS NOT NULL` |
| duplicate inside one repository | still rejected (`duplicate key value violates …`) |
| same event id in a second repository | now accepted (`INSERT 0 1`) |
| candidate database | 20 migrations, events count unchanged at 39 |

**Transient Bridge failures no longer log as errors.** `runLoop` counts consecutive failures: the
first two are warnings, the third and later are errors, and a recovering loop logs one
`<loop>_recovered` info line. Before this, a supervisor restart produced ~237 `event_sync_error` lines
at error level plus 114 `report.capture_failed` warnings in the observed window, all one cause.

`pnpm check` passes after both changes (contracts 26, runtime-client 13, dispatcher 5, api 20, plus the
supervisor and web suites).
