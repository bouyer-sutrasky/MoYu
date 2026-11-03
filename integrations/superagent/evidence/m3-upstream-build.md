# M3 upstream build evidence

Date: 2026-11-03 (Asia/Shanghai). Scope: the upstream (superagent) half of MoYu M3 — workspace Source, machine Bridge,
Ticket model freeze — as ordered patches plus the build script. This record contains only commands that were actually run,
their exit codes, and the hashes of the artifacts they produced.

The bootstrap DSH instance at `127.0.0.1:3082` / `/root/dsh-superagent` was read-only and was not touched, restarted, or
reconfigured. No service, nginx site, database, profile, or GitHub repository was changed.

## 1. Pinned input and toolchain

| Item | Value |
| --- | --- |
| Pristine tree | `/root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2` |
| Upstream commit | `6337fc823ce20251c8de8085948165c81aaa701e` |
| Tarball SHA-256 (lock) | `31402e86aed27ef173d47d1eb8e36fd7baaf818050dbcdf8ebb8c59caf083659` |
| Node | `v22.23.3` |
| pnpm | `11.7.0` via `corepack pnpm@11.7.0` (corepack home `/root/src/upstream/.corepack`) |
| git | `2.43.0` |
| Build Node/pnpm environment | `env -i HOME=/root/src/upstream/m0-home PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin COREPACK_HOME=/root/src/upstream/.corepack CI=1` |

The scratch repository whose first commit is the pristine tree (excluding `node_modules`, `lib`, `.artifacts`) lives at
`/root/src/m3-upstream-work/work`; the patches are `git diff` between its four consecutive commits:

```
ce3533e pristine dsh-superagent 6337fc823ce20251c8de8085948165c81aaa701e
fb0ab2e 0001 workspace Source and prefixed outbound reply ids
feb8669 0002 machine Bridge with durable event projection
79adfd8 0003 freeze the execution spec on the ticket and its worker
20027eb 0004 replay the first outcome for duplicate triggers
```

## 2. Patches

Ordered patches in `integrations/superagent/patches/`:

| # | File | SHA-256 | Adds / changes |
| --- | --- | --- | --- |
| 0001 | `0001-workspace-source.patch` | `f082211783d9adfc564b0c876ce8525da34b1ec331d657415e99fdd051727362` | New `src/sources/workspace.ts` (non-secret schema, `web` scope row, owner-only Policy part, one-page Thread context, workspace environment, Channel that POSTs to `MOYU_PLATFORM_URL/api/internal/v1/runtime-events`); `ack:` / `attention-reply:` outbound ids in `src/core/replies.ts` and their readers; `tsdown.config.ts` `workspace-watch` entry; `package.json` export; `cordis.patch.yml` row (enabled); `tests/workspace.spec.ts` |
| 0002 | `0002-machine-bridge.patch` | `9d505908a150d4be647942262e9576cafdc9cdb5dd620cc23dc572804145de3a` | New `src/app/bridge.ts` (loopback server, timing-safe bearer, capabilities/models/triggers/events/tickets, 501 pause/resume/retry, unauthenticated `/healthz`, fsynced append-only `EventLog`, once-a-second Ticket projection, `task.progress` from `assistant/message`); `src/app/runtime.ts` construction/startup/shutdown wiring; `tests/bridge.spec.ts` |
| 0003 | `0003-ticket-freeze.patch` | `ea1ebeff91170acceb94935b4fff5eef72653bbe43a3a8b57b8fcd5a382dc8ca` | `Ticket.model` / `modelSource` / `base` / `mode` and `frozenSpec` in `src/core/model.ts`; freeze from `meta.spec` in `Tickets.create`; optional frozen model in `Sessions.ensure`; `verifyTicketModel` in `src/app/role-models.ts`; launch-time validation and frozen-model pass-through in `src/executor/dsh.ts`; null-model resolution in `src/app/bridge.ts` / `runtime.ts`; `tests/ticket-freeze.spec.ts`; `docs/007-architecture.md` tables and the `bundle-patch` expectation (documentation bookkeeping for 0001/0002) |

