# Superagent 接口核对

依据为本地上游源码快照 E:/workplace/dsh-superagent-research/upstream/dsh-superagent-prototype-main。下文路径相对此目录。快照未确认 Git commit，也未连接京东云。正式集成前记录云端 Harness 版本、superagent 提交及本地改动，再对照核验。

## Source 与 Bridge

- `src/sources/kind.ts:85` 定义 `SourceKind<C>`，包括配置 schema、表单、健康、准入规则、channel 与 threadContext。Channel 是 kind 提供的出站适配器（同文件第 45 行），按持久化的 ChannelRef 发消息；`src/app/outbox.ts` 通过 Effects 重试，接收端须按 OutboundMessage ID 幂等。
- 参考 `src/sources/github.ts:113`，Cordis 插件通过 `ctx.effect(() => ctx.orchestrator.sources.register(kind))` 挂载，register 返回卸载函数。以 `sourceContext(ctx.orchestrator, kind)` 取得上下文，等待 ready、检查 configured 后调用 `await context.receive(trigger)`。签名是 `ReceiveResult | Promise<ReceiveResult>`，返回代表入口接收结果，准入后仍有异步评估。触发器与 Thread 的稳定 ID、Actor、ChannelRef 参见 `src/core/model.ts` 和 `docs/008-cookbook.md`。同一网页请求重投保留相同 Trigger ID，接单映射由持久化投影确认。
- `package.json` 标为 private，exports 没有 sources 子路径。`src/index.ts` 公开插件入口、部署类型及 core，SourceKind/SourceContext/宿主 Cordis 扩展留在内部。可在受控 fork 同源码树实现 Workspace Source，再由项目仓库部署固定构建；若需要独立编译插件，在受控版本显式导出类型/宿主契约并做联动测试。Cookbook 使用相对源码导入，没有公共 Source SDK 承诺。
- `src/app/http.ts:75,193,194,230` 将面板操作放在 /orchestrator/api/，要求 127.0.0.1 和同源请求。面板 stop/retry 的 JSON 返回代表调用了 Engine 操作。应新增受限 Bridge，平台持有机器身份，只允许必要操作；浏览器由平台 Passkey 会话鉴权。面板路由与同源判断不足以承担跨服务认证。

## 执行语义

- `src/app/sessions.ts:104–173` 观察 session/event 与 agent/status，内部 prompt 接收 requestId 与 queue/steer/inject 模式，并可由 promptedId 获取对应消息 ID。 `src/executor/dsh.ts:476–515` 观察 agent/inbox/claimed 和 session/event，区分认领与写入历史。第一版可用持久化事件序号构建进度投影，阅读状态用实际消费证据；逐 token 能力待 Harness 版本及事件持久性核验。
- `src/core/engine.ts:160–166` 有 stopTicket/retryTicket。 `src/executor/dsh.ts:357–385` stop 返回 void，取消 turn 并异步停止 shell jobs、subagents，内部跟踪停止过程，新 launch/投递等待停止。网页“已停止”需要 Bridge 的完成证据；显式继续应测试当前 Ticket 阶段与原 Assignment/worktree 关系，retry 是新 Assignment 语义。停机的 keepInbox 行为与任务 stop 不同（同文件第 388 行）。
- `src/app/role-models.ts` 以角色默认配置，在尚未选择时追加 model/selection。`cordis.patch.yml` 安装 worker/router presets。网页按任务选择模型需要把允许的 Harness 模型标识贯穿 Ticket 到 worker 创建与重启；运行前验证模型可用。只读讨论须独立工具、只读挂载、隔离写凭据，确认后转受控执行 Session。当前资料没有原位权限切换的依据。
- `src/executor/dsh.ts:168–203,229–232,263–327,567` 在进程内 WorkerSlots 同步预留并控制 Effects launch；有 person 恢复和错误后 wake 路径。需要在共享入口对 launch、投递唤醒和恢复加宿主租约，覆盖 GitHub 同一条执行通道；仅设置 Web 队列无法覆盖。全局在线数属于宿主，停止进程前需要检查并追踪保留的后台任务（同文件第 584 行）。

## GitHub 与安装

- `src/sources/github.ts:274–342` 首轮读 notifications?all=true，按部署 repository 过滤，使用各实例持久化 since/retries 和线程游标。该轮只读 GitHub notifications，不消费远端未读标记。共享账号仍需两实例同跑验收通知分页、速率、@、自己的发言过滤、停机期间事件与本地状态隔离。重试超过 24 小时会放弃该轮的坏线程；后续通知或轮询有机会再读取。
- `package.json` 的 check 依次 typecheck、test、build，build 用 tsdown。按 `docs/006-deployment.md:72–89` 安装依赖并构建，使用 `dsh plugin --profile superagent add "link:$PWD"` 连接构建目录。首次初始化才用 from-default-profile；文档说明它会覆盖既有配置，升级不得用它。文档给定 CLI 版本为 0.2.1-rc.3，源码 dev dependencies 多为 0.2.1-alpha.2，固定部署前需核对真实组合。

## 薄补丁边界

- `src/core/intake.ts:8` 的 ReceiveResult 是 `'stored' | 'duplicate' | 'filtered'`。`src/sources/kind.ts:46` 的 SourceChannel.send 接收 `Pick<SourceContext, 'commands'>` 与 OutboundMessage，返回 `Promise<'sent' | 'gone'>`；临时失败抛出以便重试。link 接收 address 与 ChannelLinks，返回 ChannelLink。
- 已有面板可读 `GET /orchestrator/api/tickets` 和 `GET /orchestrator/api/tickets/:id`，可写 `POST /orchestrator/api/tickets/:id/stop`、`POST /orchestrator/api/tickets/:id/retry`、`POST /orchestrator/api/executor/pause`。pause 是全局配置。 `src/core/tickets.ts:160–180` 中 stop 结束 Ticket；retry 仅适用开放、失败或受阻或投递失败的 Ticket，并启动新 Assignment。实现保留 Ticket 的人工暂停时须新增持久化生命周期及恢复门控；复用终态 stop 会丢失同一 Ticket 的继续语义。
- 把平台留在独立项目。受控上游构建只承载 Workspace Source、私有 Bridge、持久化暂停状态与完成信号、worker 模型选择和统一执行准入，具体拆分以固定版本代码为准。先讨论用独立只读 Session；执行授权后将讨论摘要与计划转给新的 worker。外部 Source 插件可减少 Source 文件改动，仍需要本地版本暴露受支持的宿主契约，且生命周期和准入补丁仍需留在 fork。
