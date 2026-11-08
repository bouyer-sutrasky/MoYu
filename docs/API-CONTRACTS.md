# 新平台 API 与上游适配契约

本文定义目标契约。M2 已实现 Passkey、auth state/me/logout/sessions/credentials、仓库只读列表、受保护 SSE 与附件下载；M3/M4 已实现消息闭环、事件流与执行控制；M4-UX 补齐历史分页、每仓库任务偏好与运行时分支列表。共享 Zod schema 位于 `packages/contracts`，实现时无需另建一套类型。

## 统一约定

浏览器通过同源 HttpOnly Cookie；机器 Bridge 用独立实例凭据（mTLS或受限内网bearer）认证，不能把浏览器登录session传给Harness。机器密钥不存前端或仓库。业务ID由服务端生成，仓库与actor从服务端绑定读取。写入先提交事务再回202，202只表示接受，不表示worker已读。

成功响应 `{ data, requestId }`；失败 `{ error: { code, message, retryable }, requestId }`。401未登录、403无权限、404资源不存在、409状态/幂等键冲突、422参数不合法、429限流、503依赖暂不可用。重用同一幂等键及相同payload返回原结果，不同payload返回409。

时间用UTC ISO字符串；事件seq采用十进制字符串，避免JS整数精度问题。每个事件拥有稳定id与来源去重键。日志屏蔽凭据、绑定码和完整附件。

## Passkey

| 接口 | 请求 | 响应/约束 |
| --- | --- | --- |
| GET /api/v1/auth/state | 无 | 公开初始化状态：`initialized`、可用凭据数、`setupOpen`、`recoveryOpen`、RP ID/origin；不含凭据标识 |
| POST /api/v1/auth/bootstrap/exchange | `{code}` | 原子消费短期码，发仅限注册的短期Cookie；不是完整登录 |
| POST /api/v1/auth/registration/options | `{label?}` | `{ceremonyId,optionsJSON}`；需要有效bootstrap或被允许的凭据管理会话 |
| POST /api/v1/auth/registration/verify | `{ceremonyId,response}` | 校验用户验证结果及challenge，原子登记凭据并完成首个owner初始化；bootstrap路径同时建立登录会话 |
| POST /api/v1/auth/login/options | `{}` | `{ceremonyId,optionsJSON}`，限流，不泄露凭据秘密 |
| POST /api/v1/auth/login/verify | `{ceremonyId,response}` | 创建随机会话，Set-Cookie；原子消费challenge |
| GET /api/v1/auth/me | 无 | 所有者、当前会话摘要与可用凭据摘要 |
| POST /api/v1/auth/logout | 无 | 撤销当前session并清Cookie |
| GET /api/v1/auth/sessions | 无 | 会话列表，不返回原始令牌 |
| DELETE /api/v1/auth/sessions/:id | 无 | 撤销并主动关闭关联SSE |
| GET /api/v1/auth/credentials | 无 | 当前可用 Passkey 摘要 |
| GET/DELETE /api/v1/auth/credentials/:id | 无 | 查询/撤销Passkey，防止无恢复路径误删最后凭据；撤销时同时撤销绑定会话 |

SimpleWebAuthn server使用 `generateRegistrationOptions`、`verifyRegistrationResponse`、`generateAuthenticationOptions`、`verifyAuthenticationResponse`；browser使用 `startRegistration({optionsJSON})` / `startAuthentication({optionsJSON})`。保存credential ID/publicKey/counter/transports，校验参数包含expectedChallenge、expectedOrigin、expectedRPID；认证传数据库取出的credential。具体TS形态以锁定版本为准。

M2 实际 Cookie：https origin 使用 `__Host-moyu_session` 与 `__Host-moyu_bootstrap`，非 https 的显式开发覆盖使用 `moyu_session` / `moyu_bootstrap`；均 Secure（开发覆盖除外）、HttpOnly、Path=/、无 Domain、SameSite=Lax。服务端只保存随机令牌的 SHA-256 摘要。会话无固定短周期强制过期，`sessions.expires_at` 随活动滚动延长；支持撤销，撤销会立即关闭该会话的 SSE。实际浏览器可能清理Cookie；不能承诺永不重登。新增Passkey必然有一次登记动作，但不因定时器强制普通使用重验。

