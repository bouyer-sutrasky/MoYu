# M3 Workspace Source 与私有机器 Bridge 协议

日期：2026-11-03。范围：`docs/DEVELOPMENT-GUIDE.md` 第 3 阶段与 Issue #9。

本文是 MoYu 平台与受控 superagent fork 之间的机器协议，**不是**上游公共 SDK。上游固定 commit 见
[`integrations/superagent/upstream.lock.json`](../integrations/superagent/upstream.lock.json)；具体字段类型以固定版本源码为准。

## 1. 边界与认证

- Bridge 只监听回环地址，默认 `127.0.0.1:3190`，由 `MOYU_BRIDGE_HOST` / `MOYU_BRIDGE_PORT` 覆盖；不对公网开放。
- 平台 → Bridge：`Authorization: Bearer <MOYU_BRIDGE_TOKEN>`。缺失或不匹配返回 `401`，不透露配置。
- Bridge → 平台：`Authorization: Bearer <MOYU_PLATFORM_TOKEN>`，调用 `POST /api/internal/v1/runtime-events`。
- 浏览器登录 Cookie 永不进入 Bridge；机器令牌只存在于两侧进程环境（隔离 profile 的 env），不写入前端、GitHub、Issue、日志或数据库。
- 平台仓库绑定：`BRIDGE_REPOSITORY`（`owner/name`）、`BRIDGE_URL`（如 `http://127.0.0.1:3190`）、`BRIDGE_TOKEN`（平台→Bridge）、
  `BRIDGE_CALLBACK_TOKEN`（Bridge→平台，与实例的 `MOYU_PLATFORM_TOKEN` 相同）。
- 实例 env：`MOYU_PLATFORM_URL`（平台 origin，如 `http://127.0.0.1:4300`）、`MOYU_PLATFORM_TOKEN`、
  `MOYU_BRIDGE_TOKEN`、`MOYU_BRIDGE_HOST`、`MOYU_BRIDGE_PORT`。Source 的持久配置只放非秘密字段。

## 2. 触发投递（平台 → Bridge）

### `POST /bridge/v1/triggers`

请求体（JSON，≤ 256 KiB）：

```jsonc
{
  "triggerId": "workspace:<platformMessageUuid>",   // 稳定幂等键；重发必须完全一致
  "conversationId": "<uuid>",
  "messageId": "<uuid>",
  "replyToMessageId": "<uuid>|null",
  "actor": { "id": "<owner uuid>", "name": "MoYu Owner" },
  "text": "用户消息正文",
  "at": "2026-11-03T12:00:00.000Z",
  "executionSpec": {
    "repository": "owner/name",
    "baseBranch": "main",
    "baseCommit": "<sha>|null",     // 平台已冻结的起点；null 时 Bridge 解析并锁定
    "model": { "provider": "commandcode", "model": "deepseek/deepseek-v4.1-flash", "reasoningEffort": "high" },
    "mode": "execute"               // discuss 在 M3 拒绝
  }
}
```

响应 `200`：

```jsonc
{ "result": "stored" | "duplicate" | "filtered", "triggerId": "workspace:<uuid>", "baseCommit": "<sha>", "ticketId": "<id>|null" }
```

- `stored`：Trigger 已在上游 SQLite 入库（平台可据此把消息推进到 `delivered`，表示执行器已接收）。
- `duplicate`：同一 `triggerId` 已存在；不重复入库、不重复建单，返回已有 ticket（若已产生）。
- `filtered`：Source scope 拒绝；平台标记该次投递失败并保留错误（不作为已送达）。
- `baseCommit`：Bridge 校验/解析出的起点 commit；平台写入 conversation/task。
- 错误：`400/422` 请求无效或不可受理（不重试）；`401` 令牌错误；`409` 冻结参数与实例/仓库不一致；`503` 运行时装未就绪（可重试）。
- `executionSpec.model` 必须来自 `GET /bridge/v1/models`；不可用模型 `422`，**不回退**到实例默认。
  `executionSpec.model: null` 表示“实例默认”：Bridge 在 accept 时把当时的 `settings.executor.model` 冻结进 Ticket
  （`modelSource:'executor'`）；若实例也没有可表示的 Executor 模型，则记录 `model:null, modelSource:'instance'`，
  后续配置变化不会改变已开始任务。
