# M4 执行控制与 GitHub 汇总

日期：2026-11-04。范围：`docs/DEVELOPMENT-GUIDE.md` 第 4 阶段与 Issue #21。

本文补充 [`M3-BRIDGE-PROTOCOL.md`](M3-BRIDGE-PROTOCOL.md) 之后的机器协议与状态语义。M3 的端点、认证、幂等键和事件日志保持不变；
M4 只新增能力，不修改 M3 已发布的请求/响应。上游固定 commit 与补丁顺序见
[`integrations/superagent/upstream.lock.json`](../integrations/superagent/upstream.lock.json)。

## 1. 先讨论 / 直接执行

### 1.1 讨论态的硬约束

`executionMode:'discuss'` 的会话在 runtime 侧对应 `ticket.mode = 'discuss'`。只读不是提示词或前端开关，而是三层执行约束：

| 层 | 约束 | 证据 |
| --- | --- | --- |
| 工具 | 讨论 worker 只注册只读工具：`read`、`read_image`、`glob`、`grep`、`web_search`、`web_fetch`、`skill`、`todo_write`；没有 `write`、`edit`、`bash`、`pwsh`、job、subagent 或消息类工具 | `Sessions` 对 worker 的 `tools.restrict` 允许列表（`DISCUSS_TOOLS`） |
| 沙箱/审批 | 讨论 Session 固定 `permissionPresets` 的 `read-only`（沙箱 `read-only` + 审批 `ask`），任何写入调用在无人类审批时拒绝 | DSH `dsh-sandbox`/`dsh-permission-presets`；不把 `danger-full-access` 用于讨论 |
| 凭据 | 讨论 worker 的环境不新增写凭据；没有 shell 工具就调用不到 `gh`/`git` 写操作；`MOYU_BRIDGE_TOKEN`、`MOYU_PLATFORM_TOKEN` 从不进入 worker 会话 | `workspace.environment` 只发布非秘密仓库/分支/模型标识；工具允许列表 |

工作目录由 runtime 的固定 `executor.prepare` 命令在 Session 启动前准备；讨论 worker 可以在其中读取，但上述工具与沙箱禁止它写入。
runtime 自身仍需要写目录才能 checkout，这不等于把写权限交给模型。

### 1.2 转执行态

`POST /api/v1/tasks/:id/start` 接受 `{planRevision, expectedVersion, clientCommandId}`：

1. 平台要求 `task.execution_mode = 'discuss'`、状态允许启动、`planRevision >= 1`、`expectedVersion` 与当前 `task.version` 一致。
2. 平台在**同一事务**记录 `conversations.plan_revision`、`task_links.plan_revision`、`execution_mode = 'execute'`，并把
   `baseCommit` 冻结为会话已记录值（为空时沿用 runtime 在首次 accept 时解析的 commit）。
3. 平台通过 Bridge `POST /bridge/v1/tickets/:id/start` 通知 runtime；不新建 conversation、不新建 Ticket。
4. runtime 在同一次原子写中把 Ticket 的 `mode` 置为 `execute`、记录 `planRevision`，结束讨论 Assignment，创建执行 Assignment。
   执行 Assignment 的 launch 才把 Session 切到 `danger-full-access` 与工作工具，并继续使用原工作目录、原 PR 和原会话。
5. 平台只有在 Bridge operation 成功且 Ticket 快照显示 `mode:'execute'` 后才把任务显示为执行态；operation 失败显示 `blocked`。

### 1.3 状态

讨论中的 Ticket 在平台投影为 `discussing`；等待回答为 `waiting_input`；讨论完成待审阅为 `awaiting_review`。执行态沿用 M3 的投影。

## 2. 可恢复的人工暂停

### 2.1 三种语义必须分开

| 语义 | 平台入口 | Bridge 端点 | 上游行为 | 可继续 | 现场 |
| --- | --- | --- | --- | --- | --- |
| **人工暂停** | `POST /api/v1/tasks/:id/stop` | `POST /bridge/v1/tickets/:id/pause` | 取消当前 turn（`keepInbox:true`）、杀掉 Session 的 shell jobs、释放 subagents、等待 idle，写入停止证据；Ticket 不 `ended` | 是（resume） | Ticket、工作目录、PR、消息历史全部保留 |
| **上游终态 stop** | 不暴露 | 不调用 | `end(ticket,'human','stopped')`，清空 undelivered/attention | 否 | M4 禁止用平台「停止」触发 |
| **失败重试** | `POST /api/v1/tasks/:id/retry` | `POST /bridge/v1/tickets/:id/retry` | 只对 `failed`/`blocked` 或投递失败的开放 Ticket 结束旧 Assignment 并新建 Assignment | 不适用 | 同一 Ticket |

