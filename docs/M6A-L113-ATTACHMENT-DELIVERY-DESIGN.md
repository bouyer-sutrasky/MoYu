# L113 附件送达执行器：设计说明（不含实现）

状态：**设计草案，未实现，未改任何代码、契约或 upstream**。日期：2026-11-09。基线：`f86456c94c5795c45ade065fbf030117445d3b03`
（其代码 head 为 `83a8f3b`）。本文回答 #57 里 L113 的六个问题，并在每条方案上标注
「要不要动 upstream」「要不要新迁移」。文中代码片段只是文档示意，不在本单进入源码。

## 0. 结论摘要

- 附件**到不了执行器**的根因有三层，缺一层都不行：
  1. 平台契约 `bridgeTriggerInputSchema` 是 `.strict()` 且没有 `attachments`（`packages/contracts/src/runtime.ts:99-132`）；
  2. dispatcher 投递时只查 `messages.body`，不查 `artifacts`（`apps/dispatcher/src/delivery.ts:116-129`）；
  3. 执行器给 worker 的消息是**纯文本** `content: [{ type: 'text', text }]`（上游 `src/app/delivery.ts:73-80`），
     上游 Runtime 也没有“把文件挂到 worker 消息上”的公共扩展点。
- 推荐方案 **A：运行时 patch 取文件 + 工作区本地文件 + 工具按需读取**。Bridge 接收附件元数据，用实例已有的
  平台机器令牌把字节取到实例 stateDir，执行器在给 worker 的 trigger card 里只给**相对路径 + 大小 + sha256 + mime**，
  由 worker 用 `read_image` / `read` 按需读取。图像进入模型的唯一途径是 Harness 已存在的 `read_image` 工具
  （`dsh-tool-fs`：读本地 PNG/JPEG/WebP/GIF → 保存为附件 → 以 image block 进模型），所以**不改** worker 消息为多模态 content。
- 这条路线**要动 upstream 源码（以 `integrations/superagent/patches/` 的新有序 patch 形式，不动 `/root/src/upstream/*`）**，
  **不需要新迁移**。
- 无补丁的替代方案（B：worker 自己用预签名 URL 下载）可行但更弱：模型要按文本指令执行网络动作、
  URL 会进入消息文本与上游 SQLite、验收只能证明“worker 说它读了”，不能像 A 那样从会话事件核对。
- 需要所有者拍板的三件事见 §8；其中**执行器模型是否声明 image 输入**是图像验收的硬前提，我未能现场验证。

## 1. 现状与约束（已核）

| 事实 | 依据 |
| --- | --- |
| 平台→Bridge 的 trigger 请求体不含附件，且 `.strict()` 拒绝未知键 | `packages/contracts/src/runtime.ts:99-132`；协议文档 `docs/M3-BRIDGE-PROTOCOL.md` §2 |
| 运行时 Bridge 对未知键返回 **400**（`Invalid request`），400 在 dispatcher 里是**不可重试失败** | `integrations/superagent/patches/0002-machine-bridge.patch`（`TriggerRequestSchema`、`triggers()`、测试 `{nope:true} → 400`）；`packages/runtime-client/src/index.ts:254-270`；`apps/dispatcher/src/delivery.ts:440-500` |
| Trigger 模型只有 `text` + `meta`，`meta` 是不解释的来源细节 | 上游 `src/core/model.ts:23-38` |
| worker 收到的消息是纯文本；`sessions.prompt(sessionId, requestId, text, mode)` | 上游 `src/app/delivery.ts:73-80`、`src/app/sessions.ts:162-166` |
| trigger card 是 JSON 文本，含 trigger 文本前 600 字、来源链接；全文走资源读取 | 上游 `src/executor/dsh.ts:112-124`、`345-351` |
| Harness 的 `read_image` 读本地图片并按模型 modality 门禁：模型不支持 image 输入时直接拒绝 | `@deepseek-ai/dsh-tool-fs` README「`read_image`」「仅在模型声明图像输入时可用」 |
| worker 工具白名单包含 `read`、`read_image` | 上游 `src/app/sessions.ts:61`、`263` |
| 附件字节在平台受保护存储，元数据在 `artifacts`（`type='attachment'`, `sha256`, `message_id`） | `packages/contracts/src/attachments.ts`；A1/A2 证据 |
| 现有机器令牌只用于 runtime-events，且按仓库绑定校验 | `apps/api/src/auth/machine.ts`；`apps/api/src/routes/runtime.ts`（`verifyCallbackToken`） |
| A3 已如实记录：Bridge Trigger 原始 JSON 只有 `text`，附件未投递 | `docs/evidence/m6a/A3-attachment-delivery.txt` |

