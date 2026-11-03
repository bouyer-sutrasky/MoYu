# M3 真实链路证据（第三轮复审修订）

日期：2026-11-03。运行目录：[`run-2026-11-03T15-18-10-024Z`](run-2026-11-03T15-18-10-024Z)。
采集环境：隔离 DSH 实例（`DSH_HOME=/root/.dsh-m3`、profile `m3`、state `/root/.dsh-m3/state/m3`、Web 3192、Bridge 3191）与隔离 API/dispatcher（4301）；临时 PostgreSQL 库；私有测试仓库
[`Bouyer12/m3-loop-r3-68fa5d90`](https://github.com/Bouyer12/m3-loop-r3-68fa5d90)（基线 commit
`bad7eac5174a3090078cbf687e76c41af1dc1b98`）。bootstrap 实例（3082）未重启、未改配置、未替换 runtime；4300 上的线上实例未被修改。

## 内容

| 文件 | 内容 |
| --- | --- |
| `before-desktop-light/dark.png`、`before-mobile-light/dark.png` | 基线：`main` @ `b08f36d` 的真实 M2 构建，经同一个隔离 API 与数据库采集（1440×900 / 390×844，浅色与深色） |
| `after-desktop-light/dark.png`、`after-mobile-light/dark.png` | 本分支构建的 Work 总览，同一 API/数据库/视口/主题/仓库 |
| `after-question-light/dark.png` | Agent 提问出现在网页会话（任务状态 `waiting_input`） |
| `after-review-light/dark.png` | Agent 交付 PR 后的会话与右侧详情（`awaiting_review`） |
| `e2e-result.json` | 24 项自动化检查及结果（无令牌、Cookie、绑定码或私钥） |
| `upstream-state-snapshot.json` | 运行结束后从隔离实例 state 只读导出的 Ticket/Trigger 投影：冻结仓库/分支/commit/模型、PR follow、每个 input 的 `readAt` |
| `run.log` | 运行时间线（隔离护栏、故障注入、命令、检查、错误） |
| `api.log` / `dispatcher.log` / `dsh-instance.log` | 进程日志；DSH 本地 Web token 已脱敏；机器令牌不写入日志/仓库 |

## 真实闭环

1. E2E 在任何删除/启动前解析并校验实例 env，用 `scripts/m3/guard.mjs` 校验目录/端口/profile/构建身份和符号链接边界；Playwright 在网页创建 Work 会话并发送任务：
   `61632ee0-eb4d-46df-a330-317f1eae189e`。
2. 平台消息与 delivery 同事务写入；dispatcher 经故障代理投递到 Bridge；代理在 Bridge 已持久化 Trigger、平台尚未收到 HTTP 回执时丢弃该响应，dispatcher 用同一 trigger id 重试并收到 `duplicate`。
3. 上游 Ticket `c46147d8c102515393b66a45e0145c4c`，冻结
   `Bouyer12/m3-loop-r3-68fa5d90@main@bad7eac…` 与 `commandcode/deepseek/deepseek-v4.1-flash`（high）。
4. Agent 通过平台提问 `README.md 第 5 行里的 “teh” 应改成 “the” 还是 “this”？…`；网页回复后，回复消息的 delivery 由 worker session 证据推进到 `read`（`readAt 2026-11-03T15:20:39.163Z`）。
5. worker 只改 `README.md`，运行 `npm test`（`README.md copy check passed`），推送分支并创建
   [测试 PR #1](https://github.com/Bouyer12/m3-loop-r3-68fa5d90/pull/1)。平台显示 `awaiting_review` 与 PR 链接。
6. 上游 Ticket 的三个 trigger input 均有 `readAt`（见 snapshot）；平台消息状态按证据推进到 `delivered`/`read`。
7. 运行结束时断言平台任务与 Bridge Ticket 的冻结 commit 一致（`bad7eac…`），且首次丢失回执后上游只有 1 个 Trigger/1 个 Ticket。

## 第三轮复审修复的针对性证据

- **filtered Trigger 重放**：上游 `0004` 在模型/分支校验前读取已持久化 Trigger；若 Store 有 filtered disposition，则返回 `filtered` 而不是 `duplicate`。上游回归覆盖；平台 dispatcher 回归断言该 delivery 为 `failed`、`delivered_at`/`read_at` 为空、没有 Ticket。
- **env 配置覆盖**：E2E 先解析 env 文件一次并拒绝白名单外的键（尤其 `DSH_HOME`），校验 `MOYU_PLATFORM_URL` 必须指向本次隔离 API、Bridge 端口一致且空闲，拒绝与进程环境冲突的 home/profile/platform/port；构造启动环境时只注入校验后的 home 和 env。测试证明误填 bootstrap home 或 4300 时脚本在创建 run 目录、清理、启动、重配之前退出。
- **符号链接越界**：`guard.mjs` 通过 `realpath` 校验 home、state/sessions 父目录和 profile 的真实位置，profile 仅允许单一路径组件；测试用指向另一实例的 `state` 符号链接构造越界，断言 guard 拒绝且目标文件保留。
- **早到 task.progress**：`deferred_bridge_events` 持久保存未关联事件，`ticket.linked` 投影后在同一事务内按序补投影并删除；dispatcher 回归覆盖 `task.progress` 先于 `ticket.linked`，最终可见且重放同一页只投影一次。
- **首次回执丢失整链路**：E2E 的 loopback 故障代理在 Bridge 响应后丢弃首个 trigger 回执，dispatcher 重试同一 ID；断言只有 1 个 Trigger/1 个 Ticket，平台与 Ticket 的冻结 SHA 均为 `bad7eac…`。
- **SSE**：首连回放 1–17 严格递增不重复；`Last-Event-ID: 17` 重连按序补 18、19，包含本次消息事件。
- **回滚**：`0002/0003` 的 down SQL 已按 Drizzle `hash` 在临时库实测回滚并重新迁移成功；步骤见 `docs/M3-VERIFICATION.md`。

## 边界

- E2E 浏览器登录使用隔离测试库中预置的会话 Cookie，以便只验证 M3 消息闭环；Passkey 本身由 M2 的浏览器验收覆盖。虚拟/预置会话不是“真实设备 Passkey”证据。
- 本次模型供应商出现过 `TRANSPORT` 重试（DSH 自动恢复），不是产品重试逻辑。
- 截图文件是 Playwright Chromium 真实产物；测试仓库为私有，审阅者可能无权打开，PR #1 的 URL 与运行日志作为持久证据。
- M4 讨论、M5 资源预算、M6 附件/diff/检查面板不在本阶段。
