# 两项建议：`waiting_input` 与 `awaiting_review`

按所有者要求，本轮**只给判断，不动代码**。代码依据同时给两处：

- **产物** `…/upstream/m5b-admission-build21/lib/index.js` —— 矩阵现场实际运行的构建（含 0001–0023），行号以此为准。
- **源码** `…/upstream/m5b-admission-work/src/**` —— 便于定位模块；该树是 0001–0022 加本地改动，不是 0023 构建的逐字源码，所以只用来指认文件与方法名。

---

## A. `waiting_input` 跨重启换了 `assignmentId`

### 结论：**缺陷**，判据不用改，产品语义本来就要求保持

### 依据

1. 现场行为（`item5-waiting_input-restart.log`）：`kill -TERM` 打断在途回合、supervisor wake 之后，
   `state=waiting_input`、`question`、`attention`、`report`、`admission`、`base`、`model`、
   `execution.directory` 全部保持，只有 `assignmentId` 从 `ff5cc1d3…` 变成 `c5c956f8…`（`verdict: DIFFERS`）。
2. 重启时的判定在这里（产物 `lib/index.js:1204-1216`；源码 `src/core/assignments.ts:83-92`）：

   ```ts
   const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
   if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
   else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
   ```

   也就是：**报告状态在 `waiting/ready/blocked/failed` 且之后没有新输入 → 保留同一个 assignment**；
   否则 `restart()`（产物 `lib/index.js:910-931`，源码 `src/core/assignments.ts` 的 `restart`）
   结束旧 assignment、新建一个并带 `RECOVERY_NOTE` 启动 —— 这正是我们看到的 assignmentId 变化。
   该方法的注释也写明了意图：「…unless its latest report is `waiting`, `ready`, `blocked`, or `failed`
   and no input was delivered after that report, in which case **it keeps its session**」。
3. 为什么 `waiting_input` 会落到「不 settled」：能进入 `waiting_input` 的唯一途径是 `ticket.attention`
   （产物 `lib/index.js:9797` 起 `projectTicketState`，其中 `9807: if (ticket.attention) return "waiting_input"`；
   源码 `src/app/bridge.ts:81`），而 attention 由带问题的报告设置（产物 `lib/index.js:1246`；
   源码 `src/core/assignments.ts:120-126`）。报告工具的状态枚举只有
   `progress / ready / blocked / failed / dropped`，**没有 `waiting`**
   （产物 `lib/index.js` 的 `orchestrator_report` schema；源码 `src/app/tools/executor.ts:75-84`，
   并且 `human_action` 的说明就是「also with state=progress」）。所以「提问」写入的是
   `report.state = "progress"`，恰好不在 settled 列表里。
   `waiting` 这个值另有来源：worker 回合结束却没有任何状态报告时由执行器补写
   （产物 `lib/index.js:6783`；源码 `src/executor/dsh.ts:1048`）——那种票反而会被保留。

一句话：**判定条件用的是「报告状态」，而「在等一个人」的事实记在 `ticket.attention` 上；
两者的词表在这里没有对齐，于是「用 `progress` + `human_action` 提问」的票被当成没结论的回合重发。**

### 若要改：动哪个模块

`integrations/superagent/patches/` 新增一条补丁（例如 `0024`），改上游
`src/core/assignments.ts` 的 `interrupted()`（**不是** 本仓库 `apps/` 里的代码）：把
「有未处理的 attention 且没有新输入」也算作 settled，例如

```ts
const settled = (!!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy)
  || (!!ticket.attention && !busy)
```

并同步更新该方法的注释。`waiting` 从词表里去掉或保留都可以，不影响这条判定。

### 影响面与风险

- **平台侧无需改动**：`assignmentId` 没有进 platform 的 `task_links`；平台只按 ticket state 投影，
  `waiting_input` 本来就是 `task_state` 的合法值。dispatcher 的租约/回执按 lease+fencing 而非 assignment。
- **风险 1（主要）**：保留下来的 assignment 依赖磁盘上的 session 文件恢复。若 session 损坏或被清理，
  下一个人回答时 `deliver` 会失败 —— 今天 `interrupted()` 的 restart 恰好掩盖了这种损坏。
  改法应保留兜底：保留 assignment，但若恢复失败则退回 `restart(..., 'hostRestarted', RECOVERY_NOTE)`。
- **风险 2**：票会一直停在 `waiting_input`（与现在相同），但它已经释放执行名额
  （`waiting_input` 在 dispatcher 的 `IDLE_RUNTIME_STATES` 里），不会占住仓库。
