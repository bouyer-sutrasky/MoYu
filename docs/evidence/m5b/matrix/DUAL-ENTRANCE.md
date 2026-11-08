# 第 1 项补验：Web / GitHub 双入口顺序与副作用去重（#40）

基线 `main@1001c25`（`d02f07f` 之后）。本条只补一件现有证据没有覆盖的事：

- 已有：GitHub @ 触发进入平台（`item1-entrance-orders.log`）、Web 追加消息到达运行中的票
  （`item1-web-to-github.log`，该方向按设计不回写 GitHub）。
- 缺的：**Web 先创建、GitHub 后触发同一工作**的真实去重；两种顺序下「同一工作只启动一次」、
  重复事件 / 并发到达 / 已处理回执的幂等与真实外部副作用计数。

工具：

- `scripts/m5b/matrix/dual-entrance.mjs` —— `setup` 把临时栈的 GitHub source 指向探测仓库并授权
  发送者；`facts` 只读打印现场事实；`check` 断言不变量并以非零退出表示失败。
- `apps/dispatcher/test/integration/operations.integration.test.ts` 的
  “claims a Web-first task for a later GitHub mention and parks the extra runtime ticket”
  —— 同一语义在真实 PostgreSQL 上的自动断言（CI 里跑，不依赖现场栈）。

## 前置

1. **隔离 harness**：矩阵复跑必须先合入 #36 的隔离改造（PR #49）：测试身份对宿主配置无写权限、
   探测仓库凭据独立、特权文件只落受保护目录。本条的真实取证排在其后，不先用旧 harness 跑。
2. **探测仓库与人工账号**：GitHub 触发必须来自被授权的人（`sutrasky`）的 @ 提及；agent 账号
   自己发的评论会被 source 跳过。探测仓库是公开的 `bouyer-sutrasky/m4-github-probe`。
3. **同一工作身份**：平台仓库、runtime 的 deployment repository、GitHub source 都必须是探测仓库本身，
   这样 Web 消息里的 Issue URL、GitHub 评论的 Issue 和平台任务指向同一个 `owner/name#number`：

   ```
   M5B_MATRIX_REPOSITORY=bouyer-sutrasky/m4-github-probe scripts/m5b/matrix/stack.sh up
   node scripts/m5b/matrix/dual-entrance.mjs setup
   ```

4. **每个顺序单独 `stack.sh up`**：同仓库只允许一个执行名额，上一顺序的运行票会占着租约，
   两个顺序共用一套栈会让后一个顺序合法地排队，测不到「同工作只启动一次」。

## 顺序 A：Web 先创建 → GitHub 后触发（同工作）

```bash
# 1) 每轮用新 Issue，外部副作用计数才有意义（agent 自己的评论不会触发）。
issue=$(gh issue create --repo bouyer-sutrasky/m4-github-probe \
  --title "M5-B dual-entrance probe $(date -Is)" \
  --body "Web-first probe for #40. Do not edit." | awk -F/ '{print $NF}')

# 2) 真实 Web 入口：会话 + 首条消息，消息里写同一 Issue 的完整 URL。
node scripts/m5b/matrix/live.mjs new-task \
  --text "请处理 https://github.com/bouyer-sutrasky/m4-github-probe/issues/${issue}"
#    → conversationId、taskId；等待 worker 启动后取基线事实：
node scripts/m5b/matrix/dual-entrance.mjs facts --order web-first --issue "$issue" \
  --conversation <conversationId> --task <taskId>

# 3) 人工：sutrasky 在该 Issue 下评论（显式点名）
#    "@Bouyer12 请继续处理这个工作"

# 4) 断言（最多等 10 分钟；失败时打印具体不变量）
node scripts/m5b/matrix/dual-entrance.mjs check --order web-first --issue "$issue" \
  --conversation <conversationId> --task <taskId> --phase after-import --wait 600
```

断言（`check` 的 `failures` 为空才算通过）：