| 0004 | `0004-bridge-duplicate-first-result.patch` | `e094d3e59cf12a1b84cc69955343fe204656163f286fa773c45af03894871365` | `POST /bridge/v1/triggers` returns the persisted first outcome for a repeated `triggerId` before model or branch validation: filtered disposition → `filtered`, otherwise the stored `baseCommit`/Ticket; a concurrent receive duplicate also reports the stored base. Adds regressions for a moved branch plus a removed model, and for a filtered Trigger. |

The patches are plain `git diff` output; they are applied with `git apply`, never fuzzed or forced.

## 3. Fresh-tree application and checks

A pristine copy was made with `rsync -a --exclude node_modules --exclude lib --exclude .artifacts --exclude .git`, then the
patches were checked and applied in order:

```
$ git apply --check 0001-workspace-source.patch   # exit 0
$ git apply        0001-workspace-source.patch   # exit 0
$ git apply --check 0002-machine-bridge.patch     # exit 0
$ git apply        0002-machine-bridge.patch      # exit 0
$ git apply --check 0003-ticket-freeze.patch      # exit 0
$ git apply        0003-ticket-freeze.patch       # exit 0
```

`node_modules` in that scratch copy is a symlink to the pristine tree's `node_modules` (same lockfile), which is the same
dependency reuse the build script performs.

Checks in the freshly patched tree (`/root/src/m3-upstream-work/verify-fresh`):

```
$ env -i HOME=… PATH=… COREPACK_HOME=… CI=1 corepack pnpm@11.7.0 typecheck
$ tsc --noEmit
exit 0

$ env -i … corepack pnpm@11.7.0 build
Build complete in 4734ms
exit 0
lib/index.js, lib/workspace-watch.js, lib/workspace-watch.d.ts present

$ env -i … corepack pnpm@11.7.0 vitest run tests/bridge.spec.ts
Test Files  1 passed (1)
Tests       20 passed (20)
exit 0

$ env -i … corepack pnpm@11.7.0 vitest run
Test Files  1 failed | 61 passed (62)
Tests       1 failed | 1231 passed (1232)
exit 1
```

The single failure is the documented upstream Feishu failure, unrelated to these patches:

```
FAIL tests/sources.spec.ts > feishu event consumer > takes in the event lines it reads, records each chat as direct or
not, and reports a malformed line without stopping
expected health.feishu { state: 'error', detail: contains 'JSON' }, received { state: 'ready', detail: 'Listening for bot events' }
```

It reproduces on the pristine tree itself:

```
$ cd /root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2
$ env -i … corepack pnpm@11.7.0 vitest run tests/sources.spec.ts -t "feishu event consumer"
Test Files  1 failed (1)
Tests       1 failed | 6 passed | 64 skipped (71)
exit 1
```

## 4. `build-patched.sh` end to end

```
$ cd /root/src/message-loop-m3-68fa5d90cfd4
$ ./integrations/superagent/build-patched.sh \
    /root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2 \
    /root/src/m3-upstream-work/out
==> source: /root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2
==> build:  /tmp/moyu-m3-upstream.zUBxUp
==> output: /root/src/m3-upstream-work/out
==> applying 3 patches in order
    git apply --check 0001-workspace-source.patch
    git apply --check 0002-machine-bridge.patch
    git apply --check 0003-ticket-freeze.patch
==> reusing node_modules of the same source tree
==> pnpm typecheck
==> pnpm build
==> copying the built package to /root/src/m3-upstream-work/out
==> done
lib files: 15
exit 0
```

The script copies the pristine tree (without `node_modules`/`lib`/`.artifacts`/`.git`) to a temporary directory, applies the
patches with `git apply --check` and then `git apply`, reuses `node_modules` only because the copy comes from that same
source tree (otherwise it runs `pnpm install --frozen-lockfile`), runs `pnpm typecheck` and `pnpm build` in the clean
`env -i` environment, refuses to continue unless `lib/index.js` and `lib/workspace-watch.js` exist and `lib/index.js`
contains the Bridge (`MOYU_BRIDGE_TOKEN`), and copies `lib/`, `package.json`, `cordis.patch.yml`, `prompts/`, `skills/`,
and `locale/` to the output directory.