- **风险 3（交付成本）**：这是上游补丁 → runtime 产物会变（`dsh-superagent` 的 `lib/index.js` hash 变），
  按本单已立的规矩，M5-B 现场证据要在新产物上重跑；dispatcher 产物 `0e981c52…` 不受影响。

### 建议的验证方式（下一轮可直接跑）

用现有 harness 重跑 `item5-restart.sh waiting_input`，断言：`assignmentId` 前后相同、
`runtime_cursors` 在「回答/继续」这一次真实投递后推进。若 owner 选「改判据」而非改代码，
那就把该子项的判据明确写成「状态/问题/注意力保持，assignment 可被重发」，并把这条写进验收表。

---

## B. `awaiting_review` 观测不到

### 结论：**改判据**，产品行为不动

### 依据

1. 结票发生在报告处理里，不在投影里（产物 `lib/index.js:1260-1263`；源码 `src/core/assignments.ts:129-135`）：

   ```ts
   const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
   const willStart = ticket.mode === 'discuss'
   const outcome = report.state === 'dropped' ? … : report.state === 'ready' && !willStart ? ready : undefined
   if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
   ```

   源码注释写得很清楚：「A ticket that follows Threads ends with them: a ready report ends it only
   once `followsDone` holds」。也就是说 **ready 只在不跟随任何未闭合 Thread 时才结票**；
   discuss 票（`willStart`）永不在这里结票。
2. `projectTicketState`（产物 `lib/index.js:9797-9815`，`9810: if (report?.state === "ready") return "awaiting_review"`；源码 `src/app/bridge.ts:65-89`）先看 `ended`，
   所以已结票的票一定是 `completed` / `closed_unmerged` / `stopped`；`awaiting_review` 只属于
   「没结票 + 最新 assignment 的报告是 ready」的票。两者并不矛盾：**它本来就不是给「无 PR 的 execute 票」用的**。
3. `follows` 由 GitHub Source 在 PR 上绑定（源码 `src/sources/github-pull.ts:48,72`，
   worker 自己开的 PR 记 `own`）；PR 关闭/合并时才走 `threadClosed` 结票
   （源码 `src/core/tickets.ts:109-125`）。本轮的 fixture 里 worker 从不发 PR，`follows` 为空，
   于是 ready 直接 `completed` —— 这是设计内行为，不是投影顺序的 bug。我上一轮把它写成
   「`if (ticket.ended)` 抢在 `report ready` 前面，所以状态永远看不到」，**根因定位不完整，这里更正**：
   真正的原因是这张票没有跟随任何 Thread。

### 若要改：两种方向的代价

- **改判据（建议）**：该项现场用「agent 账号在测试仓库开一个仍 open 的 PR」的票来测 ——
  worker 会在 `orchestrator_report` 里带 `pr_number`，runtime 把 PR thread 绑到票上，
  ready 报告后 `followsDone` 为 undefined → 票保持打开 → `awaiting_review` 可见；PR 合并/关闭后转 `merged/closed`。
  影响面：**零代码改动**，只是 fixture 要能开 PR（需要在测试仓库留一个 open PR，owner 若不允许就写明该子项不适用）。
- **改产品行为**（ready 后不自动结票）：要动 `src/core/assignments.ts:129-135` 的 `outcome` 计算。
  代价：无 PR 的票会永远停在 `awaiting_review`，需要有人或事件来关闭，否则 UI 上永远是「待审阅」；
  `completed` 终态在「没有跟随 Thread」的票上消失，依赖它的下游（会话完成、通知、durable 结束事件）语义全变；
  而执行名额不受影响（`awaiting_review` 已释放名额）。**收益低、面大，不建议。**
- **改投影优先级**（让 `ended` 输给 `report ready`）：等于把一个已结束的票显示成「待审阅」，
  会让 `ended.by/outcome`、终态与保留策略自相矛盾，**不建议**。

---

## 汇总

| 子状态 | 建议 | 依据 | 改动规模 |
| --- | --- | --- | --- |
| `waiting_input` 换 assignment | **改产品（修缺陷）** | `interrupted()` 的 settled 判定漏了 `ticket.attention`；提问走 `progress`+`human_action`，工具词表里没有 `waiting` | 上游补丁 0024，改 `src/core/assignments.ts` 一处判定 + 注释；runtime 产物变，M5-B 证据需在新产物上重跑 |
| `awaiting_review` 取不到 | **改判据** | ready 只在不跟随未闭合 Thread 时结票；PR 由 `github-pull.ts` 绑定；无 PR fixture 合法地直接 `completed` | 零代码改动，需要一个能开 open PR 的 fixture |

排队中的下一件（`running` 子状态用最终产物重跑重启对账）按你的要求没有开工。
