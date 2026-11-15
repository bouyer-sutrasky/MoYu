# M6-C candidate run — 2026-11-15 (Asia/Shanghai)

Run id: M6C-CAND-20261115-100930Z

## Fixed facts

| item | value |
| --- | --- |
| main SHA (verified) | 115d43d166465f211ba0a8d177fad3712e9162a0 |
| integration branch head (main + PR #64) | ad9650631bc3289cff7d7da9a79e7cc0800e68d7 |
| PR #64 head | ad9650631bc3289cff7d7da9a79e7cc0800e68d7 |
| pinned upstream | 6337fc823ce20251c8de8085948165c81aaa701e |
| artifact | /opt/moyu-m6c/artifacts/superagent-ad9650631bc3 |
| artifact lib/index.js sha256 | 07f46473b150ec97e35f1fe45090946df8e966f847c5269bcd5b2190a9fdd49b |
| artifact equality check | identical to known-good /root/src/upstream/l113-build1/lib/index.js |
| api dist sha256 | e243263ae61f856fb5250d366b4d363ba69061d355bc006aaa945c1d971c4cc7 |
| supervisor dist sha256 | 51968c5273ae8a20234379f1fb732b9286f8a2e679e12b241a64cc6c49994257 |
| dispatcher dist sha256 | 70582c60f0e4f32b9d77a05c16391ac7d3128719ed293f1e298b7a81e6d65a83 |
| node | v24.22.2 (candidate copy) |
| pnpm | 11.7.0 |
| candidate origin | https://moyu-m6c.117-72-211-55.sslip.io |
| candidate cert | Let's Encrypt, /etc/letsencrypt/live/moyu-m6c.117-72-211-55.sslip.io |
| candidate DB | moyu_m6c (role moyu_m6c) |

## Service identity and ports

```
supervisor: Slice=moyu-m6c.slice
supervisor: DelegateSubgroup=supervisor
supervisor: User=moyu-m6c
supervisor: Group=moyu-m6c
api: Slice=moyu-m6c.slice
api: User=moyu-m6c
api: Group=moyu-m6c
dispatcher: Slice=moyu-m6c.slice
dispatcher: User=moyu-m6c
dispatcher: Group=moyu-m6c
LISTEN 0      511        127.0.0.1:4491       0.0.0.0:*          
LISTEN 0      511        127.0.0.1:4310       0.0.0.0:*          
8589934592
```

## Health checks

```
api readyz:  200
supervisor health (machine auth): 200
supervisor health (no auth):      401
candidate https /healthz:        200
production https /healthz:       200
```

## Database

```
migrations=19
public tables=25
check_commands column=1
owners=1 repositories=3
```

## Instance capacity model (observed)

```
Bouyer12/m5a-alpha-adf10ad9 | sleeping | sleeping | evicted | m6c-a | 3461 | 3462 | -
Bouyer12/m5a-beta-adf10ad9 | online | online | listening | m6c-b | 3463 | 3464 | 3894918
Bouyer12/m5a-gamma-adf10ad9 | online | online | listening | m6c-c | 3465 | 3466 | 3895052
--- listeners ---
LISTEN 0      511        127.0.0.1:3466       0.0.0.0:*          
LISTEN 0      511        127.0.0.1:3464       0.0.0.0:*          
LISTEN 0      511        127.0.0.1:3465       0.0.0.0:*          
LISTEN 0      511        127.0.0.1:3463       0.0.0.0:*          
```

Observed: MAX_ONLINE=2 held. Two instances reached state=online with distinct
profile/state/panel port/bridge port/pid; the third was queued and an idle
instance was evicted for it (supervisor.evict_idle) rather than exceeding the cap.

## What this run did NOT verify

- Real task -> worker -> PR execution on the three repositories (no ticket was created in this run).
- PR #64 supplemental verification (real browser save, two repositories with different commands, fail-closed, fresh worktree dependency install, check identity and timeout cleanup).
- Instance settings API, Deployment adapter and the ported Superagent settings UI.
- Home page convergence.
- Backup/restore and migration rollback drills; platform/plugin rollback rehearsal.
- Mobile and dark theme screenshots.