- 同一 `triggerId` 重发只入库一次（上游 `Store` 主键 + `Engine.receive` 返回 `duplicate`）；Bridge 不做应用层“先查再写”的唯一防线。
  重复请求在模型/分支校验之前读取已持久化的第一份 Trigger，返回首次冻结的 `baseCommit` 与 Ticket；分支前进或原模型被移除都不会改变结果或返回 422。

### `GET /bridge/v1/capabilities`

```jsonc
{
  "protocolVersion": "moyu-bridge/1",
  "upstream": { "package": "dsh-superagent", "version": "0.1.0", "commit": "6337fc8…" },
  "capabilities": { "trigger": true, "events": true, "tickets": true, "models": true,
                   "pause": false, "resume": false, "retry": false, "readOnlyDiscussion": false },
  "source": { "kind": "workspace", "enabled": true }
}
```

缺能力的操作平台不展示可用按钮。

### `GET /bridge/v1/models`

```jsonc
{ "models": [ { "provider": "commandcode", "model": "deepseek/deepseek-v4.1-flash",
                "displayName": "DeepSeek V4.1 Flash", "reasoningEfforts": ["low","high"] } ] }
```

来源为 `ctx.sessionController.modelCatalog()` 的白名单字段；不返回 API Key 或供应商密钥。

## 3. 事件拉取（平台 ← Bridge）

### `GET /bridge/v1/events?after=<decimal>&limit=<1..200>`

```jsonc
{
  "events": [
    { "seq": 42, "id": "evt-42", "type": "ticket.linked", "at": "…", "data": { } }
  ],
  "next": 42,
  "hasMore": false
}
```

- `seq` 单调递增、十进制字符串/数字；平台按 `source='bridge' + sourceEventId` 在数据库唯一去重。
- 事件先持久化到实例 stateDir 下的 append-only 日志，再可被拉取；API/Bridge 任一方重启都不丢已发出的业务事件。
- 平台每 1 秒（或收到 Bridge 回调后立即）拉取并推进持久 cursor；处理事件与推进 cursor 在同一事务提交。
- 支持的事件类型：

| type | data | 平台动作 |
| --- | --- | --- |
| `ticket.linked` | `{triggerId, ticketId, conversationId, messageId, state, title, base:{branch,commit,model}}` | 填 task_link.upstreamTicketId，state=`queued/pending…`，发 `task.linked` |
| `ticket.state_changed` | `{ticketId, previousState, state, question?, at}` | 更新 task_link.state，发 `task.state_changed` |
| `ticket.question` | `{ticketId, question, attentionId}` | 更新 task_link.question，发 `task.question` |
| `message.delivered` | `{triggerId, messageId, stage:"trigger_stored"|"worker_inbox", at}` | 记录 delivery 更强证据（可选） |
| `message.read` | `{triggerId, messageId, at}` | 设 delivery.readAt，发 `message.delivery_changed` |
| `task.progress` | `{ticketId, text, at, sessionId}` | 持久化并转发 `task.progress` |
| `artifact.created` | `{ticketId, type:"pull_request", url, number, title?, at}` | 写 artifacts 行，发 `artifact.created` |
| `ticket.ended` | `{ticketId, by, outcome, reason?}` | 映射 closed_unmerged/completed/failed，发 `task.state_changed` |

状态投影（上游 Ticket → 平台 task_state）：`attention` → `waiting_input`；正在运行 → `running`；最新 Assignment 待启动 → `queued`；
`blocked`/`failed` 且等待人工 → `blocked`/`failed`；`ready` → `awaiting_review`；`ended`：`merged|completed` → `completed`，
`closed` → `closed_unmerged`，`stopped` → `stopped`，`dropped` → `completed`。

### `GET /bridge/v1/tickets/:id`

权威快照：`{ ticketId, title, state, question, attentionId, model, base, assignmentId, report, pr?, ended }`。
面板/平台不以本地投影反向修改上游 SQLite。

`POST /bridge/v1/tickets/:id/{pause,resume,retry}` 在本阶段返回 `501 unsupported`；`capabilities` 同步为 `false`。
人工停止/继续属于阶段 4，不能用上游终态 stop 冒充。

## 4. Channel 回调（Bridge → 平台）

### `POST /api/internal/v1/runtime-events`

