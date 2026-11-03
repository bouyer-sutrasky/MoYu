# 交给 DeepSeek superagent 的开发指南

调研日期：2026-11-03。本文是新项目开发任务，不是现有 Harness 的安装教程。用户会新建专门 GitHub 仓库；本次只生成指南与交接资料，没有创建 GitHub Issue、发布代码、安装软件或改动服务器。

## 先读结论

可以让现有 superagent 开发，但要先解决“它目前只监听旧仓库”这一启动问题。新仓库里直接 @ 专用账号不会自动改变监听范围。先在现有监听仓库提交引导任务，准备新仓库独立实例，然后在新仓库逐阶段派发工作。已有运行实例继续服务原仓库。

新项目包含网页、API、调度服务，以及受控 superagent 补丁。新增 Source 不是稳定公共 SDK，停止继续、任务模型与统一执行门控也不是现成配置项，不能只做前端壳。

## 已核实环境与实现调整

| 环境 | 实测 | 对开发的影响 |
| --- | --- | --- |
| 本地 Windows | Node 25.2.1、pnpm 12.15.0、Git 2.45.2；当前 PATH 无 Docker | 本地可做代码与前端检查；数据库、Linux 资源和隔离验收放到独立 Linux 环境。不能把缺工具假设为已安装。 |
| 京东云 | Ubuntu 24.04.2、4 vCPU、约 16GB RAM、约 43GiB 可用磁盘 | 两在线仓库为初始容量目标；构建与子进程一起计量。 |
| 现有运行时 | Node 22.23.3、pnpm 10.34.7、Harness 0.2.1-rc.2、superagent 0.1.0 | 保留现有运行时；新平台建议隔离使用 Node 24 LTS，不能全局升级替换当前 dsh。 |
| 服务与网络 | Nginx 已持有 80/443；原 agent 127.0.0.1:3082；Docker 未安装 | 复用 Nginx 新增独立站点。此前 Caddy 方案撤回；Docker 是待准备依赖。 |
| 原 agent | root 下 oneshot + tmux；部署无 .git | 新服务采用非 root 和可追溯制品。不能把现有 root 运行方式复制成新平台权限模型。 |
| 原仓库 | 落盘配置指向 sutrasky/personal-ui-assets | 新仓库需独立配置；此读取可能落后 WAL，部署前用受支持接口核对。 |
| 专用账号 | 历史记录为 Bouyer12，请求者 sutrasky | 当前登录身份、权限和允许名单未现场重新认证确认；发 Issue 前必须核实，不把历史记录当授权凭据。 |

详细证据见 research/ 下报告。当前安装 commit 无法从元数据确定，已记录入口及锁文件摘要；这些摘要不能冒充 Git commit。

## 新仓库如何组织

建议名 `superagent-workspace`，名字由用户决定。用户先创建仓库并授予专用账号写权限，上传 repo-kit 的内容成为初始化提交。数据库、token、Passkey、SSH 配置、服务器 profile 和原始环境变量均不入仓。

目标结构：

```
apps/web/                    React/Vite/CSS Modules
apps/api/                    Fastify：鉴权、消息、事件、仓库
apps/dispatcher/             数据库投递、实例准入与恢复
packages/contracts/          Zod 请求/事件/Bridge schema
packages/db/                 Drizzle schema/migrations
packages/theme/              固定来源的 Harness design tokens
packages/runtime-client/     仅消费本项目 Bridge 协议
integrations/superagent/     pinned upstream lock、补丁、构建与契约测试
deploy/                     Compose、systemd slice、Nginx 示例
docs/                       本指南、接口、产品要求、验收证据
```

平台使用 React + Vite + TypeScript + CSS Modules + clsx + TanStack Query；API 用 Fastify/Zod；PostgreSQL/Drizzle 保存业务与可靠投递。用 SimpleWebAuthn 实现 Passkey。平台独立锁定 Node 24 与 pnpm 版本，提交 lockfile；不要拿本机全局 pnpm 版本作为项目约束。

原 Harness 兼容性先按现有 0.2.1-rc.2 隔离复现；上游快照声明 pnpm 11.7.0、Node ^22.19.0 || >=24.0.0、DSH ^0.2.1-alpha.2，部署文档又引用 rc.3。必须先跑兼容性测试，再锁定真正工作的组合，不能凭版本号相近宣布兼容。

## 上游补丁管理

选择已验证 commit，下载或 checkout 到构建缓存，记录 URL、完整 commit、内容摘要、许可证。对已部署无 .git 目录先做只读比较，不能原地替换。新仓库维护有序 patch 文件与应用脚本；patch 失败必须停止构建，不能模糊套用。生成包只安装到新 profile。

Workspace Source 直接在受控上游源码树实现，沿用内部相对导入；避免虚构 `@deepseek/superagent-sdk`。需要改动的最小面包括：Source/Bridge、持久化人工暂停、任务模型、执行准入和状态投影。补丁与业务页面分开，升级时运行 `pnpm check` 及跨进程契约测试。

## 阶段与交付门槛

### 0. 引导新仓库与兼容性取证

先完成 repo-kit 上传及账号授权。在旧仓库发引导 Issue（ISSUE-PLAN.md 提供文案），明确跨仓库目标。新建独立 bootstrap profile，使用非 root 身份、单独状态/工作目录/端口，仅监听新仓库。通过受支持 setup 流程生成配置，谨慎迁移必要模型配置，不复制整份 root home 或 credentials。

初始化需要管理员配置服务与凭据；若 agent 当前策略不允许跨仓库或管理员操作，交付具体部署步骤给操作者执行，不能声称在旧 Ticket 已获得任意仓库权限。允许名单由操作者配置。

