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

至少包含：

```jsonc
{
  "ticketId": "…", "assignmentId": "…", "sessionId": "worker-…",
  "harnessPid": 12345, "cgroup": "0::/system.slice/dsh-superagent.service",
  "startedAt": "…", "stoppedAt": "…",
  "agentStatus": "idle",
  "jobsBefore": [{ "id": "bash-…", "name": "npm test" }],
  "jobsAfter": [],
  "subagentsAfter": 0,
  "cancelledTurn": true
}
```

DSH 的 worker 是同进程内的 Agent Session，不产生独立 worker PID；证据用 harness PID + cgroup + Session 状态 +
后台 job 集合前后对比表示。不得把「不再投递消息」当成进程已结束。

### 2.4 继续

`POST /bridge/v1/tickets/:id/resume` 要求 Ticket 已 `paused` 且已有 `stoppedAt`；runtime 复查模型、仓库、Policy 与
工作目录仍在，然后清除 `paused`，新建 Assignment。平台在调用 resume 前必须重新取得仓库执行租约
（`runtime_leases` 一条 `active` 行，带 fencing token），并把 `{leaseId, fencingToken}` 作为 admission 传给 Bridge。
没有租约或现场核验失败时平台置 `blocked`，不调用 resume。

### 2.5 服务重启

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
- resume 前必须取得 `runtime_leases` 租约；没有租约时不调用 Bridge，任务 `blocked`。
- 暂停期间平台消息保持 `stored`，resume 后按序投递；`read` 必须有执行器证据。
- 平台重启：暂停保持 `stopped`；`running` 以快照核对；不可确认 `blocked`。
- 同一 GitHub ticket 的重复 import / 双入口只产生一条 conversation 与一个 task。
- `ticket.ended outcome:'closed'` 映射 `closed_unmerged`，不显示成功、不自动重开、不自动新任务。
- 3082 bootstrap 实例及其 GitHub Source 设置不被修改或重启。
