# MoYu 部署与验收事实（现行）

本文件记录**当前真实环境**，供每个阶段任务直接引用，不必在 Issue 里重复交代。
事实变更时（换域名、换端口、换机器）更新本文件并走 PR，不要散落在 Issue 里。

## 0. 2026-11-16 现场校正

- 公网 `https://moyu.sutrasky.com` 当前 nginx upstream 是 `127.0.0.1:4310`，由
  `moyu-m6c-api.service` 提供服务；旧 `moyu.service`（4300）已停止但仍 enabled。
- 三服务当前实际 release 不一致：API `/opt/moyu-m6c/releases/7a12dbcab461`，
  supervisor `e3a677e03b4d-kill`，dispatcher `e910ccce6dad-lost`。这是 M6-C
  收尾必须消除的版本混跑，不能当作已发布状态。
- 在用数据库是 `moyu_m6c`，2026-11-16 回读 20 条迁移；0019 正向文件 hash
  为 `e26aa1a486c36303d69dbae6b5f125187738d1c3460184f119e009a95fda7453`。
- M6-C unit 模板在 `deploy/systemd/moyu-m6c-*.{service,slice}`；正式切换必须
  三服务指向同一 release，并用 `scripts/m6c/verify-running.mjs` 回读 MainPID、
  cwd、cmdline 和制品 hash。
- 本节是现场事实；正式发布后必须用同一脚本重写，而不是沿用历史快照。

## 1. 仓库与流程

| 项 | 值 |
| --- | --- |
| 仓库 | `bouyer-sutrasky/MoYu`（组织 `bouyer-sutrasky`，**公开**） |
| agent 账号 | `Bouyer12`（仓库 Admin，SSH key 走 `ssh.github.com:443`） |
| 默认分支 | `main` |
| 分支保护 | 必须走 PR；审批数 **0**（仅两个账号，禁止自批）；要求分支 up-to-date；禁 force push；禁删除；`enforce_admins` 开启 |
| 必需检查 | `check (lint, format, types, unit tests, build)`、`integration (real PostgreSQL)` |

直推 `main` 会被服务端拒绝：

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Changes must be made through a pull request.
remote: - 2 of 2 required status checks are expected.
```

## 2. 域名与 TLS

| 项 | 值 |
| --- | --- |
| 域名 | `https://moyu.sutrasky.com` → `117.72.211.55` |
| 证书 | Let's Encrypt，`/etc/letsencrypt/live/moyu.sutrasky.com/` |
| 续期 | `certbot.timer`（systemd）自动续期 |
| http | 301 跳 https |
| Passkey RP ID | `moyu.sutrasky.com` |
| Passkey origin | `https://moyu.sutrasky.com` |

正式凭据只在该域名下登记；**不要**用 `localhost`、裸 IP 或其它域名登记正式凭据。
开发期测试凭据同样只在本域名下，不要污染生产 RP ID。

## 3. 运行与反代

| 项 | 值 |
| --- | --- |
| 应用监听 | `127.0.0.1:4310`（M6-C candidate；旧 4300 已停） |
| nginx vhost | `/etc/nginx/sites-available/moyu.conf`（软链到 `sites-enabled/`） |
| 反代目标 | `http://127.0.0.1:4310`（2026-11-16 实测） |
| WebSocket/SSE | 升级头已配；`proxy_read_timeout 3600s` |
| 健康检查 | 应用起来前 `https://moyu.sutrasky.com` 返回 502，属预期 |

**服务身份（#58，待所有者切换）**：线上 `moyu.service` 目前仍是 root。仓库已交付
`deploy/systemd/moyu.service`（`User=moyu-web`、`NoNewPrivileges=yes`、
`ProtectSystem=strict`、`PrivateTmp=yes`、空 capability 集）与 supervisor 的检查身份
（`moyu-check` + 仅 `CAP_SETUID/CAP_SETGID` 的 `setpriv`）。用户/目录准备、切换与回滚见
[`deploy/systemd/README.md`](../deploy/systemd/README.md) 与
`docs/evidence/m6a/P1A3b-check-identity.txt`；切换由所有者执行。

## 4. 不得触碰

- 其它 nginx 站点：`ui.sutrasky.com`、`preview.sutrasky.com`、`spring-boot-lab-*`、`default`
- 本机其它服务：`linuxqq` / `snowluma` / `qq-agent` / `qq-vision-router` / `qq-xvnc` / `qq-xvfb`、`mcsm-web` / `mcsm-daemon`、`ui-assets-*`、`spring-boot-lab-code`、`nginx`、`mysql`
- 其它 profile 的 DSH 状态与其它仓库

## 5. 验收与证据规范

- **自动化**：无硬件密钥时用 Playwright + CDP 虚拟认证器（`WebAuthn.addVirtualAuthenticator`）跑完整注册 / 登录 / challenge 重放 / 会话撤销。虚拟认证器只作自动化证据，**不得写进生产路径**，也不得在报告中表述为"真实设备已验证"。
- **真机**：PR 提交后由所有者用自己的设备完成一次真实绑定。
- **截图**：桌面 ≥1440×900、手机 ≤390×844，浅色与深色各一组，必须真实浏览器产物。
- **禁止**：mock、静态页面或伪造日志冒充接通；未验证项必须单列。

## 独立讨论 runtime

讨论（`executionMode=discuss`）可配置为独立进程，不共享执行 runtime 的写凭据：

- 部署 `integrations/superagent/discuss-runtime/` 的 `discuss-sandbox.sh` 到 `/usr/local/bin/m4-discuss-sandbox`，profile 到专用用户 `moyu-discuss` 的 `~/.dsh/profiles/discuss/cordis.patch.yml`；profile 只放 `COMMAND_CODE_API_KEY`。
- 管理面板的 executor 设置 `discussCommand=/usr/local/bin/m4-discuss-sandbox`。
- 脚本把 ticket worktree 复制成 root 所有的只读快照（目录 555、文件 444），`setpriv` 到 `moyu-discuss` 后启动 headless DSH；讨论进程不可访问 `/root`、GitHub/Bridge token 或 worktree 写权限。
- 负向证据写入 `/tmp/m4-discuss-evidence.log`：host/discuss UID、快照 owner/mode、`root_env_readable`、`worktree_write`、`ssh_key_readable`。