## M2 实现边界

- 绑定码只由服务器 CLI 生成；网页进程没有生成绑定码的接口。绑定码与注册 token 都只存摘要，完成登记后 `bootstrap_codes.completed_at` 关闭该次绑定。
- `auth_challenges.context` 在服务端绑定本次 ceremony 到 bootstrap 行或登录会话，不返回给浏览器；challenge 在验证前原子消费，失败或重放都不会得到第二次成功。
- WebAuthn 校验固定使用 `expectedChallenge`、`expectedOrigin`、`expectedRPID` 与 `requireUserVerification: true`。
- 初始化入口在首个凭据登记后由 `/auth/state` 返回关闭；只有服务器 CLI 在无可用凭据时能生成恢复码。
- 仓库、任务、消息、附件上传与 Bridge 仍按后续阶段实现；界面中对应按钮禁用并标注阶段。

## 仓库、任务与消息

| 接口 | 主要字段与语义 |
| --- | --- |
| GET /api/v1/github/repositories | 专用账号当前可访问仓库，分页；没有全量可见性时支持输入owner/name检查 |
| POST /api/v1/repositories | `{fullName}` → repositoryId；校验repo存在与所需读写权限，异步准备配置 |
| GET /api/v1/repositories | **M2 已实现只读列表**；M5 每项增加 `runtime`（生命周期、原因、等待对象、监听、执行名额、动作）；M3 兼容行仍可按 `BRIDGE_REPOSITORY` 绑定（不存秘密） |
| GET /api/v1/github/repositories | **M5-A 已实现**：专用 GitHub 账号查询可见仓库（`q`/`limit`），返回默认分支、私有标记与 push/admin 权限 |
| POST /api/v1/repositories | **M5-A 已实现**：`{fullName}`；真实权限校验、重复 409、创建后由 supervisor prepare/wake；不可访问 403 |
| GET /api/v1/repositories/:id/runtime | **M5-A 已实现**：单仓库生命周期投影与允许动作 |
| POST /api/v1/repositories/:id/wake | **M5-A 已实现**：只提交 repositoryId；忙时返回排队状态，不承诺立即在线 |
| POST /api/v1/repositories/:id/sleep | **M5-A 已实现**：有活动任务/命令或保留后台服务时返回 200 + `accepted:false` 与原因；停止未证明全部进程退出时保持 `stopping/stop_failed` 并返回 `accepted:false`，动作 `retry_stop` 可重试；不伪报停止 |
| GET /api/v1/repositories/:id/models | **M3 已实现**：经仓库 Bridge 读取 Harness 已配置模型白名单（provider/model/displayName/reasoningEfforts），不返回 API Key；运行时不可达返回 503 |
| GET /api/v1/repositories/:id/branches | **M4-UX 已实现**：经 Bridge `GET /bridge/v1/branches` 读取分支；运行时不支持该能力时返回 `status:'unsupported'` 与空列表，不以错误冒充 |
| GET/PUT/DELETE /api/v1/repositories/:id/preferences | **M4-UX 已实现**：每仓库默认执行方式、分支、模型与推理强度；GET 返回 saved 与 effective（仓库默认兜底），PUT 经模型目录/分支列表校验，失效值 422、运行时不可达 503，不落库；偏好只影响新任务，旧任务冻结值不变 |
| POST /api/v1/repositories/:id/wake | 返回调度operationId，忙时queued，不承诺立即在线 |
| GET /api/v1/repositories/:id/branches | 分页分支列表 |
| GET /api/v1/repositories/:id/models | Harness已配置且可用的模型标识，不返回API Key |
| POST /api/v1/conversations | **M4 已实现**：`{repositoryId,mode:'work',executionMode:'execute'\|'discuss',baseBranch,model:{provider,model,reasoningEffort?}\|null,clientRequestId}`；同一 `clientRequestId` 相同 payload 返回原会话，不同 payload 409；`discuss` 创建只读讨论任务 |
| GET /api/v1/conversations | **M3 已实现**：按仓库列出会话与任务投影；M4-UX 增加 `cursor` 分页与 `nextCursor`/`hasMore`，游标绑定仓库，跨仓库复用返回 422 |
| GET /api/v1/conversations/:id | **M3 已实现**：会话、冻结字段与任务投影 |
| POST /api/v1/conversations/:id/messages | **M3 已实现**：`{clientMessageId,text,replyToMessageId?}` → 202 `{message,duplicate:false}`；相同幂等键与 payload 返回 200 原结果，不同 payload 409；message 与 delivery 同事务写入 |
| GET /api/v1/conversations/:id/messages | **M3 已实现**：游标分页，包含方向/kind、回复关联、来源与投递状态；M4-UX 使用 `(createdAt,id)` 不透明游标，支持 `before`（更早）与 `after`（更新），返回 `nextCursor`、`newerCursor`、`hasMore`、`hasNewer`；同时间戳由 id 决胜，游标不匹配返回 422 |
| GET /api/v1/conversations/:id/messages/:messageId | **M4-UX 返修**：返回 `{message}`，含当前投递/read 投影；消息不属于该会话或不存在返回 404；供 SSE `message.delivery_changed` 就地刷新已加载行 |
| POST /api/v1/tasks/:id/start | **M4 已实现**：`{planRevision,expectedVersion,clientCommandId}`；同一会话/工作目录/PR 只读讨论→执行；记录 `planRevision` 与已冻结 `baseCommit`；202 返回 operation |
| POST /api/v1/tasks/:id/stop | **M4 已实现**：`{expectedVersion,clientCommandId}`；幂等进入 `stopping`，经 Bridge `pause`，有停止证据后才变 `stopped`；不是上游终态 stop |
| POST /api/v1/tasks/:id/resume | **M4 已实现**：`{expectedVersion,clientCommandId}`；只允许 `stopped`，dispatcher 重新取得仓库租约并核验现场后调用 Bridge `resume` |
| POST /api/v1/tasks/:id/retry | **M4 已实现**：失败/受阻重试，经 Bridge `retry`，与人工停止的 resume 分开 |
| GET /api/v1/tasks/:id/artifacts | **M3 已实现 PR 引用**：Bridge 投影的 `pull_request` 产物 |
| GET /api/v1/tasks/:id/review | **M6-A 已实现**：读取已持久化的 `diff` / `check_report` 产物，返回变更（文件、增删行、逐文件 patch）、检查运行（命令、exit code、时间戳、输出末尾）、提交（完整 SHA、分支、提交说明）与 PR 号 + 状态；未采集时返回 `state:'unavailable'` 与原因，不用推断值 |
| POST /api/v1/tasks/:id/review/changes | **M6-A 已实现**：经宿主 supervisor 读取任务 worktree 的真实 `git status` / `git diff`（含未跟踪文件）与 HEAD，一并查询 GitHub PR 状态，写入 `diff` 产物后返回同一投影；worktree 已清理返回 `state:'cleaned'` |
| POST /api/v1/tasks/:id/review/checks | **M6-A 已实现**：经宿主 supervisor 在任务 worktree 运行配置的检查命令（默认 `pnpm check`），记录每个命令的 exit code、起止时间、耗时与输出末尾，写入 `check_report` 产物 |
| 宿主 supervisor review | **M6-A 已实现**：`POST /control/v1/instances/:repositoryId/review/{worktree,changes,checks}`，请求只带 `ticketId`；目录由 supervisor 自己的 `WORKTREE_ROOT`/profile 解析，命令来自 supervisor 配置，浏览器与 API 都不传路径或命令 |
| GitHub 汇入 | **M4 已实现**：Bridge `ticket.imported` 事件按 `(repository, source='github', external_id)` 建立/复用 Work conversation，并按 `(repository, upstream_ticket_id)` 绑定唯一 task；重复事件不重复建单 |
| POST /api/v1/conversations/:id/attachments | **M6-A 已实现**：multipart 单文件字段 `file`；单文件 ≤10 MiB，只接受图片（PNG/JPEG/WebP/GIF）与文本类（txt/log/md/json/yaml/csv/源码等）；超限 413、类型不符 422、空文件 422、未登录 401、他人会话 404，且拒绝时不落库也不落盘；返回 `{attachment}`，含 `id`、文件名、MIME、字节数、sha256 与下载地址，不自动执行 |
| GET /api/v1/attachments/:id | **M2 已实现、M6-A 收紧**：鉴权下载；`Content-Disposition: attachment`、`nosniff`、`CSP sandbox`，HTML/SVG 以 `application/octet-stream` 下发，不内联执行 |
| POST /api/v1/conversations/:id/messages `attachmentIds` | **M6-A 已实现**：引用本会话尚未发送的附件，最多 20 个、总量 ≤25 MiB；跨会话或已发送的 id 返回 422 且整条消息不落库；消息与附件在同一事务内绑定，消息列表与详情返回 `attachments` |
| 附件与执行器 | **M6-A 明确未传**：上游 Source 的 Trigger 没有附件字段，平台不把附件内容塞进消息正文，也不伪造已投递；附件保存在平台存储并随消息展示，投递到 runtime 属于后续单（需要上游 Bridge 补丁与能力协商） |