平台「停止」**不得**调用 3082 面板的 `POST /orchestrator/api/tickets/:id/stop`。该路由结束 Ticket，与本项目「停止后可继续」冲突。

### 2.2 状态机

平台：`running|discussing|waiting_input|awaiting_review|queued` → `stopping` → `stopped`（只有停止证据落库后）→ `queued`（resume）。

runtime：`ticket.paused = { at, by:'human', operationId, stoppedAt?, evidence?, error? }`。
- 设置 `paused` 时立即写 `at`，平台显示 `stopping`。
- Executor 完成后写 `stoppedAt` 与证据；Bridge 投影为 `stopped`，平台才允许显示已停止。
- 结束、`stop`、`end` 等终态可以清理 `paused`，但人工暂停的 Ticket 不是 `ended`。

### 2.3 停止完成证据

一次暂停的证据至少包含：

```jsonc
{
  "ticketId": "…", "operationId": "发起暂停的操作", "sessionId": "worker-…",
  "assignmentId": "…",                       // 只有存在 Assignment 时才有
  "harnessPid": 12345, "cgroup": "0::/system.slice/dsh-superagent.service",
  "startedAt": "…", "stoppedAt": "…",
  "agentStatus": "idle",                     // 或 "absent"：宿主重启后 Session 未装载
  "jobsBefore": [{ "id": "bash-…", "name": "npm test" }],
  "jobsAfter": [],
  "subagentsAfter": 0,
  "cancelledTurn": true,
  "launch": "none | aborted | timed-out"
}
```

- `assignmentId` 只在有 Assignment 时才写。GitHub 入口在平台准入前（`pending_admission`）就没有 Assignment；这种暂停以
  `ticketId` + `paused.operationId` 认身份，Executor 仍要回答「这票没有任何东西还在跑」。不得因为拿不到 `assignmentId`
  就跳过结算。
- `launch` 是本次暂停看到的启动阶段：`none` 没有正在进行的 launch，`aborted` 已在停止上限内结束，`timed-out` 没结束。
  `timed-out` 不是停止，即使其余字段看起来是空的；平台必须保留占位并走 §2.5 的重新核对。
- 证据不写 `lingeringPids`。DSH 的 worker 是同进程内的 Agent Session，不产生独立 worker PID；判定只看本票自己的
  Session 状态、job 集合、subagent 集合和 launch。`harnessPid`/`cgroup`/`processesBefore`/`processesAfter` 只作证据，
  不把整棵 harness 进程树当判定边界（其他票、provider 和 launch 共享它）。
- 后台 job 或 subagent 仍在、worker 未 idle、或 `launch: timed-out` 时，Bridge operation 记 `failed`，平台进入 `blocked`，
  `stop_evidence` 写入 `problem`、`pauseOperationId`、`leaseId`、`fencingToken` 和 `nextStep`。

### 2.4 继续

`POST /bridge/v1/tickets/:id/resume` 要求 Ticket 已 `paused` 且已有 `stoppedAt`；runtime 复查模型、仓库、Policy 与
工作目录仍在，然后清除 `paused`，新建 Assignment。平台在调用 resume 前必须重新取得仓库执行租约
（`runtime_leases` 一条 `active` 行，带 fencing token），并把 `{leaseId, fencingToken}` 作为 admission 传给 Bridge。
没有租约或现场核验失败时平台置 `blocked`，不调用 resume。

工作目录规则：有 Assignment 真正启动过（有 `startedAt`）而目录已不在时，resume 返回 409 `worktreeMissing`；从未启动过
的票（prepare 被暂停中止）允许 resume 重新 prepare。resume 成功只清除一次暂停并只创建一个新 Assignment；同一个暂停不能
再次 resume，重复命令按 operation id 幂等返回第一次结果。

### 2.5 停止未确认：重新核对原暂停操作