Output (`/root/src/m3-upstream-work/out`):

```
lib/index.js            contains "moyu-bridge/1"                      (patched Runtime + Bridge)
lib/workspace-watch.js  present                                       (workspace Source entry)
package.json            "./workspace-watch": "./lib/workspace-watch.js"
cordis.patch.yml        name: dsh-superagent/workspace-watch           (enabled row)
```

SHA-256 of the built package:

```
d428e669805ea1dfb6a4900bddbffe3cafb8f06a0b1eb139266c2b2f6b94b021  package.json
c91fab94d3a27c7068b5f5391907fb4d69342112ad50f987fdfed9985c2c7905  cordis.patch.yml
1f835cc1a366c5d4afc4c6b049a410fc0c54e07bb54350d85e4d63090ca743d3  lib/client.js
174afffe865b608e13b879e222bbcb9398549e0b9b5b29b3686ab486836d9a9a  lib/feishu-CEjMecoU.js
eda4f4bb074ee90ffc08bcb66d92b3159a59919d39fd6258245c830ae07cc8c1  lib/feishu-watch.d.ts
cc70bcf62f1723141569d214991327adafeacbd74d9d027ee90f22767278592a  lib/feishu-watch.js
fe713e3276520a8fdca03e8a784c09b0f4209deabb5da44897202b0f5f4cd394  lib/github-pull-D3tN6iiD.js
72c72bed2a5747826b41fd52fef7e9a32d49ef74b048f47f74d7a3b77202933f  lib/github-watch.d.ts
52f241bebf3312cf75d17a444bfe0e38466ec51200552385489e0080d29e8171  lib/github-watch.js
0573e44989f7eebff1d82934efbd38f462f933eef06e0f17ce21c856e318481f  lib/host-B64LgdSs.js
761308a47069f3706193d2753773858d8435d86c1452ada97f8c035c12723620  lib/index.d.ts
a49f4a062f5c878f5996fdb58e022f091679ffac72289650fe30047aa9dc8fa2  lib/index.js
1d819189c9dd13d924325afdc98b951c9ea1739c96f0e8b3207fc638a1b251e5  lib/intake-K6oppxAI.d.ts
76f4f1a87c7656c73cd4f3ee2a8824b412ec5401fa958b9f536e11a499b93abc  lib/kind-DEj1dBR8.d.ts
d000479f8053ce7cc1e47145b0184c2e8e74a92dbfb3d7761bdd682cf5fdc668  lib/poll-DqpvSOYA.js
a1c91c91d21ee733cc1bf5e451ebdd60fd351894ec030677ae59680b1ced7424  lib/workspace-watch.d.ts
8d3ec8c2956977cc8158ea974f4ce7201667bd057994e6f217c276609c4aa90d  lib/workspace-watch.js
```

## 5. Failure handling

A copy of the script and patches was corrupted in one context line of `0002` and run against the pristine tree:

```
error: patch failed: src/app/runtime.ts:30
error: src/app/runtime.ts: patch does not apply
error: 0002-machine-bridge.patch does not apply to the pristine tree; stopping without applying it
exit 1
```

No output directory was created, and no patch was fuzzed or forced. Running the script on an already patched source tree is
refused before anything is copied (`exit 2`), and a missing source tree / unknown layout also exits `2`.

## 6. Design deviations from the brief, and why

1. **Outbound reply ids.** Upstream built `ack` and `attention-reply` ids as bare `key(...)` hashes, which carries neither the
   protocol's `sourceEventId: "ack:<triggerId>"` nor a classifiable prefix. `0001` changes them to `ack:<triggerId>` and
   `attention-reply:<attentionId>` (exported as `acknowledgementId` / `attentionReplyId`), updating the two upstream test
   files that asserted the old ids. This is what makes the workspace Channel's `messageKind` and `triggerId` rules in the
   brief implementable at all.
