# M4-UX 基础体验修复

日期：2026-11-04。范围：Issue #23 的「历史分页、草稿与发送一致性、偏好保存、旧阶段文案」。
基线：`origin/main` = `40e857a9081b281fb3a93ebaea6986e0101f005d`。M4 已验收行为与冻结配置保持不变；
新增仓库接入、实例调度与资源控制仍属 M5，本单只修正既有入口与状态解释。

本文先列验收矩阵与状态约束，实际执行结果见 [`M4-UX-VERIFICATION.md`](M4-UX-VERIFICATION.md)。

## 1. 验收矩阵

| # | 验收场景 | 机制 | 状态约束 | 覆盖 |
| --- | --- | --- | --- | --- |
| 1 | 超过 100 条消息逐页访问全部历史；与 SSE 同时到达无遗漏/重复；滚动位置稳定 | 消息 `(createdAt,id)` keyset 游标 + 按 id 合并 | 同时间戳由 id 决胜；页边界严格不含已返回 id；合并幂等 | API 集成测试、真实浏览器 |
| 2 | 超过任务列表默认上限的历史任务可访问；切换仓库列表与游标隔离 | 会话 `(updatedAt,id)` keyset 游标，游标绑定仓库 | 跨仓库游标 422；切换仓库清空列表与游标；迟到响应按 token+仓库丢弃 | API 集成测试、真实浏览器 |
| 3 | 加载失败重试、SSE 断线回放与刷新；已加载消息的投递/read 状态随 SSE 就地刷新；初次加载窗口内的 SSE 不丢失 | 首次页与更早页分别保留错误状态；新消息按 `after` 追赶；`message.delivery_changed` 按 event.messageId 单条补取；初次加载记 dirty 并在落地后补查 | 已加载历史与滚动位置不变；初次查询后、响应前到达的事件在首屏落地后可见且不重复；切会话按 token 隔离 | 集成测试、真实 dispatcher/SSE + 浏览器、可控时序拦截 |
| 4 | 会话 A 发送中切 B、A 发送中继续编辑、失败重试、服务已接收但响应丢失；合并到 GitHub 目标时的草稿迁移 | 草稿版本 + 固定 clientMessageId；发送目标在提交时捕获；合并回执把较新源草稿迁到 target | 旧请求不得清理新版本草稿或改写当前输入；目标已有草稿不得被覆盖，两段文本都可恢复；同 key 重试返回原消息 | 浏览器拦截 + 真实 API/DB |
| 5 | 多所有者/仓库/会话草稿隔离、刷新恢复、退出/清除策略 | localStorage `moyu:draft:v1:<owner>:<repo>:<conversation>`，内存兜底 | 显式退出清除该所有者草稿；存储不可用不阻断发送 | 浏览器 |
| 6 | 偏好刷新恢复、跨仓库隔离、失效分支/模型、旧任务冻结、创建前展示实际配置 | `repository_preferences` 每仓库一行；创建时复制到 conversation/task | 偏好只影响新任务；失效分支/模型要求重新选择；目录不可用如实展示 | 集成测试、真实浏览器 |
| 7 | 桌面与手机真实浏览器、浅色/深色；M4 停止/继续、投递/read、GitHub 关联回归 | Playwright + 真实 API + 独立 PostgreSQL | 不使用静态页面或伪造日志 | 证据截图与 DOM 断言 |

## 2. 分页状态约束

### 2.1 消息

- 排序键固定为 `(createdAt ASC, id ASC)`；分页查询反向取 `limit+1` 判断是否还有更早/更新页。
- 游标是不透明的 base64url JSON，包含 kind、会话 id、时间戳与消息 id；不匹配的游标返回 422，不会静默套用到别的会话。
- `before`：严格位于游标之前；同时间戳按 id 继续比较。`after`：严格位于游标之后。
- 响应 `messages` 始终升序；`nextCursor` 指向更早页，`newerCursor` 是本次返回的最新消息，`hasNewer` 表示 `after` 查询还有下一段。
- 前端按 id 合并页面：已加载的历史不会被最新页替换；同一消息再次出现时用新投影覆盖（投递状态更新）。
- 新消息事件只按 `after` 最新游标追赶；`message.delivery_changed` 不是新消息，前端用事件里的
  `messageId` 调用 `GET /conversations/:id/messages/:messageId` 就地替换该行，不移动顺序或滚动位置。
- 首次消息页请求在途时收到 SSE，不能丢弃：前端记 dirty，并把投递事件 id 入队；首屏落地后按返回的
  `newerCursor` 补查新消息、按 id 补取投递状态。切换会话时请求 token 与 dirty 队列一并隔离。
- 旧客户端传入纯 ISO 时间戳仍按严格时间比较处理；新客户端只回传服务器游标。

### 2.2 任务列表（会话列表）

- 一个会话对应一个任务；列表分页即任务历史分页。
- 排序 `(updatedAt DESC, id DESC)`；游标同样包含仓库作用域，跨仓库复用返回 422。
- 切换仓库时清空列表、游标、加载更多状态与错误；迟到的旧仓库响应按请求 token 与仓库 id 丢弃。
- 静默刷新只取最新一页并按 id 合并，保留已加载的更早任务；显式刷新重新取第一页。