固定的 upstream 组合是 `dsh-superagent@6337fc8…` + `@deepseek-ai/dsh@0.2.1-rc.2`；上游没有公共 Source SDK，
现有全部运行时改动都在 `integrations/superagent/patches/0001…0024`，由 `build-patched.sh` 对**未打补丁的
pinned checkout** 依序应用（见 `integrations/superagent/README.md`）。因此本文说的“动 upstream”一律指
**新增 patch**，不是直接编辑 `/root/src/upstream/*`（那棵 checkout 必须保持 pristine）。

## 2. 契约怎么扩（问题 1）

### 2.1 形状

在 `bridgeTriggerInputSchema` 里加**可选** `attachments`；每个附件只给**定位与校验**所需字段，不给内容、不给
平台下载 URL、不给任何令牌：

```ts
// 仅文档示意，不进入 packages/contracts
const bridgeAttachmentSchema = z
  .object({
    id: uuidSchema, // 平台 artifacts.id，下载路径的唯一键
    filename: z.string().min(1).max(255), // 仅用于展示与工作区文件名提示
    mimeType: z.string().min(1).max(200), // 展示/分类；不决定是否可信
    sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/), // 下载后必须逐字节校验
    kind: z.enum(['image', 'text']), // L113 只送 image/text；binary 留到后续
  })
  .strict();

// bridgeTriggerInputSchema 内新增：
attachments: z.array(bridgeAttachmentSchema).max(10).optional(),
```

刻意**不**包含：

- `downloadUrl`：URL 由运行时用配置的 `MOYU_PLATFORM_URL` + id 自行拼，避免 SSRF 与“URL 里带签名/令牌”进入
  trigger 文本、上游 SQLite 和日志；
- 内容（base64）：bridge 请求体上限 256 KiB（协议 §2），单个图片上限 10 MiB，直传必然失败，且会把字节写进日志/DB；
- `conversationId`/`ownerId`：trigger 已有 `conversationId`，附件只应属于这条消息，多给字段等于放宽校验面。

### 2.2 平台侧发送（dispatcher）

- `loadDetail` 的 SQL 增加一条按 `m.id` 查 `artifacts`（`type='attachment'`，`message_id = m.id`，`sha256` 非空）的子查询/连接；
- `bridge.trigger()` 只在运行时能力声明 `attachments: true` 时带该字段，否则沿用今日纯文本；
- 按附件 kind 过滤：`image`/`text` 才发；`binary` 先不送（避免“执行器读不了却声称已投递”）。
- **要动 upstream：否。要新迁移：否**（`artifacts` 与 `deliveries` 已存在）。

### 2.3 能力声明（问题 4 的一半）

`GET /bridge/v1/capabilities` 增加可选布尔（缺省 = 不支持，旧 runtime 自然为 false）：

```ts
attachments: z.boolean().optional(), // M6-A L113：trigger 可携带附件引用，执行器会落到工作区
```

`/bridge/v1/models` 建议同时补 `inputModalities: z.array(z.enum(['text','image'])).optional()`，让平台在投递前就能
判断“这台实例的当前模型看不看图”，而不是等 worker 的 `read_image` 报错（是否加见 §8 决策 2）。

## 3. 谁取内容、怎么鉴权（问题 2）