2. **State-projection order.** The brief lists `attention`, then running, then queued, then blocked/failed. Upstream
   `ticketStage` (`src/core/stage.ts`) checks the latest report's blocked/failed/ready state *before* the Assignment state,
   because a worker reports `blocked`, `failed`, or `ready` while its Assignment is still `running`. The Bridge uses the
   upstream order (attention → ready → blocked/failed waiting for a person → running → queued) so those reports are not
   reported as `running`; a blocked/failed report whose person has written again is `queued`.
3. **Null `executionSpec.model`** (added by the parent during the task). `POST /triggers` accepts `model: null` and freezes
   the instance's `settings.executor.model` as `meta.spec.model` with `modelSource: 'executor'`; if the instance has no
   Executor model either, it freezes `model: null` with `modelSource: 'instance'`, which `Ticket` stores and
   `GET /tickets/:id` reports as `model: null`. An explicitly named but unavailable model is still `422`, never replaced.
   The explicit model is verified through `resolveRoleModel`; the resolved fallback is verified too before it is frozen.
4. **Environment variable names.** The parent conditionally asked for `DSH_SUPERAGENT_GITHUB_REPOSITORY` / `_ACCOUNT` /
   `_COMMIT_EMAIL` / `_NUMBER` / `_PR_HEAD`. `SourceRegistry.environments()` emits every enabled kind's variables, and the
   GitHub kind is enabled by default, so declaring those same keys on the workspace kind would list each one twice in the
   execution environment. The workspace Source therefore keeps `DSH_SUPERAGENT_WORKSPACE_*` (`_REPOSITORY`, `_ACCOUNT`,
   `_COMMIT_EMAIL`, `_BASE_BRANCH`, `_BASE_COMMIT`, `_MODEL`, `_CONVERSATION`) and the duplication is documented in the
   source.
5. **Optional `parentText`.** The protocol body does not define a parent message text, and `threadContext.read('parent')`
   must not invent history. The Bridge accepts an optional `parentText` and stores it in `meta.parentText`; without it the
   parent page is empty.
6. **Base commit resolution.** A supplied `baseCommit` is verified with `GET repos/<repository>/commits/<sha>` through
   `Commands.api` and the canonical `sha` is returned; `null` resolves `GET repos/<repository>/commits/<branch>`. Failure is
   `422`; a repository mismatch stays `409`; a pending deployment is `503`.
7. **Restart-safe state changes.** In addition to deterministic event ids, `EventLog.open()` seeds each ticket's last
   projected state from `ticket.linked` / `ticket.state_changed` lines, so a restart does not emit a spurious
   `ticket.state_changed` for an unchanged Ticket.
8. **Patch bookkeeping.** `0003` also carries the `docs/007-architecture.md` module/test-table rows and the
   `tests/bundle-patch.spec.ts` row-id expectation introduced by `0001`/`0002`. They are documentation/test bookkeeping
   only; the final tree is what the build verifies.

## 7. Known limitations

- The full upstream suite still reports the pre-existing Feishu test failure; it is not caused by, and not fixed by, these
  patches (reproduced on the pristine tree above).
- No live DSH instance, real provider call, real worker, or real pull request was exercised. The Bridge is tested against a
  fake host and a loopback platform stand-in; `resolveRoleModel`/`verifyTicketModel` use a mocked `ctx.llm`.
- `pause` / `resume` / `retry` are `501` with `capabilities` all `false`, by design for this phase.
- `bridge/events.jsonl` grows without compaction; the platform cursor and deterministic ids handle replay, but retention is
  not implemented.
- The projection covers Tickets whose origin Trigger (or Channel) is the workspace Source; tickets imported from GitHub
  remain outside this Bridge's event stream.
- A ticket frozen with `model: null, modelSource: 'instance'` cannot be made stable against a later `settings.executor.model`
  change, because the instance default has no serializable identity; the ticket records that fact instead of guessing.
- `build-patched.sh` reuses `node_modules` only when the given source tree provides it; a source tree without dependencies
  would run `pnpm install --frozen-lockfile`, which this host run did not exercise (no network install was performed).