## 3. 草稿与发送一致性

- 草稿 key 为 `moyu:draft:v1:<ownerId>:<repositoryId>:<conversationId>`；所有者、仓库或会话不同即不同草稿。
- 每次文本变化使 `version` 递增并立即持久化；空文本表示显式清除。
- 发送前把 `{version,text,clientMessageId}` 作为 pending 写入草稿。相同文本重试复用原 `clientMessageId`；
  文本变化生成新 id，旧 id 不会用于新内容。
- 成功响应只在该草稿仍是发送时的 `version` 且文本一致时清除。发送途中继续编辑会保留新文本；
  pending 只清除属于本次发送的 id。
- 发送目标在按下发送时捕获；请求返回后不再读取“当前选中会话”，因此切到 B 不会把 A 的请求发到 B，
  也不会清掉 B 的输入。
- 服务端把空 Web 会话合并进已有 GitHub 会话时，回执的 `message.conversationId` 是 target。源会话随后
  从列表隐藏，因此仍属发送时版本之外的较新草稿必须迁到 target；target 已有草稿时用空行连接两段文本并
  递增版本、清除旧 pending，任何一段都不丢。源 key 只在 target 写入后删除；迟到回执只在当前会话仍是
  源/目标时改输入，已切走时仅整理存储。
- 网络结果不明确时保留 pending 并提示重试；重试复用原 `clientMessageId`。服务端
  `(conversation_id,client_message_id)` 唯一约束与“相同 payload 返回原结果”保证不重复入库、不重复投递。
- 存储策略：显式退出清除该所有者全部草稿；会话内“清除草稿”立即删除本地记录；会话丢失（401）
  不清草稿，重新登录后可继续。localStorage 不可用时使用内存副本，当前会话内的输入不丢失、发送不失败。

## 4. 偏好状态约束

- `repository_preferences` 以 `(owner_id, repository_id)` 唯一；保存执行方式、默认分支、模型与推理强度。
- 偏好只是下一个任务的默认值。创建时把实际值复制到 `conversations` 与 `task_links`，之后修改偏好不影响旧任务。
- `GET /repositories/:id/preferences` 返回已保存值与 effective 值（无保存值时使用仓库默认分支、
  `execute`、实例默认模型）。
- `PUT` 通过仓库 Bridge 的模型目录与分支列表校验：模型不在目录、推理强度不支持、分支已删除均返回 422
  并给出具体原因；运行时不可达返回 503 且不落库。运行时缺少分支能力时接受保存，但界面明确显示
  “无法确认分支是否存在”，不伪造校验结果。
- 创建任务前界面展示本次实际使用的仓库、分支、模型、推理强度、执行方式与来源（已保存偏好/仓库默认）。
- 创建面板在分支能力可用时只允许从列表选择；已保存分支失效时清空并要求重新选择。模型目录不可用时禁用创建。

## 5. 接口与存储变更

| 变更 | 说明 |
| --- | --- |
| `GET /api/v1/conversations/:id/messages` | 新增 `before`/`after` 不透明游标、`hasMore`、`newerCursor`、`hasNewer`；`nextCursor` 改为组合游标 |
| `GET /api/v1/conversations/:id/messages/:messageId` | 返回一条消息及其当前投递投影；用于 SSE `message.delivery_changed` 就地刷新，跨会话 id 返回 404 |
| `GET /api/v1/conversations` | 新增 `cursor`、`nextCursor`、`hasMore`；游标绑定仓库 |
| `GET /api/v1/repositories/:id/preferences` | 已保存偏好与 effective 配置 |
| `PUT /api/v1/repositories/:id/preferences` | 保存偏好并做运行时校验 |
| `DELETE /api/v1/repositories/:id/preferences` | 恢复仓库默认 |
| `GET /api/v1/repositories/:id/branches` | 运行时分支列表；能力缺失返回 `status:'unsupported'` |
| `POST /api/v1/conversations` | 运行时可达时校验分支/模型，不回退未知值；不可达时保持既有行为 |
| 迁移 `0009_far_typhoid_mary` | 新表 `repository_preferences`；消息 `(conversation_id,created_at,id)` 索引 |
| Bridge `GET /bridge/v1/branches` | 上游补丁 `0021`；能力 `branches`；分页分支列表，只读 |

`0009` 是当前最新迁移，回滚脚本只允许在它是最后一条已应用迁移时执行，并要求传入文件 sha256。

## 6. 未决与边界

- 网页新增仓库、实例唤醒/调度、资源预算属于 M5；本单只改文案与禁用原因，不实现。
- 活动中心、diff/检查面板属于 M6；不新增占位数据。
- 偏好校验依赖仓库 Bridge 可达；不可达时保留既有创建行为，最终以运行时解析与任务状态为准。
- 分支列表来自固定上游补丁；未升级运行时显示 `unsupported`，不能声称已校验分支。
- 0021 已在独立 profile 的真实 runtime 上验证（Bearer 401、真实目标仓库分支、平台保存/失效分支）；
  生产 3082 实例未重启，平台包把 `unsupported` 作为旧运行时的诚实降级。