### 3.1 推荐：运行时取，机器令牌，按消息绑定

- **取内容的是运行时（Bridge/执行器），不是 worker**。worker 只拿工作区里的本地路径，不接触平台令牌，
  也不执行下载动作。
- 复用实例已配置的 `MOYU_PLATFORM_TOKEN`（今天已用于 `POST /api/internal/v1/runtime-events`）。新增内部路由：

```text
GET /api/internal/v1/messages/:messageId/attachments/:attachmentId
Authorization: Bearer <实例机器令牌>
200  application/octet-stream + content-length + x-moyu-sha256
401  令牌缺失、未知或不属于该消息所在仓库（无法从令牌反查“它属于哪个仓库”，与 runtime-events 一致）
404  附件不存在、不属于 :messageId、或该消息不在所绑定仓库
409  附件仍为未发送草稿（message_id 为空）
```

- 路由用现有 `verifyCallbackToken(repositoryId, token)` 校验“本令牌属于这条消息所在仓库”，与 runtime-events 同一
  信任模型；再校验 `artifact.message_id = :messageId`、`type='attachment'`。这样仓库 A 的令牌取不到仓库 B 的附件，
  同一仓库内也必须指明**本消息**，不能枚举仓库里任意附件。
- 运行时侧 URL 只由 `MOYU_PLATFORM_URL` + id 拼出（不信任 trigger 里任何 URL 字段），请求带
  `Authorization: Bearer <env>`，**不**写进 trigger、日志、工作区文件或上游 SQLite。
- 传输安全：生产走平台现有 HTTPS 反代；运行时只连配置的 platform origin；下载有超时与大小上限，
  以 `content-length` 预检、边下边算 sha256，完成后与 trigger 的 `sha256`/`sizeBytes` 比对，不符即整次 trigger 失败（不启动执行）。

### 3.2 备选：预签名 URL（问题 2 的另一半）

- 平台用 HMAC（密钥可为新 secret 或复用机器令牌派生）签 `(attachmentId, messageId, 过期时间)`，把短 TTL URL
  放进 trigger 的附件字段；运行时**不带 Bearer**直接 GET。
- 优点：运行时不需要平台令牌；下载路由可无状态。
- 代价：URL 会进入 trigger 文本/上游 SQLite/日志（即使短 TTL），需要新签名密钥与轮换方案；仍要运行时下载，
  所以**仍需要 patch**。若把 URL 直接塞进 worker 的文本、由 worker 自己 curl（无 patch 的 B 方案），则令牌/URL
  暴露面和“模型是否照做”的不确定性都更大。

### 3.3 凭据落地规则（两种方案都适用）

- 下载到实例 stateDir 下的临时目录：`<stateDir>/attachments/<triggerId>/<attachmentId>/`，目录 0700、文件 0600，
  文件名只取白名单字符（或直接用 `<attachmentId>` 名，原名只作展示）；禁止路径穿越与符号链接跟随。
- 下载完成后立即校验 sha256/size；校验失败删除临时文件并拒绝本次 trigger；状态码建议在 patch 里区分为 422（附件不可受理/校验失败）与 503（平台暂时取不到、可重试）。
- 日志只记 attachment id、message id、sha256、字节数；**永不**打印 Authorization、URL 中的签名、文件内容。
- 清理：ticket 结束或 worktree 删除时清对应工作区副本；stateDir 暂存按 triggerId 在成功落盘到工作区后删除，
  失败/被拒绝的 trigger 由实例启动清理（比照现有 state 目录清理策略）。

## 4. 执行器怎么读到（问题 3，最关键）

### 4.1 需要补丁，补丁落在 `integrations/superagent/patches/`

**结论：需要新增一个有序 patch（建议 `0025-workspace-attachments.patch`），不直接改 `/root/src/upstream/*`。**
原因是上游没有“把外部文件挂到 worker 消息”的公共扩展点：Trigger 只有 `text`/`meta`，worker 消息是纯文本，
`ThreadContext.image` 只服务 assessment（Feishu 的 `src/sources/feishu-image.ts` 就是这条路径），不服务 worker。