```jsonc
{
  "sourceEventId": "ack:<triggerId>",              // 稳定幂等键（上游 OutboundMessage.id）
  "type": "channel.message",
  "conversationId": "<uuid>",
  "ticketId": "<upstream ticket>",
  "triggerId": "workspace:<uuid>|null",
  "messageKind": "acknowledgement" | "question" | "reply" | "result" | "notice",
  "text": "回复正文",
  "at": "…"
}
```

- Bridge 的 workspace Channel `send` 只有在平台 **提交成功** 后才向上游返回 `sent`；网络错误/5xx 抛出，交给上游 Outbox 重试。
  重复回调返回原成功（`{ data: { messageId, duplicate: true } }`），不重复写消息。
- 上游补丁按 `0001`–`0004` 有序应用；`0004` 只修正重复 Trigger 的首次结果语义。
- 上游 OutboundMessage id 在 M3 补丁中固定为 `ack:<triggerId>`、`attention-reply:<attentionId>` 或 `reply:<...>`；
  Channel 用该前缀区分问题与回执，并把同一 id 作为 `sourceEventId`。
- 平台在数据库以 `(conversation_id, source_event_id)` 唯一索引兜底；重复回调不产生第二条消息。
- 平台把 `channel.message` 写为 outbound message；`question` 同时更新 `task_link.question` 并写 `task.question` 事件。
- 平台不可达时 Bridge 不确认；上游 receipt 保持 `pending` 并重试。平台重启后同一 `sourceEventId` 重复投递被数据库去重。

## 5. 消息状态与证据

| 状态 | 含义 | 证据 |
| --- | --- | --- |
| `stored` | 平台收件，消息与 delivery 同事务写入 | 平台数据库行 |
| `delivering` | dispatcher 已领取投递租约 | `deliveries.state='delivering'` + lease |
| `delivered` | 执行器已接收 Trigger 入库 | Bridge `POST /triggers` 返回 `stored`/`duplicate` |
| `read` | worker Session 已把消息写入历史（模型可读） | 上游 `session/event` `user/message` + `Ticket.inputs[].readAt`，经 `message.read` 回报 |
| `failed` | 平台侧永久拒绝（4xx） | `deliveries.lastError`，保留人工重试入口 |

`read` 绝不因为 HTTP 202、Bridge 200 或 Trigger stored 而提前推进。

## 6. 幂等、重试与重启

- 平台消息：`(conversation_id, client_message_id)` 部分唯一索引；并发重复提交只有一个事务成功，其余读取既有结果。
- 平台投递：`deliveries` 每个消息一行；dispatcher 用 `FOR UPDATE SKIP LOCKED` 领取并写租约；崩溃后过期租约被回收。
- Bridge 接收：Trigger 主键幂等；重复投递返回 `duplicate`，不重复建单。
- Bridge 事件：append-only 日志 + 单调 seq；平台 cursor 与事件处理同事务；重复事件被唯一索引吞掉。
- Channel 回调：平台 `(conversation_id, source_event_id)` 唯一；Bridge 只在提交成功后确认。
- 两者重启：平台恢复未完成投递；Bridge 重启后继续追加事件日志，平台按 cursor 补齐。

## 7. 冻结字段

会话创建时冻结：`repositoryId`（平台仓库行）、`baseBranch`、`executionMode`、`modelId`；首次投递时 Bridge 解析/确认
`baseCommit` 并返回，平台写入 `conversations.base_commit` 与 `task_links.base_commit`。上游 Ticket 记录
`base {repository,branch,commit}`、`model {provider,model,reasoningEffort?}`、`mode`；worker Session 使用该模型，不可用则拒绝启动，
不回退到实例默认；后续修改实例配置不改变已开始任务。

## 8. M3 实现备注

- 平台状态投影与 Bridge 事件类型以本文 §3 为准；`ticket.state_changed` 的 `question` 只在该 tick 存在 attention 时携带。
- 首个 Channel 回调可能早于 dispatcher 投影 `ticket.linked`：平台接受回调并以回调中的 `ticketId` 补关联，后续
  `ticket.linked` 事件按 seq 单调更新，不重复建 Task。
- `message.delivery_changed` 的 `delivered` 只由 Bridge `receive` 的 `stored|duplicate` 触发；`read` 只由
  `Ticket.inputs[].readAt` 经 `message.read` 回报；HTTP 202/200 不推进。
- Bridge 事件日志为 append-only、fsync、单调 seq；平台 cursor 与事件投影在同一事务提交，投影失败回滚整页并重试。