`launch: timed-out` 或其他无法证明的停止不应把票永久锁死。平台在 `blocked` 占位上提供一次「重新核对停止」：
`POST /api/v1/tasks/:id/stop` 在任务为 `blocked` 且 `stop_evidence.nextStep === 'recheck-stop'` 时不再发起新的停止，
而是创建一次停止核对 operation（`task_operations.kind = 'pause'`）。dispatcher 取原暂停 operation 的 leaseId +
fencingToken，确认当前 `task_links.runtime_lease_id` 仍是同一代次且租约仍 `active`，然后把
`{operationId, pauseOperationId, admission}` 发给 Bridge 的 `POST /bridge/v1/tickets/:id/pause`。
runtime 需要声明 `capabilities.pauseRecheck = true`；未声明时 operation 直接失败，占位改记为 `nextStep: 'runtime-upgrade'`。

runtime 对同一 `paused.operationId` 再做一次有界停止检查（launch 是否结束、Session 是否 idle、job/subagent 是否为空），
成功时把 `stoppedAt` 和绑定证据写入 `ticket.paused`，失败时仍无 `stoppedAt`、只更新 `error`。核对证据至少额外包含：

```jsonc
{
  "ticketId": "…", "operationId": "原暂停操作", "recheckOperationId": "本次核对操作",
  "leaseId": "…", "fencingToken": "…", "recheck": true, "reconciledAt": "…",
  "launch": "none", "stopIncomplete": null
}
```

平台只有在五者全部一致时才把它当成停止证明：当前 ticket、原暂停操作、本次核对操作、租约 id、fencing token。
任何一项不符都不改写任务、不释放租约，`stop_evidence` 记 `bindingProblem` 和 `nextStep: 'owner-review'`。

- 核对成功：同一个数据库事务把任务置 `stopped`、写 `stopped_at` 和新证据，并在事务提交后按该代次释放执行租约；
  之后 resume 才被允许。
- 核对失败（launch 仍未结束、job/subagent 仍在等）：保持 `blocked`，更新 `problem` 和 `nextStep: 'recheck-stop'`，
  允许再次核对；租约与执行名额继续占用，绝不放行替代执行。
- 租约代次已变化或原暂停 operation 丢失：保持 `blocked`，记 `nextStep: 'owner-review'`，不把旧代次的证明套到新代次。

隔离验收栈可以用测试专用开关确定性复现 `timed-out`：给被测 runtime 设置 `MOYU_TEST_HOOKS=1` 和
`MOYU_TEST_PAUSE_LAUNCH_MS=1` 把停止上限缩短到 1 ms，然后立即暂停正在 launch 的任务。隔离栈通过 supervisor 的
实例环境文件传入这两个变量（`scripts/m5b/matrix/stack.sh` 的 `M5B_MATRIX_TEST_HOOKS`）；生产部署不设置它们，
上限仍是 10 s。脚本见 [`scripts/m5b/matrix/item4-pause-recheck.sh`](../scripts/m5b/matrix/item4-pause-recheck.sh)。

### 2.6 服务重启

- 已人工暂停（`paused` 有 `stoppedAt`）的 Ticket 保持暂停：runtime 的 `resume()` 不重启它，平台保持 `stopped`。
- 重启前 `running` 的 Ticket：runtime 按既有 `assignmentInterrupted` 处理；平台启动核对以 Bridge Ticket 快照为准。
- 平台无法从 Bridge 确认现场（不可达、Ticket 缺失、快照与本地状态矛盾）时置 `blocked`，记录原因，不猜测、不自动重发。

## 3. 执行中追加消息

平台消息继续走 M3 的 `messages` + `deliveries` 状态机。worker 使用 `steer` 在下一次可接收消息的步骤读取，不承诺中断
正在运行的工具或命令。暂停中的任务不投递新消息：消息保留为 `stored`，resume 后按时间顺序投递。

`delivered` 仍只由 Bridge `receive` 的 `stored|duplicate` 推进；`read` 仍只由 worker Session 的 `user/message` 落盘 +
`Ticket.inputs[].readAt` 的 `message.read` 回调推进。HTTP 202 不推进。

## 4. GitHub 汇入 Work

### 4.1 入口与去重

runtime 的 GitHub Source 继续按仓库级通知接收 @ 消息并创建 Ticket。Bridge 为 **GitHub 来源**的 Ticket 追加一次性
`ticket.imported` 事件（投影到 `<stateDir>/bridge/events.jsonl`）：