patch 的最小改动面（按文件）：

| 上游文件 | 改动 | 说明 |
| --- | --- | --- |
| `src/app/bridge.ts` | `TriggerRequestSchema` 加 `attachments`（同 §2.1），`workspaceTrigger()` 把校验后的数组放进 `trigger.meta.attachments` | 只解析与存储引用，不下载 |
| `src/executor/dsh.ts` | `triggerCard()`/`triggerMessage()` 增加 `attachments` 段；launch 与 input 两条路径在把 card 交给 worker 前，把 stateDir 暂存文件复制进 `<workspace>/.moyu/attachments/<attachmentId>/<filename>`，并在 card 里给出**工作区相对路径** | 幂等：已存在且 sha 匹配就跳过；不匹配则重下 |
| `src/sources/workspace.ts` | 收 trigger 时（或 executor 首次落盘时）用机器令牌下载并校验；失败则拒绝 trigger | 也可放在 executor launch，取决于所有者接受哪层依赖 |
| `src/app/bridge.ts` `/capabilities` | 增加 `attachments: true` | 能力协商 |
| 测试 | bridge schema 拒绝未知键、能力声明、下载 sha 校验、路径穿越、重复投递幂等、card 不含内容 | 随 patch 一起进仓库 |

- 工作区副本放在 `.moyu/attachments/…`，并写进 worktree 的 `.git/info/exclude`（不改仓库 `.gitignore`），
  确保不会出现在 diff/PR 里；worker 的 `read`/`read_image` 路径授权以 workspace 为根，能读到。
- card 里给 worker 的形态（示意，≤ 每附件 2 行）：

```json
"attachments": [
  { "id": "…", "filename": "l113-shot.png", "mime": "image/png", "size": 48213,
    "sha256": "…", "path": ".moyu/attachments/<id>/l113-shot.png" }
]
```

- **不进 prompt 的内容**：不内联文本、不内联图片、不给“请读”之外的叙述；worker 自己决定何时 `read`/`read_image`，
  这就是“按需读取”的实现含义。
- 失败语义：下载/校验失败应让 trigger 被拒绝（Bridge 返回 422/502 且**不**入库为 accepted），避免出现
  “消息 delivered 但附件永远不到”的半状态；是否允许“附件失败仍以纯文本执行”是产品决策（见 §8 决策 3）。

### 4.2 不碰 upstream 的替代（供对比，不推荐）

| 方案 | 做法 | 要动 upstream？ | 新迁移？ | 主要问题 |
| --- | --- | --- | --- | --- |
| B. worker 自取 | 平台把预签名 URL 追加到投递文本；worker `curl` 到工作区再 `read_image`/`read` | **否** | 否 | 模型必须照做；URL/签名进消息文本与上游 SQLite；网络 egress 与失败重试都得靠 worker；验收只能拿到“worker 自称读过” |
| C. 平台/宿主预放 | supervisor 在 runtime 建好 worktree 后把文件写进去，平台在文本里给路径 | 否（改 platform/supervisor） | 可能需要跟踪表 | 与 runtime 建目录存在竞态；宿主代写工作区越权；清理责任不清 |
| D. 等上游公共能力 | 向上游提 attachment/多模态消息扩展 | 是（上游版本升级） | 取决于上游 | 固定 commit 与“不改 bootstrap”约束下本阶段不可用 |

C 的“平台写工作区”会打破现有边界（工作区归 supervisor/runtime），且没有可靠的“建好后”钩子；B 是唯一可接受的
无补丁退路，但验收强度明显低。

## 5. 向后兼容与灰度（问题 4）

- **旧 runtime 收到带 `attachments` 的 trigger**：Bridge 的 `TriggerRequestSchema` 是 `.strict()`，会直接
  **400 `Invalid request`**（patch 0002 的 `triggers()` 与测试已固定该行为）；dispatcher 对 400 是**不可重试失败**，
  delivery 会停在 `failed`。所以**绝不能**对未声明能力的 runtime 发送该字段。
