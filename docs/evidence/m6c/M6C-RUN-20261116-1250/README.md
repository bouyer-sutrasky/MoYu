# M6-C run evidence index

Run: `M6C-RUN-20261116-1250`
Final main: `d14ead71869686c3a3ec6dd70a1e50d7a7e607a6`
Release: `/opt/moyu-m6c/releases/d14ead718696`

| file | purpose |
| --- | --- |
| `matrix.json` | Pass / Partial / Blocked acceptance rows with environment, SHA, command and evidence |
| `matrix-check.txt` | checker output; six rows intentionally incomplete, so `--allow-incomplete` was used |
| `check-final.log` | `pnpm check` on the final tree |
| `integration-final.log` | `pnpm test:integration` on the final tree |
| `db-ledger.txt` | final `moyu_m6c` migration ledger (20/20) |
| `release-manifest.json` | final release manifest (source SHA, artifact/plugin/unit hashes) |
| `verify-running-final.txt` | actual systemd PIDs, cwd, cmdline, artifact hashes and health |
| `baseline.txt` | pre-maintenance mixed-release baseline and DB observation |
| `final-backup-manifest.json` | final consistent backup set with six hashed parts |
| `backup-final-verify.txt` | final backup-set verification output |
| `restore-drill.txt` | dedicated restore drill (20/20 migrations, 25 public tables) |
| `isolation-sentinel-main.txt` | per-uid/capability/home/worktree/SSH cross-repository denial |
| `real-task-pr.json`, `real-task-pr.patch` | real final-artifact worker task and PR #10 |
| `ci-pr70.json` | protected PR checks and squash merge to main |
| `api-action-final.txt`, `deployment*.json`, `executor-managed-422.json` | actual settings identity/managed-field/deployment boundary |
| `browser/` | 1440×900 and 390×844, light/dark, five groups, A/B switch, requests and screenshots |
| `owner-actions.md` | owner-bound real device/phone/GitHub/production actions |
| `panel-ticket-retry.txt` | unresolved execute-ticket retry admission error |
| `delivery-read-receipt.txt` | unresolved worker read/read-back receipt |
| `review-cgroup-not-run.md` | real-host review cgroup stress not executed |

No browser storage state, session cookie, database URL, GitHub token or
credential contents are included in this directory.