新实例仍用未经 Workspace 补丁的稳定版本开发本项目。后续被测实例另设 profile、状态及测试仓库，不能让 agent 热替换自己的 worker/runtime。bootstrap 实例常驻开发时也占同机总预算；先串行真实测试，避免突破两实例目标。

完成条件：新仓库里由允许的人 @ 专用账号，能够产生正确仓库的任务和测试 PR；旧实例不变；提交脱敏 `docs/environment-baseline.md` 与 `integrations/superagent/upstream.lock.json`，后者含真实确认的版本/commit/摘要，不留伪造值。

### 1. 工程与数据库骨架

创建上述 workspace、锁版本、CI、schema、migrations、最小健康检查和结构化日志。至少实现 owner/credential/session/challenge、repositories、conversations、messages、task_links、deliveries、events、runtime_leases、artifacts；凭据摘要与秘密字段分离。

完成条件：干净 checkout 可按 README 构建；真实 PostgreSQL 上迁移与重复投递约束通过。脚本区分 `check`、`test:integration`、`test:e2e`；缺依赖应明确失败或标为未执行，不输出伪成功。

### 2. Passkey 与主题外壳

实现一次性绑定码 CLI、注册/登录/撤销会话；React 三栏界面、仓库导航、活动入口、设置及 Chat 占位。正文消费固定上游主题变量，记录来源和许可证。前端功能按钮必须对应真实 API，暂不可用的能力显示禁用原因。

完成条件：真实浏览器注册和登录成功，challenge 重放被拒绝；撤销会话使已有 SSE 和附件访问失效。桌面/手机截图验证布局；刷新保留登录。锁定正式域名后才注册长期 Passkey，测试域名使用测试凭据。

### 3. 单仓库消息闭环

新增 workspace Source、机器鉴权 Bridge、消息入库/投递、Channel 回执与持久事件流。实现任务绑定、上下文读取与模型选择；先不开放只读讨论按钮直到阶段4验收。

完成条件：真实消息→Trigger→Ticket→worker→提问→回答→测试→PR。相同 clientMessageId 重发不重复建单；API/Bridge 重启后消息无丢失；SSE 重连补齐事件。禁止用 mock 回复充当验收。

### 4. 执行控制与多入口

独立只读讨论环境在用户确认后移交 worker；执行中补充在下一步骤消费。新增可恢复的人工暂停：UI 叫停止，内部不得调用上游终态 stop 代替。保持 Ticket/worktree 关系、记录停止完成证据，恢复重新取得租约。GitHub 任务导入 Work，原生 GitHub 与 Web 回复按来源路由，过滤自身回声。

完成条件：讨论无法写文件、获取写凭据或启动任意命令；停止后进程确实结束；继续保留现场；GitHub 和 Web 重复事件不重复执行；PR 关闭但未合并不误报成功、不自动重开。

### 5. 两仓库与资源控制

受限 supervisor 根据 repositoryId 管理固定模板实例，不执行前端传来的任意 shell/path。覆盖所有 launch/wake/recover 路径的租约门控，同仓库串行、两实例在线；不能靠 maxWorkers=1 规避上游人工输入额外 worker 名额。

全系统常态预算6GB、空闲可扩至8GB，目标4GB需测量。原 root agent 在新系统边界外，但计算宿主余量时仍必须算其影响。平台、DB、bootstrap/测试与最终仓库实例的同机工作全部纳入开发预算说明，禁止额外测试实例隐性绕过额度。

完成条件：第三仓库排队或淘汰真正空闲实例；人工回复优先但不抢占；休眠显示 GitHub 监听暂停；子进程内存计入限额；资源不足受控失败且不会循环重启。

### 6. 完整交付与部署

完成截图/文本附件、diff/测试/PR面板、页面打开时系统通知、历史搜索与清理设置。7天清理仅对已合并且无未保存修改的 worktree。正式部署前备份和验证恢复，提交不覆盖现有站点的 Nginx 配置并 `nginx -t`。

完成条件：公开 HTTPS → Passkey → 选择仓库 → 新任务 → 回答问题 → PR 的真实端到端验收；整机重启不恢复已停止任务；能回滚平台与插件版本，数据库迁移回滚用已验证备份策略。交付运行手册、验证命令、日志位置与已知限制。

## 部署实现建议

复用宿主 Nginx，给新平台配置独立域名；反代到新回环端口，API/SSE 同源，SSE 关闭代理缓冲并设置心跳和合理超时。数据库和 Bridge 不对公网监听。

新平台使用隔离 Node24 镜像；上游 runtime 使用阶段0确认的版本镜像。Docker/Compose 需管理员准备，不在当前调研自动安装。若选择 systemd 运行，也必须先验收只读挂载、凭据与进程资源隔离，不能把工作目录当沙箱。

宿主 systemd 创建专用 slice，设置聚合 `MemoryMax=8G`，各容器通过实际验证过的 cgroup parent 进入共同树；用 `memory.current`、容器/子进程归属和宿主 MemAvailable 验证，不能仅把多个容器各设8GB。6GB用于调度决策，不做误阻止扩展的硬上限。Docker daemon本身常驻开销单独在宿主余量里核算。

所有者CLI保存/轮换凭据；网页和worker均不能任意控制Docker socket。宿主supervisor仅接收仓库ID与允许的start/stop/inspect指令，认证调用者，使用固定路径和模板。

## 完成报告格式

每阶段 PR 写：实现范围、真实接口依据、运行过的命令与结果、未验证项、迁移与回滚步骤。涉及部署要附健康检查与实际行为证据，不以“进程启动成功”代替消息闭环。不把未来阶段的 mock 页面标为功能完成。