- 能力协商：dispatcher 启动时已拉 `/bridge/v1/capabilities`（现只用了 `admission`），增加读取 `attachments`；
  未声明就不带字段 → 旧 runtime 完全无感，消息仍以纯文本投递（与今天一致，A3 的缺口继续如实存在）。
- 灰度：按实例（repository binding）生效。先在被测 profile 上启用新 patch；平台侧能力探测成功后自动带上附件；
  回滚 = 切回旧 build（能力变 false，平台立刻退回纯文本）。无需全局开关。
- 协议版本：建议**保持 `moyu-bridge/1`**，用可选字段 + capability 表达增量（与 M4/M5 的 `start`/`branches`/`admission`
  同一模式）；只有调整既有字段语义时才升版本。是否改为 `1.1` 见 §8。
- 契约测试：平台侧 `bridgeTriggerInputSchema` 的 round-trip 测试、dispatcher 的 capability 分支测试、patch 0002 的
  “未知键 400”测试都要保留/新增；这些是**新增测试**，不回退既有条数。

## 6. 验收怎么证明（问题 5）

「把图片塞过去」不算数；要证明**模型真的看到了像素**。建议的真实截图任务：

1. 平台生成一张 PNG 截图（真实 Web 页面截图即可），图上渲染一个随机短语，例如 `L113-IMAGE-7Q4M`；
   另附一个文本文件，内容是一段随机 token `L113-TEXT-9K2P` 加几行说明。两者都按真实上传链路入库（sha256 可核）。
2. 平台消息只写“请检查附件并回答/改代码”，不内联任何附件内容；dispatcher 投递仅在能力支持时带 `attachments`。
3. worker 侧：
   - **图像**：worker 必须对 `.moyu/attachments/<id>/l113-shot.png` 调 `read_image`；Harness 会校验模型 modality，
     把图片存为附件并以 image block 进入模型。若模型不支持 image 输入，`read_image` 直接失败——这时**不能**判通过。
   - **文本**：worker 只在需要时 `read` 该文本路径；card 与 trigger 里不出现 token 内容。

可核验证据（缺一不可）：

| 证据 | 证明什么 |
| --- | --- |
| Bridge 收到的 trigger 原始 JSON（含 `attachments` 元数据、无内容） | 契约与传输正确，且没有把内容塞进 prompt |
| 工作区文件 `sha256` = 平台 `artifacts.sha256`；文件权限 0600、未出现在 `git status` | 落盘完整、私有、不污染 diff |
| worker 会话事件里的 `read_image` 工具调用与成功结果（attachment 引用） | 执行器确实把图交给模型，而不是只给了路径 |
| worker 的 report/PR 里出现 `L113-IMAGE-7Q4M` | 模型从像素读到了短语（不是从文本抄的） |
| worker report 里出现 `L113-TEXT-9K2P`，且 `read` 调用指向该路径 | 文本“按需读取”的确发生 |
| 反例：不带附件/不指示读取时，report 不含上述 token | 证明 token 没有从 prompt/trigger 泄漏 |

证据落点：`docs/evidence/m6a/L113-attachment-delivery.txt`（原始命令、trigger JSON、sha 对比、会话事件摘录、
report 引用），截图任务本身用真实平台消息 + 真实 worker；**不用**受控替身冒充端到端。

**已知前提（未验证）**：当前执行器模型 `commandcode/deepseek/deepseek-v4.1-flash` 是否声明 image 输入，
我无法在隔离环境读模型目录确认。若不支持，图像这一半的验收必须先选一个 image-capable 模型（会改变 ticket 冻结
模型语义，属产品决策），否则只能验收文本按需读取。

「文本按需读取」的定义：**内容不在 trigger/prompt 里，worker 通过 `read` 工具自行取用**；证据是 token 出现在
report 里而 prompt 里没有。这与“把文本贴进消息”有本质区别，也是本设计不把内容放进 card 的原因。

