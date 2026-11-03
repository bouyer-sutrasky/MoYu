# Superagent Workspace 实现方案

状态：概念实现方案，已完成环境调研。产品决定见 DESIGN.md；开发执行以 DEVELOPMENT-GUIDE.md、API-CONTRACTS.md 及 BOOTSTRAP-RUNBOOK.md 为准。本文中的接口与组件是新项目设计，不是上游已存在的公共 API。未修改服务器。

## 范围与技术选择

个人 Work 工作台接入已有 superagent；Chat 仅保留独立会话类型及 Provider 接口，不调用机器人。

- 前端：React、Vite、TypeScript、CSS Modules、clsx、TanStack Query。
- 视觉：从固定 commit 提取 Harness ui-theme 的语义变量及必要依赖，保留许可证和来源；不让业务组件依赖整套 Harness 前端运行时。
- API：Node.js LTS、Fastify、Zod；前后端共享事件与请求类型。
- 平台存储：PostgreSQL、Drizzle；数据库事务实现消息投递队列与租约，第一版不增加 Redis。
- 通信：HTTP 提交，SSE 发送持久化事件；首版以消息与进展流为保证，逐 token 能力依实际 Session 接口验证。
- 部署：复用现场 Nginx 终止 HTTPS，Compose 运行新平台服务；Docker 尚需准备，受限宿主调度服务管理仓库实例。容器引擎控制权限不授予执行器。
- 验证：Vitest 集成测试、Playwright 用户流程、真实服务器的恢复和内存压力验证。

## 页面

### 登录与绑定

首次部署命令输出短时一次性绑定码；网页兑换为受限注册流程，成功登记首个 Passkey 后关闭初始化入口。正常登录只有“使用 Passkey 登录”，无注册、用户名密码或团队入口。恢复命令可重新登记凭据并撤销旧会话。

使用成熟 WebAuthn 库实现挑战生成与校验；绑定稳定 HTTPS 域名及 RP ID，校验 challenge、origin、RP ID 与用户验证结果。挑战短期、一次性且与操作绑定，绑定码仅保存摘要、限制失败尝试。认证成功签发可撤销的随机会话，服务器保存摘要；Cookie 使用 HttpOnly、Secure、SameSite，持续使用时滚动续期。不设置固定周期要求用户重登；浏览器主动清除数据仍需重新认证。

设置分开列出登录凭据和浏览器会话，支持撤销。请求鉴权覆盖 API、SSE、附件与 diff；写操作做 Origin/CSRF 校验。Passkey 与专用 GitHub 账号不互相映射为登录方式。

### Work

桌面左栏约 260px：Work/Chat、仓库选择、新建任务、活动中心、当前仓库历史、设置。顶栏显示标题、仓库、分支和状态。中央会话最大宽度约 800px，输入区固定底部。右侧约 380px，默认收起，包含变更、检查、交付标签；窗口不足时改抽屉。

新任务选择分支、模型、直接执行/先讨论。已有任务固定仓库、起点与模型。讨论阶段显示“按此方案开始执行”，转换后不展示可误导为回滚权限的模式切换。消息显示投递与读取状态，进度折叠，问题突出。运行时提供停止，停止后提供继续。

手机侧栏为抽屉，详情为全屏面板，优先保证查看、回复、停止和继续。Chat 展示尚未接入及说明，不假装已可发送。

### 其他页面

- 添加仓库：列出专用 GitHub 账号可访问仓库，也可输入 owner/repo；检查权限后保存配置，不强制维持在线。
- 活动中心：跨仓库未读、运行中、等待回复；定位任务与全部已读。
- 设置：外观、通知、登录凭据与会话、仓库状态、资源与存储。模型仅选择 Harness 已配置项。
- 通知：页面打开时提供系统通知，默认仅后台；关闭页面后不推送，重开补看活动记录。

## 领域与存储

平台保存 repositories、conversations、messages、task_links、deliveries、events、artifacts、credentials、sessions 及 runtime_leases。所有任务保存 repositoryId、runtimeId、baseBranch、resolvedBaseCommit、modelId 和执行模式；用户消息有稳定 clientMessageId。

superagent 自有 Store 管理 Ticket、Assignment 和执行状态；平台只保存映射及可重建展示投影，不能直接修改上游 SQLite。平台会话只有一个主任务，上游 Thread 若产生多个 Ticket 必须拦截或显式拆成关联任务，不能静默映射为同一任务。

附件按任务隔离保存，元数据落库；下载需鉴权，按实际内容识别类型并限制大小，拒绝路径穿越。不将附件中的文本当作系统授权；截图需要经过图像读取链路验收。

## Bridge 与可靠消息

新增 workspace Source，将登录所有者消息转换为稳定 Trigger/Thread，使用上游准入流程创建或续接 Ticket。Channel 将回复回传平台。Bridge 同时适配任务状态、模型列表、停止、重试、Session 读取和进展事件，绑定已验证的上游版本。