建会话返回pending直到任务接单；task_links在接单后填upstreamTicketId，不能把Trigger stored视为Ticket已创建。conversation创建时锁仓库/分支选择，正式执行前解析并记录baseCommit；为避免讨论期间分支移动，执行同一已记录快照或显式要求刷新计划，禁止悄悄换起点。

## 事件协议

共享 `GET /api/v1/events` 为当前所有者传事件，支持Last-Event-ID和首次after游标。避免每个任务同时打开独立连接。SSE心跳不写业务事件；重连先补发持久记录，再接实时流，无缝处理二者交界。

```ts
type WorkspaceEvent = {
  id: string;
  seq: string;
  type: 'message.created' | 'message.delivery_changed'
    | 'task.linked' | 'task.state_changed' | 'task.progress'
    | 'task.question' | 'artifact.created' | 'runtime.state_changed';
  repositoryId?: string;
  conversationId?: string;
  taskId?: string;
  occurredAt: string;
  data: unknown; // 实现中用discriminatedUnion替代unknown
};
```

任务展示状态：pending_admission / discussing / queued / running / waiting_input / awaiting_review / stopping / stopped / blocked / failed / completed / closed_unmerged / not_accepted。消息状态：stored / delivering / delivered / read / failed；delivered和read均要求实际执行器证据，缺证据停留在前态。

