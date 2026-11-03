# M3 真实链路证据（复审修订）

日期：2026-11-03。运行目录：[`run-2026-11-03T14-11-57-590Z`](run-2026-11-03T14-11-57-590Z)。
采集环境：隔离 DSH 实例（`DSH_HOME=/root/.dsh-m3`、profile `m3`、state `/root/.dsh-m3/state/m3`、Web 3192、Bridge 3191）与隔离 API/dispatcher（4301）；临时 PostgreSQL 库；私有测试仓库
[`Bouyer12/m3-loop-r2-68fa5d90`](https://github.com/Bouyer12/m3-loop-r2-68fa5d90)（基线 commit
`a52e86a5e98b930d20f101b64b079e78521f7977`）。bootstrap 实例（3082）未重启、未改配置、未替换 runtime；4300 上的线上实例未被修改。

## 内容

| 文件 | 内容 |
| --- | --- |
| `before-desktop-light/dark.png`、`before-mobile-light/dark.png` | 基线：`main` @ `b08f36d` 的真实 M2 构建，经同一个隔离 API 与数据库采集（1440×900 / 390×844，浅色与深色） |
| `after-desktop-light/dark.png`、`after-mobile-light/dark.png` | 本分支构建的 Work 总览，同一 API/数据库/视口/主题/仓库 |
| `after-question-light/dark.png` | Agent 提问出现在网页会话（任务状态 `waiting_input`） |
| `after-review-light/dark.png` | Agent 交付 PR 后的会话与右侧详情（`awaiting_review`） |
| `e2e-result.json` | 22 项自动化检查及结果（无令牌、Cookie、绑定码或私钥） |
| `upstream-state-snapshot.json` | 运行结束后从隔离实例 state 只读导出的 Ticket/Trigger 投影：冻结仓库/分支/commit/模型、PR follow、每个 input 的 `readAt` |
| `run.log` | 运行时间线（隔离护栏、命令、检查、错误） |
| `api.log` / `dispatcher.log` / `dsh-instance.log` | 进程日志；DSH 本地 Web token 已脱敏；机器令牌不写入日志/仓库 |

## 真实闭环

1. E2E 先通过 `scripts/m3/guard.mjs` 校验目录/端口/profile 身份；Playwright 在网页创建 Work 会话并发送任务：
   `3d4115fb-5af9-4330-b380-b5eb2991a036`。
2. 平台消息与 delivery 同事务写入；dispatcher 投递到 Bridge；Bridge 将 Trigger 入库并触发上游 intake。
3. 上游 Ticket `1e96a5d92728f9adc75df3b9af57a9b9`，冻结
   `Bouyer12/m3-loop-r2-68fa5d90@main@a52e86a…` 与 `commandcode/deepseek/deepseek-v4.1-flash`（high）。
4. Agent 通过平台提问 `README.md 第 5 行 "jumps over teh lazy dog" 中的 "teh" 要改成 "the" 还是 "this"？`；网页回复后，
   worker 继续执行；回复消息的 delivery 状态由 worker session 证据推进到 `read`（`readAt 2026-11-03T14:13:34.111Z`）。
5. worker 只改 `README.md`，运行 `npm test`（`README.md copy check passed`），推送分支并创建
   [测试 PR #1](https://github.com/Bouyer12/m3-loop-r2-68fa5d90/pull/1)。平台显示 `awaiting_review` 与 PR 链接。
6. 上游 Ticket 的三个 trigger input 均有 `readAt`（见 snapshot）；平台消息状态从 `stored` 推进到 `delivered`/`read`。

## 复审修复的针对性证据

- **SSE 按序补读**：首连回放 `1..19`，严格递增且不重复；`Last-Event-ID: 19` 重连按顺序补 `20,21,22,23`，
  无缺口、无重复，并包含本次消息的 `message.created` 与 `message.delivery_changed`。回归用例
  `apps/api/test/integration/sse.integration.test.ts` 在只有较晚事件唤醒时仍断言先收到较早行；真实 E2E 使用
  `Last-Event-ID` 请求头复验。
- **重复 Trigger 首次结果**：上游 `0004` 在任何模型/分支校验之前返回已持久化 Trigger 的 `baseCommit`/Ticket；
  回归测试模拟“分支前进 + 原模型不可用”，断言仍为一个 Trigger/一个 Ticket、base 仍为首次冻结值。E2E 中把已送达
  delivery 强制改回 pending 后重投，断言上游 Trigger 数为 1、Ticket 不增加，平台会话 `baseCommit` 前后均保持
  `a52e86a…`。
- **隔离护栏**：E2E 在任何删除/重配前校验 DSH home 不是 `/root/.dsh`、profile 不是 `superagent`、目标端口不是
  3082/4300 且未被占用、profile 链接的构建包含 `moyu-bridge/1`、env 文件为 0600；启动后用 panel `stateDir` 复核实例身份。
  `node --test scripts/m3/guard.test.mjs` 用临时目录与占用端口验证拒绝路径。`build-patched.sh` 校验
  `upstream.lock.json` 的源文件清单，并拒绝已存在的输出目录。
- **收紧断言**：API/Bridge 重启都断言 Trigger 数恰为 1；Bridge 停机期间从平台库断言 delivery 仍为 `pending`、
  `delivered_at` 为空；SSE 断言顺序/完整性/重复；网页问题与 PR 链接均为硬等待，不可见即失败。

## 边界

- E2E 浏览器登录使用隔离测试库中预置的会话 Cookie，以便只验证 M3 消息闭环；Passkey 本身由 M2 的浏览器验收覆盖。虚拟/预置会话不是“真实设备 Passkey”证据。
- 本次模型供应商出现过 `TRANSPORT` 重试（DSH 自动恢复），不是产品重试逻辑。
- 截图文件是 Playwright Chromium 真实产物；测试仓库为私有，审阅者可能无权打开，PR #1 的 URL 与运行日志作为持久证据。
- M4 讨论、M5 资源预算、M6 附件/diff/检查面板不在本阶段。