```jsonc
{
  "ticketId": "…", "source": "github", "externalId": "github:42", "number": 42, "isPr": true,
  "url": "https://github.com/owner/name/pull/42", "title": "…", "state": "running",
  "triggerId": "github-comment:…", "text": "…", "base": { "branch": "main", "commit": "…", "model": "provider/model" },
  "at": "…"
}
```

平台以 `(repository_id, source='github', external_id)` 唯一约束建立或复用一条 Work conversation，并以
`(repository_id, upstream_ticket_id)` 唯一约束绑定同一个 task。重复事件或平台重启重放不会新建第二条任务。
若平台已有同一 `upstream_ticket_id` 的 conversation（例如先由 Web 消息进入该 Ticket），则不新建，只补 source/externalId。

### 4.2 在网页继续

对已导入的 conversation 追加消息时，平台向 Bridge 发送 `POST /bridge/v1/triggers`，并带 `targetTicketId`。Bridge：

1. 读取该 Ticket，要求仍开放（`ended` 的 Ticket 只能在显式恢复语义下接消息，M4 平台不自动投递终态任务）；
2. 使用该 Ticket origin Trigger 的 GitHub thread 作为 Trigger thread，使 intake fan-out 到原 Ticket；
3. 使用 workspace Channel 作为本次 Trigger 的 channel，因此 acknowledgement 与 question 回到 Web 会话；
4. `executionSpec` 只接受该 Ticket 已冻结的 model/base；`mode` 使用 Ticket 当前 mode。

结果消息仍按 Ticket 原始终态语义回到来源 Channel。这样「按消息来源路由回复」：哪条消息提出问题，回答就回到哪里。

### 4.3 自身回声

GitHub Source 已用 `sameName` 过滤 agent 自己的评论；M4 **不修改**该上游行为。平台不把 Bridge 回调再发回 GitHub，
也不把 GitHub 通知改造成账号级轮询。Bridge 不向 GitHub 写评论。

## 5. PR 语义

| 事件 | 平台状态 | 自动执行 | 现场 | 重开 PR |
| --- | --- | --- | --- | --- |
| PR 待审阅，继续提修改 | `awaiting_review` → `running` | 继续在原 Ticket/PR | 保留 | 不新开 |
| PR 合并 | `completed` | 停止 | 保留（M6 清理） | — |
| PR 关闭未合并 | `closed_unmerged` | 停止自动投递；人工显式继续才恢复 | 保留 | 不自动重开 |

`closed_unmerged` 不表示成功。平台不得把它显示为完成，也不得在收到该事件后自动创建新任务或重开 PR。

## 6. Bridge 协议增量

以下端点沿用 M3 的 Bearer 认证、回环限制与 JSON 错误形状。

### 6.1 capabilities

```jsonc
{ "protocolVersion": "moyu-bridge/1",
  "capabilities": { "trigger": true, "events": true, "tickets": true, "models": true,
                    "pause": true, "resume": true, "retry": true, "readOnlyDiscussion": true, "start": true } }
```

`start` 为可选字段；缺省视为 `false`。平台只在对应能力为 `true` 时启用按钮。

### 6.2 Ticket 快照

`GET /bridge/v1/tickets/:id` 在 M3 字段上追加：

```jsonc
{
  "mode": "execute" | "discuss",
  "planRevision": 1,
  "paused": { "at": "…", "by": "human", "operationId": "…", "stoppedAt": "…", "evidence": { }, "error": null } | null,
  "execution": { "name": "…", "directory": "…", "assignment": "…" } | null
}
```

### 6.3 操作

| 端点 | 请求 | 响应 | 约束 |
| --- | --- | --- | --- |
| `POST /bridge/v1/tickets/:id/pause` | `{operationId, reason?}` | `202 {operationId, ticketId, kind:'pause', state:'queued'}` | 开放 Ticket；已暂停时返回现有 operation（幂等） |
| `POST /bridge/v1/tickets/:id/resume` | `{operationId, admission:{leaseId, fencingToken}}` | `202 …kind:'resume'…` | 必须 `paused` 且有 `stoppedAt`；`still_stopping` 409；admission 必填并记录 |
| `POST /bridge/v1/tickets/:id/start` | `{operationId, planRevision}` | `202 …kind:'start'…` | `mode:'discuss'`、开放、未暂停；`planRevision>=1` |
| `POST /bridge/v1/tickets/:id/retry` | `{operationId}` | `202 …kind:'retry'…` | 与上游既有 `canRetry` 一致 |
| `GET /bridge/v1/operations/:id` | — | `200 {operationId,ticketId,kind,state,error?,evidence?,updatedAt}` | `state ∈ queued|running|succeeded|failed` |

