# M3 真实链路证据

日期：2026-11-03。运行目录：[`run-2026-11-03T13-21-09-826Z`](run-2026-11-03T13-21-09-826Z)。
采集环境：隔离 DSH 实例（`DSH_HOME=/root/.dsh-m3`、profile `m3`、state `/root/.dsh-m3/state/m3`、Web 3192、Bridge 3191）与隔离 API/dispatcher（4301）；临时 PostgreSQL 库；私有测试仓库
[`Bouyer12/m3-loop-final-68fa5d90`](https://github.com/Bouyer12/m3-loop-final-68fa5d90)（基线 commit
`7d1fa6924dae34319a9fe83491e8f277b7959851`）。bootstrap 实例（3082）未重启、未改配置、未替换 runtime；4300 上的线上实例未被修改。

## 内容

| 文件 | 内容 |
| --- | --- |
| `before-desktop-light.png` / `before-mobile-light.png` | 基线：`main` @ `b08f36d` 的真实 M2 构建，经同一个隔离 API 与数据库采集（1440×900 / 390×844，浅色） |
| `after-desktop-light.png` / `after-mobile-light.png` | 本分支构建的 Work 总览，同一 API/数据库/视口/主题/仓库 |
| `after-question-light.png` | Agent 提问出现在网页会话（任务状态 `waiting_input`） |
| `after-review-light.png` | Agent 交付 PR 后的会话与右侧详情（`awaiting_review`） |
| `e2e-result.json` | 19 项自动化检查及结果（无令牌、Cookie、绑定码或私钥） |
| `run.log` | 运行时间线（命令、检查、错误） |
| `api.log` / `dispatcher.log` / `dsh-instance.log` | 进程日志；DSH 本地 Web token 已脱敏；机器令牌不写入日志/仓库 |

## 真实闭环

1. Playwright 在网页创建 Work 会话并发送任务：`fd749c36-aa65-474f-86bd-1021886fb7e1`。
2. 平台消息与 delivery 同事务写入；dispatcher 投递到 Bridge；Bridge 将 Trigger 入库并触发上游 intake。
3. 上游 Ticket `95faa6d62098ea25897debd3b62254fe`，冻结 `Bouyer12/m3-loop-final-68fa5d90@main@7d1fa69…` 与
   `commandcode/deepseek/deepseek-v4.1-flash`（high）。
4. Agent 通过平台提问：`README.md 第 5 行的 “teh” 要改成 “the” 还是 “this”？`；网页回复后，worker 继续执行。
5. worker 只改 `README.md`，运行 `npm test`（`README.md copy check passed`），推送分支并创建
   [测试 PR #1](https://github.com/Bouyer12/m3-loop-final-68fa5d90/pull/1)。平台显示 `awaiting_review` 与 PR 链接。
6. 上游 Ticket 的三个 trigger input 均有 `readAt` 证据；平台消息状态从 `stored` 推进到 `delivered`/`read`。

## 可靠性检查（均来自同一次真实运行）

- 同一 `clientMessageId` 并发 5 次：5 个成功响应，数据库只有 1 条 message、1 条 delivery；Bridge 只有 1 个 Trigger；没有新 Ticket。
- 丢失回执：把已送达 delivery 强制改回 `pending` 并清空证据，dispatcher 用同一 trigger id 重投；Bridge 返回 duplicate，Trigger 仍为 1，Ticket 不增加。
- API 重启：停止 dispatcher → API 接受消息 → 重启 API → 消息仍在 → 启动 dispatcher 后恰好投递一次（trigger count 1）。
- Bridge 重启：停止隔离实例 → 平台接受消息且 delivery 保持 pending → 重启实例 → 恰好投递一次（trigger count 1）。
- SSE：首连回放 19 个持久事件；断开后带 `Last-Event-ID: 19` 重连，补发 20、21，无重复、无缺口。
- 同一 clientRequestId 重复创建会话、同一消息不同 payload 的 409 由 API 集成测试覆盖（唯一索引 + payload 指纹）。

## 边界

- E2E 浏览器登录使用隔离测试库中预置的会话 Cookie，以便只验证 M3 消息闭环；Passkey 本身由 M2 的浏览器验收覆盖。虚拟/预置会话不是“真实设备 Passkey”证据。
- 本次模型供应商出现过 `TRANSPORT` 重试（DSH 自动恢复），不是产品重试逻辑。
- 截图文件是 Playwright Chromium 真实产物；测试仓库为私有，审阅者可能无权打开，PR #1 的 URL 与运行日志作为持久证据。
- M4 讨论、M5 资源预算、M6 附件/diff/检查面板不在本阶段。