## 7. 风险与不可逆点

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 契约增字段后旧 runtime 收到 → 400 且 delivery 永久 failed | 消息丢执行 | 只按 capability 发送；灰度先运行时后平台；禁用字段即回滚 |
| 图像公章 sha 语义被误解 | 平台 sha 与 Harness 归一化后的附件 sha 可能不同（`read_image` 会重新编码/缩放） | 只比较**落盘原文件**与平台 sha；报告里不声称两者相等 |
| 执行器模型不支持 image | 图像验收无法成立 | 决策 2；不支持就只验收文本，并在证据中写明缺口 |
| 磁盘/隐私 | 附件副本 + 暂存占空间；附件可能含敏感内容 | 0600/0700、清理策略、大小上限；不在日志/PR 粘贴内容 |
| 重复投递/重试 | 同一 trigger 重发导致重复文件/重复卡 | 以 attachment id 为目标文件名，sha 匹配幂等；不新增 DB 行 |
| M5-B 负担 | M5-B 已判未通过，不应被本设计加重 | 本方案不改 admission/lease 逻辑，不新增迁移；只在 Bridge/executor 的 trigger/launch 路径加附件，M5-B 复验不覆盖附件；新增测试不影响既有条数 |
| 回滚 | 已把附件投给 worker 后回滚 build | 回滚后新消息退回纯文本；已投递的消息与工作区文件不影响执行正确性（worker 只是没读到附件） |

## 8. 需要所有者拍板（本单不替做产品决策）

1. **是否批准新增运行时 patch `0025`**（改 fork 的 bridge/executor/workspace，不改 `/root/src/upstream/*`），
   还是走无补丁的 B 方案（worker 自取预签名 URL，验收与安全都更弱）？
2. **图像验收用哪个执行器模型**：`deepseek/deepseek-v4.1-flash` 是否声明 image 输入？若否，是否允许附件任务
   指定 image-capable 模型？`/bridge/v1/models` 是否要暴露 `inputModalities`？
3. **附件下载失败时**：整条 trigger 拒绝（我的推荐），还是降级为纯文本继续、把“附件未投递”显式记入 delivery 证据？
   以及平台侧下载路由用**机器 Bearer**（推荐）还是**预签名 URL**？
4. **协议版本**：保持 `moyu-bridge/1` + capability（推荐），还是升 `1.1` 要求 runtime 同步升级？

## 9. 附：涉及文件与行号（本单只读核对）

- 平台契约：`packages/contracts/src/runtime.ts:37-61`（capabilities）、`79-85`（models）、`99-132`（trigger）、
  `packages/contracts/src/attachments.ts:10-45`
- 投递：`apps/dispatcher/src/delivery.ts:116-129`（detail SQL）、`309-330`（trigger 调用）、`440-500`（失败/重试映射）；
  `packages/runtime-client/src/index.ts:118-130`、`254-270`
- 平台内部鉴权/下载落点：`apps/api/src/auth/machine.ts`、`apps/api/src/routes/runtime.ts:74+`
- 运行时 patch：`integrations/superagent/patches/0002-machine-bridge.patch`（Bridge schema/触发）、
  `0001-workspace-source.patch`（workspace Source）、`0021-bridge-branches.patch`（能力字段先例）、
  `build-patched.sh`、`README.md`
- 上游（固定 commit `6337fc8`）：`src/core/model.ts:23-38`、`src/app/delivery.ts:73-80`、
  `src/app/sessions.ts:61,162-166,205-215,263`、`src/executor/dsh.ts:112-124,338-351`、
  `src/sources/feishu-image.ts`、`src/sources/kind.ts:40-75`
- Harness：`@deepseek-ai/dsh-tool-fs` README（`read_image` 的 modality/附件门禁）、`@deepseek-ai/dsh-attachment` 类型
- 证据现状：`docs/evidence/m6a/A3-attachment-delivery.txt`（附件未投递的原始记录）、`docs/IMPLEMENTATION.md:48`