operation 必须持久化（append-only，位于 `<stateDir>/bridge/operations.jsonl`），进程重启后仍可查询。
`pause` 只在 `ticket.paused.stoppedAt` 落库后 `succeeded`；`start` 只在 `ticket.mode==='execute'` 且新 Assignment 已创建后
`succeeded`；`resume` 只在 `paused` 清除且新 Assignment 创建后 `succeeded`。失败写 `error`，不静默成功。

### 6.4 Trigger 请求增量

- `executionSpec.mode` 接受 `'discuss'`。
- 可选 `targetTicketId`：把消息挂到已有 Ticket（GitHub 导入会话继续交互）。存在时 Bridge 校验 Ticket、使用其 origin
  thread 与冻结的 model/base；`executionSpec` 中与 Ticket 冻结值冲突的字段返回 `409`。
- 对 `targetTicketId` 指向已结束 Ticket 的请求返回 `409 ticket_ended`；平台不自动投递终态任务。

### 6.5 事件增量

| type | data | 平台动作 |
| --- | --- | --- |
| `ticket.paused` | `{ticketId, operationId, at, stoppedAt?, evidence?}` | 写停止证据；`stopping → stopped` |
| `ticket.imported` | 见 §4.1 | 建立/复用 GitHub 来源 conversation 与 task |

`ticket.state_changed` 的 `state` 增加 `discussing`、`stopping`、`stopped` 的投影；M3 已定义的其余类型不变。

## 7. 必须验证的契约

- 讨论 Session 没有写工具、没有 shell/job/subagent 工具，permission preset 为 `read-only`；写入调用被拒绝且没有修改工作目录。
- 讨论转执行后同一个 Ticket、同一个工作目录、同一个 PR 继续工作；不新建会话或 Ticket。
- pause 后 shell jobs 与 subagents 实际结束，证据含 harness PID、Session idle、job 前后集合；只有 `stoppedAt` 后才显示 stopped。
- 暂停在 launch 阶段超时（`launch: timed-out`）时任务停在 `blocked`、保留 `blocked` 占位与下一步；核对原暂停操作成功才写
  `stoppedAt`，证据同时绑定 ticket、原 operation、核对 operation、leaseId 与 fencingToken；绑定不符不得结清。
- 核对成功在同一事务内把任务置 `stopped` 并释放该代次租约；之后 resume 只创建一个新 Assignment，重复 resume 被拒。
- 没有 Assignment 的暂停（`pending_admission` 或 GitHub 入口）也能结算：证据不含 `assignmentId`，以 `ticketId` +
  `paused.operationId` 认身份；不能因为没有 Assignment 就永远停在 `stopping`。
- resume 前必须取得 `runtime_leases` 租约；没有租约时不调用 Bridge，任务 `blocked`。
- 暂停期间平台消息保持 `stored`，resume 后按序投递；`read` 必须有执行器证据。
- 平台重启：暂停保持 `stopped`；`running` 以快照核对；不可确认 `blocked`。
- 同一 GitHub ticket 的重复 import / 双入口只产生一条 conversation 与一个 task。
- `ticket.ended outcome:'closed'` 映射 `closed_unmerged`，不显示成功、不自动重开、不自动新任务。
- 3082 bootstrap 实例及其 GitHub Source 设置不被修改或重启。

## 重复 runtime Ticket 的持久化暂停

`ticket.imported` 在同一事务里把重复 runtime Ticket 写入 `duplicate_tickets`（`(repository_id,ticket_id)` 唯一），状态 `pending`。dispatcher 的 `duplicatesOnce` 独立循环领取、调用 Bridge pause、轮询 operation，成功置 `paused`，失败置 `failed` 并按指数退避重试；进程退出时 `pausing` 行在 90 秒后回收，重启继续。平台 task 是唯一执行记录，第二个 runtime Ticket 不产生仓库副作用。