| 不变量 | 依据 |
| --- | --- |
| 同一工作身份 | 平台仓库 = 探测仓库；该 Issue 只有一个会话、一个平台任务、任务跟随 Web 侧 runtime Ticket |
| 只启动一次 | Web 侧 Ticket 的已启动 assignment 与 `worker-<ticket>` 会话目录各为 1；GitHub Ticket 两者都为 0 |
| 多余票被停放 | GitHub Ticket `paused.stoppedAt`（或已结束）；`duplicate_tickets` 一行、状态 `paused`/`skipped`；会话里恰好 1 条 “not executed separately” 通知 |
| 副作用 | 该 Issue 线程只有 1 条 `kind=acknowledgement` 的 GitHub 外发且状态 `sent`；Issue 下 agent 账号只有 1 条带 `dsh-superagent:ack:` 的评论；任务无 PR |
| 租约 | 仓库最多 1 条 active 租约，且绑定执行中的任务 |

## 顺序 B：GitHub 先触发 → Web 后追加

```bash
# 新栈、新 Issue；人工在该 Issue 下评论 "@Bouyer12 ..."。
node scripts/m5b/matrix/dual-entrance.mjs check --order github-first --issue "$issue" \
  --phase after-import --wait 600

# Web 追加消息到导入出来的会话（workspace 回执路由保持不变）。
node scripts/m5b/matrix/live.mjs message --conversation <conversationId> --text "补充一条 Web 消息"
node scripts/m5b/matrix/dual-entrance.mjs check --order github-first --issue "$issue" \
  --phase after-followup
```

`after-import` 断言：一个会话 / 一个任务 / 一个 GitHub Ticket，assignment 与会话目录各 1，
无 `duplicate_tickets`，GitHub 外发恰好 1 条（回执）。`after-followup` 追加断言：Web 消息投递
`delivered`（无 failed）、Ticket 无未投递输入、assignment 与会话目录仍为 1（未起第二个 worker）、
GitHub 外发仍为 1（Web 消息只走 workspace 通道，不回写 GitHub）。

## 幂等：重复事件、并发到达、已处理回执

每项都在 `check --phase after-followup` 之后再取证：

1. **并发到达**：同一个 `clientMessageId` 的 Web 消息并发发两次（同请求体同时发），
   一次 202、一次 200 `duplicate:true`；`messages`/`deliveries` 计数不变，GitHub 外发不变。
2. **重复事件 / 已处理回执**：把 dispatcher 的 `runtime_cursors.cursor` 回退一条并重启 dispatcher，
   让 Bridge 重发已在事务里处理过的 import 事件；`check --phase after-replay` 的计数必须与
   `after-followup` 完全一致（会话、任务、消息、投递、`duplicate_tickets`、assignment/会话目录、
   outbox 与 GitHub 评论数都不增）。同一 Issue 上再来一条 @ 提及属于**另一个 runtime Ticket**，
   会多一行 `duplicate_tickets`（同样被停放），不属于本节的「同一事件重放」，如要观测请单独记录，
   不要拿它当 `check` 的输入。

`check` 不把「可能还有别的外发」当通过：如果运行中出了第二条 GitHub 外发（例如报告或提问回写），
它会把该行原样打印并判失败，作为现场发现记录，不擅自放宽判据。

计数口径（与第 1 项既有证据一致，不读平台状态字段当证据）：

- worker 启动 = runtime ticket JSON 里 `startedAt` 存在的 assignment + 对应的 `worker-<ticket>` 会话目录；
- 外部副作用 = runtime outbox 里 `channel.thread = github:<n>` 的行 + GitHub API 上该 Issue 下
  agent 账号的评论（按 `dsh-superagent:ack:` 标记识别）；
- 都从真实 PostgreSQL、runtime 的 Bridge SQLite、会话目录和真实 GitHub 仓库读取。

## 状态与边界

- 本文件是**场景与断言**，**不是通过证明**：真实取证尚未执行，等待 #36 的隔离 harness 合入。
  届时按上面的命令逐条跑，原始输出、脱敏命令和完整 head 追加到本目录。
- 本场景用本地测试 provider，worker 是合成回合，不会开真实 PR；因此 PR 侧副作用只断言
  “任务无 PR”。两处 `stack.sh up` 之外的 3082 bootstrap、生产库、共享 55432 均不触碰。
- GitHub 触发需要 owner 本人在运行窗口内发评论；时间线与评论 id 由 `facts` 的
  `runtime.triggers` / `github.humanComments` 记录，不把人工步骤写成自动通过。
