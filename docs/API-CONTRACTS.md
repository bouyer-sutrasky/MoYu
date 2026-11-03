# 新平台 API 与上游适配契约

本文定义目标契约。M2 已实现 Passkey、auth state/me/logout/sessions/credentials、仓库只读列表、受保护 SSE 与附件下载；其余 `/api/v1` 与全部 `/bridge/v1` 路由仍为拟实现。共享 Zod schema 位于 `packages/contracts`，实现时无需另建一套类型。

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
| GET /api/v1/repositories | **M2 已实现只读列表**：状态、默认分支、实例状态；添加/唤醒/分支/模型仍为后续阶段 |
| POST /api/v1/repositories/:id/wake | 返回调度operationId，忙时queued，不承诺立即在线 |
| GET /api/v1/repositories/:id/branches | 分页分支列表 |
| GET /api/v1/repositories/:id/models | Harness已配置且可用的模型标识，不返回API Key |
| POST /api/v1/conversations | `{repositoryId,mode:'work',executionMode:'execute'|'discuss',baseBranch,modelId?,clientRequestId}` |
| POST /api/v1/conversations/:id/messages | `{clientMessageId,text,replyToMessageId?,attachmentIds?}` → messageId/deliveryState |
| GET /api/v1/conversations/:id/messages | cursor分页，包含回复关联、来源和投递状态 |
| POST /api/v1/tasks/:id/start | `{planRevision,expectedVersion,clientCommandId}`；只读讨论→允许执行 |
| POST /api/v1/tasks/:id/stop | `{expectedVersion,clientCommandId}`；幂等进入stopping；不是上游终态stop |
| POST /api/v1/tasks/:id/resume | `{expectedVersion,clientCommandId}`；只允许可恢复状态，进入队列并取得租约 |
| POST /api/v1/tasks/:id/retry | 失败/受阻重试，与人工停止的resume分开 |
| GET /api/v1/tasks/:id/artifacts | diff、检查结果、PR引用等鉴权数据 |
| POST /api/v1/conversations/:id/attachments | multipart；限制大小/type，返回attachmentId，不自动执行 |
| GET /api/v1/attachments/:id | **M2 已实现**鉴权下载，安全Content-Disposition与MIME，不内联执行上传HTML；上传属于 M3/M6 |

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

`GET /api/v1/events` 在 M2 已实现：先按 `Last-Event-ID`/`after` 回放持久事件，再接收进程内实时事件；每 15 秒心跳。SSE 失效时重新校验登录；服务端主动撤销会立即中断流，不只依赖首次连接检查。M2 尚无任务事件生产者，主要验证连接、回放边界与撤销关闭；浏览器通知消费同一事件，按eventId去重，正文展示默认适度摘要，点击定位任务（M3/M6）。

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
| POST /api/internal/v1/runtime-events | Bridge向平台推送Channel回复/事件，独立机器认证、sourceEventId去重 |

executionSpec只接受平台已授权和冻结的modelId/baseCommit/mode。人工暂停期间自动来源事件可记录但不唤醒；显式resume重新校验授权。旧上游stop不作为可恢复暂停的别名。

平台内消息+delivery同事务写；Bridge receive去重；回调平台提交成功才返回sent。网络超时抛出以便上游Outbox重试，重复回调返回原成功。ticket映射尚未产生时保留pending，不循环创建新Trigger。

## 上游真实接入点与差异

本地快照 `src/sources/kind.ts` 定义SourceKind、SourceChannel；`sourceContext(ctx.orchestrator,kind)` 获取上下文，等待ready/configured后 `receive(trigger)` 返回stored/duplicate/filtered。`ctx.orchestrator.sources.register(kind)` 返回卸载函数。SourceChannel.send接收host与OutboundMessage，返回sent/gone，临时错误抛出。

上游 package exports不公开完整Source宿主类型，因此在固定源码树增加 `src/sources/workspace.ts` 与构建入口、package exports、cordis patch；将源码相对import与Fork一起构建。具体Trigger/ChannelRef字段逐项照固定版本类型生成，禁止照本文自行猜shape。

原面板 `GET /orchestrator/api/tickets`、`GET /orchestrator/api/tickets/:id`、`POST /orchestrator/api/tickets/:id/stop`、`POST /orchestrator/api/tickets/:id/retry` 有loopback+same-origin限制；不要通过伪造Origin绕过来当新机器协议。原stop结束Ticket，retry只允许开放受阻Ticket；暂停继续需持久化补丁和恢复测试。

执行准入覆盖launch、deliver唤醒、恢复及人工额外slot；租约含fencing token，过期不能仅凭时间启动第二个worker，先证明旧执行已停止。宿主supervisor执行端检查租约，避免平台失联后双执行。上游事件agent/inbox/claimed、session/event只能在已证明写历史后标read。

## 必须完成的契约测试

相同key不同payload返回409；challenge双消费只有一个成功；发送后断网重投仅一个Trigger；Channel已落库但回执丢失重试不重复消息；SSE补发不漏交界事件；暂停重启不唤醒；租约失联不双执行；两个实例共享GitHub账号互不吞消息；不可用模型拒绝且不回退到未知模型；readonly无写凭据与写工具；切仓库不改变现有任务。
