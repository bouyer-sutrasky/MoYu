# M6-C final status — 2026-11-16

## Conclusion

The isolated candidate stack is running from **one final main release** and has
passed the code, database, browser, isolation and real-GitHub execution checks
listed below. A real final-artifact worker task created
[PR #10](https://github.com/Bouyer12/m5a-beta-adf10ad9/pull/10).

**I do not declare the two delivery nodes fully signed off.** The
`可投入使用的原型` candidate is operational, but the hard gate still has the
owner-bound authentication/phone/production actions and three explicitly
unfinished engineering/acceptance items (panel ticket retry for execute tasks,
worker read receipt, and the real-host review-check cgroup stress matrix).
`正式上线验收` is not complete until those items and the owner actions in
`docs/evidence/m6c/M6C-RUN-20261116-1250/owner-actions.md` are closed.

## Final release

| item | value |
| --- | --- |
| main merge commit | `d14ead71869686c3a3ec6dd70a1e50d7a7e607a6` |
| PR | [#70](https://github.com/bouyer-sutrasky/MoYu/pull/70), squash-merged |
| CI | [run 43811903841](https://github.com/bouyer-sutrasky/MoYu/actions/runs/43811903841); both required checks SUCCESS |
| release | `/opt/moyu-m6c/releases/d14ead718696` |
| manifest | `docs/evidence/m6c/M6C-RUN-20261116-1250/release-manifest.json` |
| API artifact | `a49de98b849bfd74502f52e703650313a572eff47b880280c5394a68cd752fd9` |
| supervisor artifact | `dd762a4922a9883ef2a86d63606404a31a516f25f0cbeb8ae904f9a2952f26ee` |
| dispatcher artifact | `9e0d7cddc62e74516756e1ef28e4e15f4bcee145a7b27dd83bf7f55c2f2705cd` |
| plugin entry | `07f46473b150ec97e35f1fe45090946df8e966f847c5269bcd5b2190a9fdd49b` |
| database | `moyu_m6c`, 20/20 migration ledger rows; 25 public tables observed in the restore drill |
| public entry | `https://moyu.sutrasky.com` → `127.0.0.1:4310` |

The final `verify-running` output shows all three units active, cwd
`/opt/moyu-m6c/releases/d14ead718696`, and the exact manifest hashes:

`docs/evidence/m6c/M6C-RUN-20261116-1250/verify-running-final.txt`

## What was fixed and proven

| area | result | evidence |
| --- | --- | --- |
| 0019 forward/rollback, historical rollback chain, journal-derived counts | Pass | `db-ledger.txt`, `integration-final.log` |
| Repository-scoped event dedupe, A/B same id, replay, cursor transaction rollback, unknown 23505 | Pass | `integration-final.log` |
| Settings `expectedInstanceId` (409) and managed fields (422) | Pass | `api-action-final.txt`, `deployment-stale-409.json`, `executor-managed-422.json` |
| Opaque Deployment revision, lock/settlement, restart gate | Pass | `deployment.json`, integration suite |
| Five settings groups, A/B switch, keyboard, 1440×900/390×844, light/dark, no horizontal overflow | Pass | `browser/result.json`, eight PNG screenshots |
| Home pending query before pagination, priority and count | Pass | `browser/requests.json`, integration suite |
| Per-repository runtime/check uid, zero capabilities, own home/state/worktree/SSH, cross-repo denial | Pass | `isolation-sentinel-main.txt` |
| Same manifest for all three services, actual cwd/cmdline/hash | Pass | `verify-running-final.txt` |
| Consistent PostgreSQL + 3 SQLite + DSH + worktree backup; final set hash verification | Pass | `final-backup-manifest.json`, `backup-final-verify.txt` |
| Dedicated restore drill (20/20 ledger, 25 public tables) | Pass | `restore-drill.txt` |
| Real final task: clone, worker, commit, push, PR #10 | Pass | `real-task-pr.json`, `real-task-pr.patch` |
| Protected PR checks and merge | Pass | `ci-pr70.json` |

Test totals from the final tree (`d14ead71` equivalent tree):

- `pnpm check`: green; supervisor 11 test files.
- `pnpm test:integration`: green; db 16 files, api 18 files, dispatcher 18 files
  (1 skipped), supervisor integration 1 file (4 tests).
- M6-C CLI safety tests: 6/6.

## Real task result

The final-artifact worker created
`M6C-FINAL-ACCEPTANCE.md` containing exactly `m6c final acceptance ok\n` on
branch `agent/m6c-final-acceptance`, commit
`dce51f0f47c87814ee6a3297302cadc76b1cddfb`, and opened
[PR #10](https://github.com/Bouyer12/m5a-beta-adf10ad9/pull/10). The platform
task reached `completed`; the runtime ticket ended `completed`; the delivery
reached `delivered`.

## Unfinished / blocked

1. **Real-device Passkey / phone / second GitHub identity.** The browser
   acceptance used a temporary database session marked
   `M6C automation layout session (not auth acceptance)`. It was revoked after
   the run. Real device, real phone and the second GitHub identity remain owner
   actions.
2. **Panel ticket retry for an execute ticket.** The route returns HTTP 400
   `admissionRequired`; the platform task command endpoint has the lease
   admission logic. Evidence: `panel-ticket-retry.txt`.
3. **Worker read receipt.** Delivery is `delivered`, but
   `handed_to_worker_at` and `read_at` are null; the pinned runtime emitted no
   `message.delivered`/`message.read` events. The completed PR is real work
   evidence, not a database read receipt. Evidence:
   `delivery-read-receipt.txt`.
4. **Review-check cgroup real-host stress.** The implementation and unit tests
   are present, but the setsid/TERM-ignore/pipe-holder real-host matrix was not
   executed. Evidence: `review-cgroup-not-run.md`.
5. **Production window.** A host reboot, fresh production backup/cutover,
   `3082` decision, old `moyu.service` cleanup and any DNS/nginx change were
   not performed without owner approval. The old service is inactive but still
   enabled; port 3082 remains listening.
6. **Write-side settings coverage.** Read routes and pause/resume were
   exercised, but prompts preview, source-label refresh and policy-sync write
   actions were not all exercised with a real source in the final run. Evidence:
   `api-action-final.txt`.

## Where the evidence lives

`docs/evidence/m6c/M6C-RUN-20261116-1250/`

- `matrix.json` — all rows, including Pass/Partial/Blocked;
- `release-manifest.json`, `verify-running-final.txt`, `db-ledger.txt`;
- `integration-final.log`, `check-final.log`;
- `api-action-final.txt`, `deployment*.json`, `executor-managed-422.json`;
- `browser/` — result, requests and eight screenshots;
- `isolation-sentinel-main.txt`;
- `final-backup-manifest.json`, `backup-final-verify.txt`, `restore-drill.txt`;
- `real-task-pr.json`, `real-task-pr.patch`, `ci-pr70.json`;
- `owner-actions.md`, `review-cgroup-not-run.md`,
  `panel-ticket-retry.txt`, `delivery-read-receipt.txt`.

The final backup set is `/root/m6c-backups/M6C-RUN-20261116-FINAL`
(mode 0700; contains credentials/state, intentionally outside the repository).
