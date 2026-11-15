# M6-C candidate runbook

Scope: the **isolated candidate** stack on jd-mc. Production (`moyu.sutrasky.com`,
`moyu.service`, port 3082) is out of scope and is not modified by these steps.

## Components

| component | unit | user | listen |
| --- | --- | --- | --- |
| API + web | `moyu-m6c-api.service` | `moyu-m6c` | `127.0.0.1:4310` |
| supervisor | `moyu-m6c-supervisor.service` | `moyu-m6c` | `127.0.0.1:4491` |
| dispatcher | `moyu-m6c-dispatcher.service` | `moyu-m6c` | none |
| runtime instances | started by the supervisor | `moyu-m6c` | `3461/3462`, `3463/3464`, `3465/3466` |
| review checks | child of the supervisor | `moyu-m6c-check` (987:981) via `setpriv` | none |

Boundary slice `moyu-m6c.slice` (`MemoryMax=8G`, `MemoryHigh=6G`). HTTPS entry
`https://moyu-m6c.117-72-211-55.sslip.io`, vhost `/etc/nginx/sites-available/moyu-m6c.conf`,
own Let's Encrypt certificate, upstream `127.0.0.1:4310`.

## Paths

```
/opt/moyu-m6c/app                         staged build (root-owned, world-readable)
/opt/moyu-m6c/artifacts/superagent-<sha>  pinned dsh-superagent artifact
/opt/moyu-m6c/profile-template            DSH profile template (placeholders per profile)
/opt/moyu-m6c/runtime/{node24,pnpm}       Node 24 copy and standalone pnpm 11.7.0
/opt/moyu-m6c/bin/{node,pnpm,gh-agent}    PATH shims for the service and check identities
/etc/moyu-m6c/{api,supervisor,dispatcher}.env   0600 root, values never committed
/etc/moyu-m6c/instances.json              pinned repository -> profile/port mapping
/var/lib/moyu-m6c/{dsh,credentials,instances,logs,worktrees,artifacts}
```

## Start / stop

Migrations must run before the supervisor starts (it reads
`repositories.check_commands`, added by `0018`):

```bash
cd /opt/moyu-m6c/app
set -a; . /etc/moyu-m6c/api.env; set +a
/opt/moyu-m6c/runtime/node24/bin/node /opt/moyu-m6c/runtime/pnpm/node_modules/pnpm/bin/pnpm.cjs \
  --filter @moyu/db db:migrate
systemctl start moyu-m6c.slice moyu-m6c-api moyu-m6c-supervisor moyu-m6c-dispatcher
```

Instances start on demand when a wake request arrives (web task or reply). They are not
enabled at boot on purpose: a sleeping repository must not be resurrected by a host reboot.

## Health

```bash
curl -fsS http://127.0.0.1:4310/readyz
TOKEN=$(grep '^SUPERVISOR_TOKEN=' /etc/moyu-m6c/supervisor.env | cut -d= -f2-)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4491/control/v1/health
curl -fsS https://moyu-m6c.117-72-211-55.sslip.io/healthz
```

The dispatcher has **no HTTP health endpoint**. Prove it with the process, its log
(`dispatcher.ready` in `/var/lib/moyu-m6c/logs/dispatcher.log`), the durable cursors in
`runtime_cursors`, and an actual `deliveries` row.

## Logs

`/var/lib/moyu-m6c/logs/{api,supervisor,dispatcher}.log` and
`/var/lib/moyu-m6c/logs/<profile>.log` per instance. No logrotate rule is installed for the
candidate yet.

## Credentials

`/var/lib/moyu-m6c/credentials/<repositoryId>.json` (0600, written by the supervisor) holds
the per-repository Bridge token; the database stores only `file:<repositoryId>.json` and a
sha256 of the callback token. `/var/lib/moyu-m6c/dsh/.env` holds `COMMAND_CODE_API_KEY`.
Neither is in the repository and neither is printed by these steps.

## Rollback (candidate only)

```bash
systemctl stop moyu-m6c-dispatcher moyu-m6c-supervisor moyu-m6c-api
rm -f /etc/nginx/sites-enabled/moyu-m6c.conf
nginx -t && systemctl reload nginx
systemctl disable --now moyu-m6c-api moyu-m6c-supervisor moyu-m6c-dispatcher
systemctl stop moyu-m6c.slice
dropdb --if-exists moyu_m6c
userdel moyu-m6c-check; userdel moyu-m6c
rm -rf /opt/moyu-m6c /var/lib/moyu-m6c /etc/moyu-m6c
```

Pre-change nginx state: `/root/m6c-nginx-sites-before.txt`; site config copy:
`/root/m6c-backup-20261115/`.

## Known limitations

- `repositories.status` stays `provisioning`; judge an instance by `runtime.reasonCode`.
- Per-instance memory limits require the delegated cgroup above; without it the supervisor
  refuses to start an instance ("refusing to start an unmetered instance").
- The candidate certificate is for an `sslip.io` hostname. WebAuthn credentials registered
  there are candidate-only and must never be used as the production passkey.
- Acceptance automation uses a CDP virtual authenticator: it proves the ceremony works, it is
  not a real-device passkey.
- `moyu.sutrasky.com` is **not** pointed at this stack. Moving it there is the formal release
  step and needs the owner's real-device passkey registration.