M4-UX 不新增事件类型；历史分页与草稿都在既有消息/投递投影上工作。M4 新增的枚举与投影保持在上述集合内：讨论态 `discussing`；人工暂停 `stopping`（意图已记录）→ `stopped`（运行时已给出停止证据）；暂停期间新消息保留 `stored`，resume 后投递。conversation 增加 `source`（`web|github`）、`externalKey`、`externalUrl`、`planRevision`；task 增加 `planRevision`、`stopRequestedAt`、`stoppedAt`、`stopEvidence`、`lastOperation`。完整语义见 [`M4-EXECUTION-CONTROL.md`](M4-EXECUTION-CONTROL.md)。

M3 实际映射：`stored`=平台消息与 delivery 同事务写入；`delivering`=dispatcher 已领取租约；`delivered`=Bridge `POST /bridge/v1/triggers` 返回 `stored|duplicate`（执行器已接收 Trigger）；`read`=worker Session 的 `user/message` 已落盘且 `Ticket.inputs[].readAt` 经 `message.read` 回报；`failed`=平台侧永久拒绝。HTTP 202 与 Trigger 入库都不会推进到 `read`。

`GET /api/v1/events` 在 M3 已实现：先按 `Last-Event-ID`/`after` 回放持久事件，再以 PostgreSQL 轮询（1 秒）补齐跨进程事件，进程内 bus 只用于即时唤醒；每 15 秒心跳。断线重连按 event id 补齐，不依赖进程内 EventEmitter 作为唯一存储。SSE 失效时重新校验登录；服务端主动撤销会立即中断流，不只依赖首次连接检查。M2 尚无任务事件生产者，主要验证连接、回放边界与撤销关闭；浏览器通知消费同一事件，按eventId去重，正文展示默认适度摘要，点击定位任务（M3/M6）。

## Bridge 机器协议

Bridge位于受控superagent fork中，只对回环/私网开放，并校验机器身份与仓库绑定。API服务不代理任意上游URL。

