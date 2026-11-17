# M6-C final status — 2026-11-16

> Historical snapshot for release `89f70f5663f8`. See [Deployment](./DEPLOYMENT.md) for the live release and [MoYu #79](https://github.com/bouyer-sutrasky/MoYu/issues/79) for subsequent hands-on findings.

## Conclusion

The isolated candidate stack is running from one release built from code main
`89f70f5663f8ad0ce984f62e39eb07042432a510`. The four engineering/acceptance
gaps recorded in the previous run are closed or exercised:

- execute-ticket retry/stop now goes through the platform task/lease command path;
- the runtime adapter now records origin-trigger handoff and read receipts;
- the real-host review cgroup matrix passes setsid, pipe-holder, timeout and retry;
- prompt preview reaches the real runtime; source-label and policy-sync actions
  were exercised and fail closed because this real source has no names/rules.

**I still do not declare the two delivery nodes fully signed off.** The
`可投入使用的原型` candidate is operational, but real-device Passkey, real phone,
second-GitHub-identity and a positive source-label/policy-sync dataset remain
owner/data actions. `正式上线验收` remains blocked on the production window,
fresh cutover backup, host reboot, `3082` decision and old-service cleanup.

## Final release

| item | value |
| --- | --- |
| code main | `89f70f5663f8ad0ce984f62e39eb07042432a510` |
| protected PRs | [#72](https://github.com/bouyer-sutrasky/MoYu/pull/72), [#73](https://github.com/bouyer-sutrasky/MoYu/pull/73), [#74](https://github.com/bouyer-sutrasky/MoYu/pull/74), [#75](https://github.com/bouyer-sutrasky/MoYu/pull/75) |
| release | `/opt/moyu-m6c/releases/89f70f5663f8` |
| manifest | `docs/evidence/m6c/M6C-GAP-CLOSURE-20261116/release-manifest.json` |
| API artifact | `2e1a758ba2f2697d1f43736c5f0758e8535902281482174798fd1ee4350ef948` |
| supervisor artifact | `49ec23a35d4090615b60d7d36e597858cc08b000e666c52ada8efbe4b7792cd8` |
| dispatcher artifact | `9e0d7cddc62e74516756e1ef28e4e15f4bcee145a7b27dd83bf7f55c2f2705cd` |
| plugin entry | `9111822c7992c35ab94d291f6cde415d4c1d23b1f765597a39094a2bc2597c20` |
| database | `moyu_m6c`, 20/20 migration ledger rows; 25 public tables |
| public entry | `https://moyu.sutrasky.com` → `127.0.0.1:4310` |

`verify-running.txt` shows all three units active, the same release cwd and the
exact manifest hashes.

## What was fixed and proven

| area | result | evidence |
| --- | --- | --- |
| P17 execute-ticket retry/stop | Pass: real routes returned HTTP 202 and wrote `task_operations`; no raw `admissionRequired` | `p17-ticket-commands.txt` |
| P18 worker receipt | Pass: non-null `handed_to_worker_at`/`read_at`; runtime `message.delivered`/`message.read`; real PR #11 | `p18-read-receipt.txt` |
| P16 review cgroup | Pass: setsid/TERM-ignore, detached pipe holder, timeout, retry; all cleanup clean, no residual PID/cgroup | `p16-cgroup-matrix.json` |
| P19 prompt preview | Pass: real runtime returned HTTP 200 | `p19-write-actions.txt` |
| P19 labels/policy sync | Partial: routes exercised; real source returned `noLabels` / `nothingToSync` fail-closed | `p19-write-actions.txt` |
| Static checks and unit tests | Pass: `pnpm check` | `check.log` |
| Real PostgreSQL integration | Pass: db 16, API 18, dispatcher 18 (1 skipped), supervisor integration 1 | `integration.log` |
| Protected CI | Pass: both required checks SUCCESS on final PR #75 | `ci-prs.json` |
| Same manifest for all three services | Pass | `verify-running.txt` |

The prior `M6C-RUN-20261116-1250` evidence remains valid for database rollback,
browser layout, backup/restore, isolation and real-task proof; it was not
rewritten. This run adds the previously missing items without claiming a
production switch.

## Unfinished / blocked

1. **Real-device Passkey, real phone and second GitHub identity.** The temporary
   automation DB session was marked `M6C read-receipt automation (not auth
   acceptance)` and was revoked. It is not authentication proof.
2. **Positive P19 label/policy-sync.** The source currently has no names to
   refresh and no policy input to sync; both calls correctly fail closed.
3. **Production window.** A fresh production backup, host reboot, cutover,
   `3082` decision, old `moyu.service` cleanup and any DNS/nginx change require
   owner approval. The old service is inactive but still enabled; port `3082`
   remains listening.
4. **Open test PRs #9/#10/#11.** They are real worker/test artifacts, not
   production merges; the owner must decide whether to close or merge them.

## Where the evidence lives

`docs/evidence/m6c/M6C-GAP-CLOSURE-20261116/`

- `README.md` — index and exact results;
- `release-manifest.json`, `verify-running.txt`, `db-ledger.txt`;
- `check.log`, `integration.log`, `ci-prs.json`;
- `p17-ticket-commands.txt`;
- `p18-read-receipt.txt` (runtime receipt events, delivery row, PR #11);
- `p16-cgroup-matrix.json` plus four raw stress JSON files;
- `p19-write-actions.txt`;
- `owner-actions.md`.

The previous evidence and backup set remain at
`docs/evidence/m6c/M6C-RUN-20261116-1250/` and
`/root/m6c-backups/M6C-RUN-20261116-FINAL` (mode 0700, outside the repository).
