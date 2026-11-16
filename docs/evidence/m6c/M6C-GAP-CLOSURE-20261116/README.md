# M6-C gap-closure evidence index

Run: `M6C-GAP-CLOSURE-20261116`

Final code main: `89f70f5663f8ad0ce984f62e39eb07042432a510`
Release: `/opt/moyu-m6c/releases/89f70f5663f8`

This run closes the four engineering/acceptance gaps recorded in the previous
`M6C-RUN-20261116-1250` matrix. It does **not** replace the owner-bound real
device, phone, second GitHub identity or production-window actions.

## Protected PRs

| PR | change | required checks |
| --- | --- | --- |
| [#72](https://github.com/bouyer-sutrasky/MoYu/pull/72) | ticket retry/stop through task/lease path; origin receipt adapter; review root lstat | SUCCESS |
| [#73](https://github.com/bouyer-sutrasky/MoYu/pull/73) | worktree `.git` lstat and prompt-preview relay | SUCCESS |
| [#74](https://github.com/bouyer-sutrasky/MoYu/pull/74) | kill background descendants on normal check exit | SUCCESS |
| [#75](https://github.com/bouyer-sutrasky/MoYu/pull/75) | unwrap prompt-preview config at the supervisor boundary | SUCCESS |

`ci-prs.json` contains the exact PR state and check rollup.

## Final code artifacts

| item | value |
| --- | --- |
| code main | `89f70f5663f8ad0ce984f62e39eb07042432a510` |
| release | `/opt/moyu-m6c/releases/89f70f5663f8` |
| API | `2e1a758ba2f2697d1f43736c5f0758e8535902281482174798fd1ee4350ef948` |
| supervisor | `49ec23a35d4090615b60d7d36e597858cc08b000e666c52ada8efbe4b7792cd8` |
| dispatcher | `9e0d7cddc62e74516756e1ef28e4e15f4bcee145a7b27dd83bf7f55c2f2705cd` |
| plugin entry | `9111822c7992c35ab94d291f6cde415d4c1d23b1f765597a39094a2bc2597c20` |
| database | `moyu_m6c`, 20/20 migrations, 25 public tables |
| public entry | `https://moyu.sutrasky.com` → `127.0.0.1:4310` |

`release-manifest.json` and `verify-running.txt` are the source of truth for
the actual running PIDs, cwd, cmdline and artifact hashes.

## Gap results

| gap | result | evidence |
| --- | --- | --- |
| P17 execute-ticket retry/stop bypassed admission | **Pass**: both real routes returned HTTP 202 and wrote `task_operations` (`retry`, `pause`); no `admissionRequired` | `p17-ticket-commands.txt` |
| P18 worker handoff/read receipt was null | **Pass**: real delivery has non-null `handed_to_worker_at` and `read_at`; plugin emits `message.delivered` and `message.read` for the origin trigger; real PR #11 opened | `p18-read-receipt.txt`, runtime bridge events in that file |
| P16 real-host review cgroup stress | **Pass**: setsid + SIGTERM-ignore, detached pipe holder, real timeout and retry all produced `cleanupState=clean`, no residual PID/check cgroup | `p16-cgroup-matrix.json`, four raw JSON files |
| P19 write-side settings | **Partial**: prompts preview reached the real runtime and returned HTTP 200. Source-label refresh and policy-sync were exercised and failed closed with the real source state (`noLabels`, `nothingToSync`), so no positive write result is claimed | `p19-write-actions.txt` |

## Static verification

- `pnpm check`: green (`check.log`).
- `pnpm test:integration`: green; db 16 files, API 18 files, dispatcher 18
  files (1 skipped), supervisor integration 1 file (`integration.log`).
- CI on PR #75: both required checks SUCCESS (`ci-prs.json`).
- `matrix-check.txt`: 9 Pass rows and 1 intentionally Partial row (P19b); `--allow-incomplete` was used for diagnostics only.

## Still owner-bound / unfinished

The candidate remains operational, but the two delivery nodes are not fully
signed off. See `owner-actions.md`:

- real-device Passkey login/registration;
- real phone notification/reply;
- second GitHub identity event/review;
- formal production window, fresh backup, host reboot and cutover;
- `3082` decision and old `moyu.service` cleanup;
- real source labels/policy data for a positive P19 label/policy-sync run;
- merge/close decision for open test PRs #9, #10 and #11.

No browser storage state, session cookie, database URL, GitHub token, SSH key
or credential contents are included here.