| 接口 | 语义 |
| --- | --- |
| GET /bridge/v1/capabilities | protocolVersion、upstream制品标识、支持的pause/model/readOnly/event能力；缺能力禁止显示可用按钮 |
| POST /bridge/v1/triggers | `{id,conversationId,messageId,actorId,text,replyToId?,attachments?,executionSpec}`；可信平台构造actor/addressed，实例核对repo |
| GET /bridge/v1/events?after= | 可补发的适配事件，持久cursor；不能依赖进程内EventEmitter作为唯一存储 |
| GET /bridge/v1/tickets/:id | 权威状态快照、assignment/session引用、版本和可操作集合 |
| POST /bridge/v1/tickets/:id/pause | 持久暂停意图，取消并等待后台活动；返回operationId |
| POST /bridge/v1/tickets/:id/resume | 原Ticket可恢复状态，重新门控并新Assignment或已验证的续执行路径 |
| POST /bridge/v1/tickets/:id/retry | 调用已验证的上游失败重试逻辑 |
| GET /bridge/v1/operations/:id | queued/running/succeeded/failed及完成证据 |
| GET /bridge/v1/models | 可配置模型，避免泄露供应商密钥 |
| POST /api/internal/v1/runtime-events | **M3 已实现**：Bridge 向平台推送 Channel 回复/问题；独立机器 Bearer 认证，`(conversation_id, source_event_id)` 唯一索引去重，重复回调返回原成功 |

executionSpec只接受平台已授权和冻结的modelId/baseCommit/mode。人工暂停期间自动来源事件可记录但不唤醒；显式resume重新校验授权。旧上游stop不作为可恢复暂停的别名。

平台内消息+delivery同事务写；Bridge receive去重；回调平台提交成功才返回sent。网络超时抛出以便上游Outbox重试，重复回调返回原成功。ticket映射尚未产生时保留pending，不循环创建新Trigger。

M3 实现细节见 [`M3-BRIDGE-PROTOCOL.md`](M3-BRIDGE-PROTOCOL.md)：trigger id 为 `workspace:<平台消息 id>`；平台 dispatcher 用 `FOR UPDATE SKIP LOCKED` 领取并重试；Bridge 事件日志 append-only、fsync、单调 seq；平台 cursor 与事件投影同事务提交。

M4 机器协议增量见 [`M4-EXECUTION-CONTROL.md`](M4-EXECUTION-CONTROL.md)：`tickets/:id/{pause,resume,start,retry}`、`GET /operations/:id`、`ticket.paused` / `ticket.imported` 事件、`targetTicketId` 续接和讨论只读执行约束。

## 上游真实接入点与差异

本地快照 `src/sources/kind.ts` 定义SourceKind、SourceChannel；`sourceContext(ctx.orchestrator,kind)` 获取上下文，等待ready/configured后 `receive(trigger)` 返回stored/duplicate/filtered。`ctx.orchestrator.sources.register(kind)` 返回卸载函数。SourceChannel.send接收host与OutboundMessage，返回sent/gone，临时错误抛出。

上游 package exports不公开完整Source宿主类型，因此在固定源码树增加 `src/sources/workspace.ts` 与构建入口、package exports、cordis patch；将源码相对import与Fork一起构建。具体Trigger/ChannelRef字段逐项照固定版本类型生成，禁止照本文自行猜shape。

原面板 `GET /orchestrator/api/tickets`、`GET /orchestrator/api/tickets/:id`、`POST /orchestrator/api/tickets/:id/stop`、`POST /orchestrator/api/tickets/:id/retry` 有loopback+same-origin限制；不要通过伪造Origin绕过来当新机器协议。原stop结束Ticket，retry只允许开放受阻Ticket；暂停继续需持久化补丁和恢复测试。

执行准入覆盖launch、deliver唤醒、恢复及人工额外slot；租约含fencing token，过期不能仅凭时间启动第二个worker，先证明旧执行已停止。宿主supervisor执行端检查租约，避免平台失联后双执行。上游事件agent/inbox/claimed、session/event只能在已证明写历史后标read。

## 必须完成的契约测试

相同key不同payload返回409；challenge双消费只有一个成功；发送后断网重投仅一个Trigger；Channel已落库但回执丢失重试不重复消息；SSE补发不漏交界事件；暂停重启不唤醒；租约失联不双执行；两个实例共享GitHub账号互不吞消息；不可用模型拒绝且不回退到未知模型；readonly无写凭据与写工具；切仓库不改变现有任务。
