# M6-A 证据汇总（A1–A8 重跑）

本轮重跑 head：`55d9e2935baebd3f660c9753ca5621d9ef8a980d`。每份 `A*.txt` 第 3 行是产出时的
`git rev-parse HEAD` 原始输出。基线（A8 before）：`main@1001c2544c68b8f4d906e330566f6fdb6ff0c795`。
重跑时间：2026-11-09 00:12–00:19 +08:00。现场：隔离 PostgreSQL `127.0.0.1:55432`、
API `4620`/`4621`、supervisor `4690`、录制用 Bridge `4699`、`/tmp/m6a-run-rerun`。

重跑原因：P1 返修动过服务启动方式（`scripts/m6a/evidence.sh` 的 `start_owned`/`setsid`）与
消息/附件写入路径（合并事务、Composer 绑定），`d4d5801` 上的旧 A1–A8 不再代表当前代码。
详见 [`../../M6-A-VERIFICATION.md`](../../M6-A-VERIFICATION.md) §0。

| 项 | 判定 | 依据 |
| --- | --- | --- |
| A1 上传主链路 | 通过 | `A1-upload.txt`（201/逐字节下载/HTML 不内联/库表行）+ 真实浏览器附件操作 `after-desktop-light-attachment.png`、`after-mobile-light-attachment.png`（chip=1、消息含附件、sha256 一致） |
| A2 上传拒绝面 | 通过 | `A2-rejections.txt`（413/422/401/404/空文件；每次拒绝前后 `rows=5 files=5 bytes=271` 不变） |
| A3 附件与投递 | 通过（附件未传给 runtime，已记录） | `A3-attachment-delivery.txt`（附件与消息同事务绑定；Bridge Trigger 只有 text） |
| A4 diff 面板 | 通过 | `A4-diff.txt`（真实 diff/patch 逐字节、clean/cleaned） |
| A5 检查面板 | 通过 | `A5-checks.txt`（真实 `pnpm check`：exit 0 → 2 → 0；失败态截图） |
| A6 提交与 PR | 通过 | `A6-delivery.txt`（PR #44 open @`55d9e29`、PR #45 closed 未合并、GitHub 不可用原因） |
| A7 重启与已清理边界 | 通过 | `A7-restart.txt`（同一任务真实 `available→cleaned`：先 available/files=0，`rm -rf` 后 cleaned+原因；重启后投影相同、cleaned 持久、附件 sha256 一致） |
| A8 回归 | 通过 | `A8-regression.txt`（before main：单测 supervisor 38、API 集成 66；after head：supervisor 59、API 集成 86；均 exit 0） |

## 本轮未验证 / 已知缺口

- **检查子进程的独立低权身份未实现**：supervisor 单元以非特权用户 `moyu-m5b` + `NoNewPrivileges=yes`
  运行，进程内无法切换 uid/gid；检查命令仍以 supervisor 身份运行。需要特权启动器改造，等所有者决定。
- **worker 只拿到文本，不含附件**（A3）：投递到 runtime 的 Bridge Trigger 没有 `attachments` 字段，
  归计划 L113；附件保存在平台并随消息展示/下载。
- **手机端附件操作只有浅色主题**：`after-mobile-light-attachment.png` 为真实 390×844 的附件选择/发送；
  未补手机深色主题的附件操作截图（面板深色截图仍在）。
- A1–A8 是隔离 API + 真实 PostgreSQL + 真实 git worktree + 真实 Chromium 的端到端证据，未使用 mock
  冒充；未在生产部署或真实 DSH runtime 上验收（见验证记录 §6）。