消息与待投递记录同事务写入；领取租约后投递，失败用同一 ID 重试。接收端对 Trigger ID 去重，回复端对 OutboundMessage ID 去重。事件先持久化再推送，SSE 用事件序号断点补发。读取状态只能来自执行器实际确认，不能用 HTTP 接收成功代替。

GitHub 在线入口与网页任务按仓库、来源事件及 Ticket/PR 关系关联。不同实例共享专用 GitHub 账号时必须验证通知游标、已读操作不会相互吞事件；过滤 agent 自己的回复。休眠实例不监听，唤醒后补收范围需验证，不承诺任意历史事件均可恢复。

示例新 API：

```
POST /api/auth/registration/options
POST /api/auth/registration/verify
POST /api/auth/login/options
POST /api/auth/login/verify
POST /api/auth/logout
GET/POST /api/repositories
POST /api/repositories/:id/wake
POST /api/conversations
GET/POST /api/conversations/:id/messages
GET /api/conversations/:id/events
POST /api/tasks/:id/start
POST /api/tasks/:id/stop
POST /api/tasks/:id/resume
GET /api/tasks/:id/artifacts
```

## 权限与执行

先讨论采用独立只读工具集合、只读仓库挂载，不提供通用写入 shell 或 GitHub 写凭据；仅靠 prompt 或命令黑名单不能满足要求。平台在显式开始后允许可写执行环境，保存计划及授权状态，并将上下文移交执行 Session。上游 preset 是否支持原位切换必须验证，不支持则新建受控执行 Session。

平台与宿主调度器负责全局及每仓库租约；所有入口，包括 GitHub、新任务、人工回复和上游额外 worker 名额，都必须遵守同仓库串行与资源准入。需要在 Bridge/Executor 启动位置做门控，不能只让前端排队。

每任务独立 worktree。执行器仅访问本仓库及本任务必要资源，不挂载平台凭据、其他仓库或容器引擎 socket。停止跟踪并终止受管进程与子任务，完成后才确认停止；外部已完成动作不自动回滚。

## 实例与资源

实例状态：休眠、启动中、在线、停止中、故障。初始在线上限两个，每仓库执行并发一个。Web 请求按需唤醒；实例都忙时排队。恢复人工交互优先于未开始任务，但不得抢占正在执行的任务。等待回复/审阅释放执行名额，仍可能占实例内存。

空闲淘汰前检查受管后台作业；存在仍需使用的预览服务等工作时不能仅凭 Ticket 待审阅判为空闲，应显示原因或经既定服务生命周期关闭后再休眠。休眠停进程、保留状态，不声称保存进程内存。

将平台、数据库、执行实例及子进程放入共同资源核算范围；验证宿主 cgroup 配置后设置整个系统最高 8GB。6GB 为调度预算而非每实例上限，也不把 6GB memory.high 当作禁止扩展的硬阈值。常态目标 4GB；使用宿主可用内存、系统压力及本系统占用决定是否准入，预留余量和迟滞避免反复启停。具体阈值经部署测量后配置。

到预算边缘先暂停新启动，再回收空闲实例；不能保证硬上限下内核永不终止进程。识别 OOM 后标为资源不足、保留现场、避免自动循环重启；平台控制面应预留资源以记录结果。8GB 上限包括构建测试，不只是模型进程。

## 恢复与清理

重启先恢复租约和投递，再对账上游 Ticket、Git 状态及已有 PR；只有原本正在执行的工作自动恢复，尊重在线数量与预算。外部操作结果不明先查询，不能宣称跨网络 exactly-once；无法确认则受阻。

已合并任务工作目录七天后可清理。确认已合并、无活动执行、无未提交/未推送改动，并验证解析后的绝对路径位于任务根目录；以正确 worktree 操作移除。保留会话、附件、报告及远端分支。检查失败则跳过，记录原因。其他任务目录默认保留；磁盘占用可见。

## 实施顺序与验收

1. 对照京东云实际 Harness/superagent commit 做只读兼容性核对，固定版本，验证 Source、Session、模型与停止接口。检查共享账号通知是否串扰。
2. 单仓库纵向闭环：Passkey、消息投递、接单、提问回答、执行、PR 交付与历史恢复。
3. 加入讨论只读边界、执行中补充、停止继续和附件；验收讨论阶段确实不能写文件或访问写凭据。
4. 多仓库按需启动、两实例限制、同仓库串行及 GitHub/Web 去重；验证第三仓库排队和人工回复唤醒。
5. 实测 6GB 常态预算与 8GB 上限，覆盖构建子进程、资源不足、宿主重启及恢复。验证不会自动启动已停止任务。
6. 完成 diff、通知、登录撤销、存储与清理体验，验证手机回复流程。

关键验收还包括重复提交只接单一次、断线事件补齐、撤销会话后 SSE/附件失效、清理不删除未保存工作、PR 未合并关闭不误报完成。需真实运行验证，不能仅用 mock 通过代替。
