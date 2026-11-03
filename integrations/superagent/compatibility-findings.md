# 上游兼容性取证与补丁前差异

本文配合 [environment-baseline.md](../../docs/environment-baseline.md) 和 [upstream.lock.json](upstream.lock.json)。所有路径与行号均相对固定 commit `6337fc823ce20251c8de8085948165c81aaa701e`；运行时类型行号相对现场安装的 `@deepseek-ai/dsh@0.2.1-rc.2`。

## 0. 结论

固定组合在以下范围内**可继续开发**：

- 上游 Source 的注册、scope、`receive`、Channel、Policy、ThreadContext 接口完整，可以在同一源码树内新增 workspace Source；没有公共 Source SDK，也没有 `@deepseek/superagent-sdk`。
- Session 的持久事件足以构建“已交付 / 已读 / 进展”投影；但读取证据必须等 `user/message` 落盘，不能把 `agent/inbox/claimed` 或 HTTP 202 当作已读。
- 上游 stop 是**终态**，retry 是**新 Assignment**；两者都不能直接实现本项目“停止后继续”的持久暂停。必须新增 Ticket 暂停状态、停止完成信号和恢复准入。
- 模型是实例级角色默认（Eval / Executor），没有“每个 Ticket 固定模型”的字段；需要在 accept 时冻结模型并让 worker Session 使用它。
- 执行准入目前是进程内 `WorkerSlots`；没有宿主租约/围栏，也没有覆盖 launch、投递唤醒、恢复、人工额外 slot 的统一门控。
- GitHub Source 使用**仓库级** notifications（`Commands.api` 把路径限定到 `repos/<repository>/`），不是账号级 all-repositories 流；两个不同仓库的实例不会互吞通知。账号未读状态不会被轮询消费。

因此后续补丁的目标范围是：workspace Source、机器 Bridge、可恢复暂停、任务模型、统一执行准入；五项都需要落在受控 fork 中，并按本文 §8 的顺序应用。

## 1. 固定组合与构建

| 项 | 固定值 |
| --- | --- |
| superagent commit | `6337fc823ce20251c8de8085948165c81aaa701e` |
| superagent tarball | SHA-256 `31402e86aed27ef173d47d1eb8e36fd7baaf818050dbcdf8ebb8c59caf083659` |
| Harness npm | `@deepseek-ai/dsh@0.2.1-rc.2`，tarball SHA-256 `40e3d025…` |
| Harness 上游 tag/commit | `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317` |
| 构建工具链 | Node 22.23.3；`pnpm@11.7.0`（corepack）；系统 pnpm 10.34.7 仅用于 profile 链接 |
| 重建结果 | `typecheck` 通过；`build` 通过；`lib/` 12 个文件与安装版逐文件一致 |
| 上游测试 | 1196/1197 通过；1 条可选 Feishu 测试失败（见 environment-baseline §6） |

### 1.1 运行时依赖是混合图

`tsdown.config.ts:10` 把 `@deepseek-ai/*`、`zod`、`proper-lockfile` 作为 external；bundle 的 `lib/` 会从自己的 `/root/dsh-superagent/node_modules` 解析这些包：

| 直接运行时导入 | bundle 解析版本 | Harness 宿主版本 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | 4.0.5-alpha.1 | 4.0.5 |
| `@deepseek-ai/dsh-llm` | 0.2.1-alpha.2 | 0.2.1-rc.2 |
| `@deepseek-ai/dsh-scope` | 0.2.1-alpha.2 | 0.2.1-rc.2 |
| `zod` | 4.4.3 | 宿主内部依赖另有版本 |
| `proper-lockfile` | 4.1.2 | 宿主未提供 |

这意味着编译期 `devDependencies` 是 alpha.2，运行期主机是 rc.2，而部分直接导入仍走 alpha.2。隔离 profile 已实际加载并完成 Source 轮询，但没有覆盖所有 rc.2 API 路径。**补丁原则**：新增代码尽量只依赖 Cordis `ctx` 服务（`sessionController`、`llm`、`webServer`、`subprocess` 等）和本仓库相对导入；若必须直接导入 rc.2 才有的符号，应先把 bundle 相关依赖对齐到 rc.2，并重跑 `pnpm check` 与隔离 profile 契约测试，不能只凭类型检查通过。

## 2. Source 内部类型与 workspace Source

### 2.1 真实接口

| 接口/字段 | 位置 | 作用 |
| --- | --- | --- |
| `SourceKind<C>` | `src/sources/kind.ts:85-115` | `kind`、`title`、`description`、`schema`、`fields`、`health`、可选 `scope`、`channel`、`threadContext`、`find`、`repliesTo`、`policy`、`refreshLabels`、`environment`、`facts` |
| `SourceChannel<C>` | `src/sources/kind.ts:46-54` | `send(host, message)` 返回 `'sent' \| 'gone'`；`allowed(address, config)`；`link(address, links)` |
| `ThreadContext<C>` | `src/sources/kind.ts:56-76` | 只读上下文分页；`messageId(trigger)`；`read(thread/root/parent)` |
| `SourcePolicyPart` | `src/sources/kind.ts:28-42` | `allowed`、`explicit`、`rows`、可选 `bots`、`sync` |
| `SourceContext` | `src/sources/host.ts:31-67` | `receive`、`state`、`threads`、`tickets`、`notify`、`report`、`atomic`、`config`、`commands`、`deployment` |
| `SourceHost` | `src/sources/host.ts:23-29` | `sources.register(kind)` 与 `context(kind)` |
| 注册 | `src/sources/registry.ts:31-42` | 注册返回卸载函数；health 名唯一；`sync:` 前缀保留 |
| scope | `src/sources/registry.ts:112-120` | 未注册/禁用/未列出时 `listened:false` |
| 发送 | `src/sources/registry.ts:167-174` | 经 kind 的 Channel；未安装时 `waiting`，无 channel 时 `gone` |
| Source 聚合上下文 | `src/app/source-context.ts:11-27` | `receive` 返回 `ReceiveResult \| Promise<ReceiveResult>`；`configured()` 之后 Source 才轮询 |
| 接收 | `src/app/passes.ts:34-39` | `Engine.receive` 同步入库；`stored` 才调度下一轮 pass |
| `ReceiveResult` | `src/core/intake.ts:8` | `'stored' \| 'duplicate' \| 'filtered'` |
| 入库 | `src/core/intake.ts:19-56` | 先过滤/去重，保存 Trigger 与 Disposition，fan-out 到订阅 Ticket，再排 Eval |
| Trigger | `src/core/model.ts:23-38` | `id/source/threads[0]/actor/human/addressed/at/text/channel/url/meta` |
| ChannelRef | `src/core/model.ts:8` | `{ source, thread, address: Record<string,string> }` |
| OutboundMessage | `src/core/ports.ts:72`、Outbox `src/app/outbox.ts` | 由 `id` 幂等；重试由 Effects 驱动 |

插件入口模式（GitHub 示例）：

```ts
export const name = 'dsh-superagent-github'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(githubKind), 'github: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, githubKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
    return async () => { controller.abort(); await running }
  })
}
```

见 `src/sources/github.ts:110-122`。构建入口在 `tsdown.config.ts:10`（`github-watch`/`feishu-watch`），包导出在 `package.json:17-18`，bundle 插入在 `cordis.patch.yml:7-12`。

### 2.2 workspace Source 的精确差异

新增/修改文件（受控 fork 内，沿用相对导入）：

| 文件 | 变更 | 依据/注意 |
| --- | --- | --- |
| `src/sources/workspace.ts`（新） | 实现 `SourceKind<WorkspaceConfig>`：`kind:'workspace'`、`schema`、`fields`、`health:['workspace']`、`scope`、`channel`、`threadContext`、`policy`、`environment` | 照 `src/sources/github.ts:38-109` 的结构；不要虚构公共 SDK |
| `src/sources/workspace-trigger.ts`（新，可选） | 把 Bridge 请求转换为稳定 `Trigger`：`id`、`threads`、`actor`、`human`、`addressed`、`at`、`text`、`channel`、`meta` | 字段照 `src/core/model.ts:23-38`；ID 用 `key(...)`（`src/core/ids.ts`）保证重投幂等 |
| `src/sources/workspace-channel.ts`（新，可选） | `send` 调 Bridge 回调，返回 `sent/gone`；临时失败抛出；按 `message.id` 幂等 | 照 `src/sources/github-channel.ts:14-44` 的 marker/幂等模式 |
| `tsdown.config.ts:10` | 加 `'workspace-watch': 'src/sources/workspace.ts'` | 否则包内没有可加载入口 |
| `package.json:17-18` | 加 `"./workspace-watch": "./lib/workspace-watch.js"` | 与 `lib` 产物名一致 |
| `cordis.patch.yml:7-12` | 插入 `dsh-superagent-workspace`（`name: dsh-superagent/workspace-watch`） | 与 GitHub/Feishu 并列；默认关闭或由 profile 打开 |
| `src/app/http.ts` 或 `src/app/bridge.ts`（新） | 机器 Bridge 路由；不能复用同源面板路由作为机器协议 | 见 §3/§8 |
| `src/app/runtime.ts:203`、`src/index.ts` | 注册 Bridge/新 Source 所需 host | 只在受控 fork 中做 |

关键约束：

- `SourceContext.receive` 是**入库入口**，不是“worker 已接受”。返回 `stored` 只表示记录；Eval/Ticket 是异步的（`src/app/passes.ts:34-39`、`Engine.receive`）。Bridge 的 `202` 只能标 `stored/delivering`，不能标 `read/delivered`。
- `scope` 必须只依赖 `meta` 和配置；resume 重新校验 `listened`，不要求 `observed`（`docs/008-cookbook.md` §4）。
- Channel `send` 必须幂等，临时错误抛出交给 Outbox 重试；`gone` 只用于永久不可达（`registry.ts:167-174`、`Outbox` 重试策略）。
- `SourceKind.environment.values` 不应包含凭据（`kind.ts:104-109`、`execution-environment.ts:1-60`）。workspace Source 需要自己的 `DSH_SUPERAGENT_WORKSPACE_*` 变量时，只能放非秘密 ID/URL。
- 不要直接读写上游 SQLite；Source 只能通过 `SourceContext` 暴露的 store 投影。否则升级会破坏迁移。

## 3. Session 事件与读取证据

### 3.1 上游实际使用的事件

| 事件 | 订阅位置 | 用途 | 是否持久 |
| --- | --- | --- | --- |
| `session/event` | `src/app/sessions.ts:114-120`、`src/executor/dsh.ts:495-504` | 模型/预算重试、`user/message` 读取证据、后续 `agent/error` 处理 | 事件由 Session 持久化；`session/event` 在 append 时发出 |
| `agent/status` | `src/app/sessions.ts:133-135`、`src/executor/dsh.ts:479-487` | idle/running；turn 结束/后台作业判定 | 运行态，不单独持久 |
| `agent/inbox/claimed` | `src/executor/dsh.ts:489-492` | 人直接在 worker Session 输入；判断“人启动的 turn” | 不持久；只是认领瞬间 |
| `agent/error` | `src/executor/dsh.ts:505-511` | 瞬时错误重试 / 失败报告 | 错误本身不保证持久 |
| `agent/created` / `agent/disposed` | `src/app/sessions.ts:110-121` | 装饰/清理 | 运行态 |
| `agent-preset/selected` | `src/app/sessions.ts:124-131` | 防止 Web UI 把 worker 切成默认 preset | 运行态 |

DSH rc.2 的权威声明：

- `agent/status`：`dsh-agent/lib/types/runtime-types.d.ts:252-259`
- `agent/inbox/claimed`：同文件 `:277-284`
- `agent/error`：同文件 `:402-413`
- `session/event`：`dsh-session/lib/types/index.d.ts:61`
- `SessionEventMap`：`dsh-session/lib/types/types.d.ts:256-436`
- `user/message`：同文件 `:295`
- `assistant/message`：同文件 `:331-344`
- `request/header`：同文件 `:394`
- `model/selection`：`dsh-api-session-controller/lib/types/types.d.ts:33-38`

### 3.2 读取状态应如何映射

- **delivered**：消息进入 worker Session 的 inbox 并被交给该 Assignment；上游用 `Sessions.prompt(..., 'steer'|'queue')` 和 `promptedId(requestId)` 对应（`sessions.ts:162-169`）。`agent/inbox/claimed` 只能证明“被认领”，不能证明模型读过。
- **read**：`session/event` 的 `user/message` 已写入历史，且其 `message.id` 等于该 Input 的 `promptedId`；之后该 Assignment 有 report 或 turn 结束（`executor/dsh.ts:495-503` 调 `engine.inputsRead`）。`Tickets.readBefore`/`readUntil` 用这个时间判断（`core/model.ts:333-345`）。
- **progress**：`assistant/message` 的文本（`types.d.ts:331-344`）+ `turn/end.reason`（`turn/end` 在 `types.d.ts:260-272`）+ `step/end`。没有逐 token 持久保证；不要把流式增量当业务事件。
- **stop 完成**：需要 `agent/status` 转为 `idle`、`whenIdle()` 结束、后台 jobs/subagents 停止以及 `sessionPersistence.flush()`；上游 stop 目前只返回 `void`（见 §4），Bridge 必须自己等待并记录完成证据。

结论：API-CONTRACTS 里的 `delivered`、`read`、`task.progress` 可以实现，但不能把 `receive` 返回的 `stored`、HTTP 202 或本地 Outbox `sent` 当作已读。事件必须先持久化再推送；SSE 重连用持久序号/游标补齐。

## 4. stop / retry 语义与“可恢复暂停”差异

### 4.1 当前真实语义

| 行为 | 位置 | 结果 |
| --- | --- | --- |
| 面板 stop | `src/app/http.ts:193-194` → `Engine.stopTicket` `src/core/engine.ts:160` → `Tickets.stop` `src/core/tickets.ts:160-165` | `end(ticketId,'human','stopped')`，Ticket **终态**，`undelivered` 清空，`attention` 删除 |
| stop 的执行器动作 | `src/executor/dsh.ts:357-370` | `afterCommit` 中 `agent.cancel({kind:'user'},{keepInbox:false})`；`stopWork` 停 jobs/subagents；**没有返回完成 Promise** |
| stop 后的继续 | `src/core/tickets.ts:254-270`、`src/core/intake.ts:43-46` | `wake` 明确 `ticket.ended?.by === 'human'` 直接返回；human-stopped 的 Mandate 撤回。新消息不会恢复该 Ticket，只能新开 Ticket |
| retry | `src/core/tickets.ts:167-177`；`canRetry` `src/core/stage.ts:24-25` | 只对未结束且 `waitsForPerson` 或 `delivery` 失败的 Ticket；结束旧 Assignment（`endedReason:'retried'`），新建 Assignment；不是恢复同一执行现场 |
| 全局 pause | `src/app/settings.ts:202-…`；`src/executor/dsh.ts:232-235`；`src/app/runtime.ts:200` | 持久化 `paused`，把 launch/delivery effect 的并发上限降为 0；**不停止已运行的 worker**，也不是每 Ticket 暂停 |
| 重启恢复 | `src/executor/dsh.ts:519-537` | 对 open ticket 的 running Assignment 发 `assignmentInterrupted`，pending 的重新入队；不恢复已 stop/已结束的 Ticket |

因此：**不能把上游 stop 当成本项目的“停止”（可继续）**；也不能用全局 executor pause 代替人工暂停。

### 4.2 可恢复暂停的精确差异

最低改动面（均在受控 fork 中）：

1. `src/core/model.ts:277-315`：给 `Ticket` 增加持久字段
   ```ts
   paused?: { at: string; by: 'human'; reason?: string; operationId?: string }
   ```
   `ended` 仍只表示终态；`paused` 的 Ticket 仍 `liveTicket`，保留 `inputs`/`undelivered`/`execution`/`follows`。
2. `src/core/stage.ts:8-20`：`TicketStage` 增加 `{ stage:'paused'; action:'pause_stopping'|'paused' }`，在 `ended` 判断之后、`delivery/attention` 之前分类。
3. `src/core/tickets.ts`：
   - 新增 `pause(ticketId, reason?)`：设置 `paused`，**不**清 `undelivered`、不删 `attention`、不结束 Ticket；标记当前 Assignment 的停止意图；发出 `ticket.paused` 事件。
   - 新增 `resume(ticketId, admission)`：校验 `paused`、Policy `revalidate`、Source scope、lease，然后 `delete ticket.paused`，新建 Assignment，加入 `resumed` Input；不重放已读消息。
   - `wake`（`:254`）只处理 ended；paused 的 Ticket 不接受自动 Source 事件，但可记录 `input`；「显式 resume」才启动。
   - `end`（`:342-365`）对 paused Ticket 结束并清理 `paused`；不要让 `stop` 吞掉可恢复状态。
4. `src/core/engine.ts:160-166`：新增 `pauseTicket`/`resumeTicket`（或扩展 `EngineForPeople`），返回 operation id；**保留** `stopTicket` 的终态语义，供真正终止使用。
5. `src/executor/dsh.ts:357-381`：新增 `pause(ticket, assignment): Promise<void>`：
   - 取消当前 turn，但 `keepInbox: true`（与 stop 的 `false` 相反），避免丢掉排队输入；
   - 等待 `agent.whenIdle()`、`this.stopping` 完成、后台 jobs/subagents 停止；
   - 写入 `paused.stoppedAt` / `stopEvidence`（pid、job ids、session idle 时间）；
   - 把结果通过 Bridge operation 暴露，不能只发一个 HTTP 200。
   新增 `resume` 路径在 `launch`/`deliver` 前重新申请 lease（见 §6）。
6. `src/app/views/tickets.ts:61`、`src/app/views/records.ts:119-123`：状态投影和操作集合区分 `pause`/`resume`；停止后显示“已停止（可继续）”，不显示上游 `stopped`。
7. `src/app/http.ts:193-194`：保留 stop 供真正终止；Bridge 新增 `/bridge/v1/tickets/:id/pause|resume|operations/:id`（§8），不要用面板 stop/retry 冒充。
8. `src/app/migration.ts:20-36`：schema 12 迁移；旧 Ticket 没有 `paused` 即视为未暂停；回滚只删字段/忽略字段，旧版本仍可读（“未知字段”策略需确认）。
9. 测试：暂停后进程/后台任务确实结束；resume 保留 worktree/PR；自动 Source 事件不唤醒 paused；多次 resume 幂等；stop 与 pause 不混用；重启后 paused 不自动执行。

## 5. 任务模型与模型选择

### 5.1 当前模型能力

| 项 | 位置 | 现状 |
| --- | --- | --- |
| 角色模型 schema | `src/policy.ts:64` | `{provider, model, reasoningEffort?}`；不接受任意 provider 字符串外的业务字段 |
| Eval 模型 | `src/policy.ts:76-80` | `eval.model` 可空，默认继承实例 |
| Executor 模型 | `src/policy.ts:82-90` | `executor.model` 可空，默认继承实例 |
| 解析 | `src/app/role-models.ts:6-12` | `ctx.llm.resolveCallConfig`；catalog 成员不是硬限制 |
| 初始化 Session | `src/app/role-models.ts:14-35`；`src/app/sessions.ts:149-153` | 仅在新 Session 首次请求前注入 `model/selection` |
| 保存校验 | `src/app/settings.ts:156-166` | 只校验 `eval`/`executor` 模型；失败抛 `modelUnavailable` |
| 模型目录 API | `src/app/http.ts:206`；`src/app/runtime.ts:226` | `GET models` → `ctx.sessionController.modelCatalog()` |
| Ticket 字段 | `src/core/model.ts:277-315` | 没有 `model`/`baseBranch`/`baseCommit`/`executionMode`；只有 `execution.name/directory/assignment` |

### 5.2 每任务模型的精确差异

1. `src/core/model.ts:277-315`：`Ticket` 增加
   ```ts
   model?: RoleModel            // 固定于 accept；null 表示实例默认
   base?: { branch: string; commit: string }
   mode?: 'execute' | 'discuss'
   ```
   `Execution`（`:315`）只保留 name/directory/assignment；模型不进 prompt。
2. `src/sources/workspace.ts` 的 accept/trigger 接受 `executionSpec.model`；在创建 Ticket 的事务前调用 `resolveRoleModel` 校验；不可用则拒绝 accept，**不回退到未知模型**。
3. `src/app/sessions.ts:149-153`：worker 分支优先使用 `ticket.model`，其次 `settings.executor.model`，最后实例默认；Eval 仍用 `settings.eval.model`。`initializeRoleModel` 已支持“不覆盖已有 selection”，不会把已开始的模型改掉。
4. `src/executor/dsh.ts:424-470`：launch 前重新确认 Ticket 固定模型仍可用（resume 时也确认）；不一致则 blocked，不启动。
5. `src/app/settings.ts:156-166`：保存 `eval/executor` 模型时用同一 `resolveRoleModel` 校验；`GET models` 的 catalog 只作展示，不能替代运行时校验。
6. `src/app/migration.ts`：旧 Ticket 的 `model` 为 `undefined` 时沿用角色默认；不要给历史 Ticket 回填猜测的模型。
7. Bridge `/bridge/v1/models` 返回 `modelCatalog` 的白名单字段（provider/model/reasoningEffort/displayName），不返回 API key；平台只保存标识。
8. 测试：不可用模型拒绝；已开始任务改配置不改变其模型；resume 使用原模型；模型不可用不回退；跨 provider 的 reasoning effort 不非法传递。

## 6. 统一执行准入

### 6.1 当前门控

- `WorkerSlots`（`src/executor/dsh.ts:171-199`）是进程内 Map，`reserve` 同步预留；`maxWorkers` 来自 `settings.executor.maxWorkers`（`src/policy.ts:89`）。
- `Effects` 的 `launch` 上限为 `slots.launches()`，`delivery` 上限为 4；processing paused 时都为 0（`dsh.ts:227-235`）。
- 覆盖路径：`launchQueued`（`:270-284`）、`deliverQueued`（`:290-328`）、`launch`（`:424-470`）、`resume`（`:519-537`）、瞬态 `resumeAfter`（`:544-576`）、`workerIdle` 后台（`:601-672`）、`handOff`（`:588-600`）。
- 人工消息有额外 1 个 slot（`slots.reserve(ticketId,'person')`，`:192-195`、`:305-309`），这是上游已有行为。
- 没有宿主租约、fencing token、跨进程互斥；两个进程可以同时启动同一仓库（同一 stateDir 有 `proper-lockfile`，所以同一 state 会互斥，但不同 state 指向同一仓库不受限制）。
- GitHub 与 workspace Source 都走同一个 `DshExecutor`，但入口不在宿主层统一；Bridge 无法阻止绕过平台的 GitHub Source 启动。

### 6.2 精确差异

1. 新增 `src/app/leases.ts`（或宿主 supervisor 接口）：`acquire(repositoryId, ticketId, {fencing})`、`renew`、`release`、`verify`；lease 持久化，带 fencing token 和过期时间；不能仅凭时间启动第二个 worker，先证明旧执行已停止。
2. `src/executor/dsh.ts` 的 `launchQueued`、`deliverQueued`、`resume`、`resumeAfter`、`handOff` 统一走 lease：在 `slots.reserve` 之前/之后、`sessions.ensure` 之前、`prompt` 之前校验；失去 lease 立即停止本次启动。
3. 同仓库串行、跨仓库并行：`maxWorkers` 保留为全局上限；新增每仓库 `maxExecutions=1`；lease key 为 repositoryId；人工回复优先但不抢占已运行任务（额外 slot 只对同一 Ticket 的 wake 生效）。
4. 睡眠/唤醒：进程停止前释放 lease 并记录“已停止”证据；恢复时重新 acquire，失败则 blocked，不自动循环。
5. Bridge 的 pause/resume/stop 都要返回 operation 并持久化结果；宿主 supervisor 只接受 repositoryId + 允许的 start/stop/inspect，不接受任意 path/shell。
6. 测试矩阵：同仓库第二任务排队；不同仓库并行；人工回复使用额外 slot；lease 失联不双执行；进程重启不恢复已 stop/paused；第三仓库排队/淘汰；maxWorkers=1 不能掩盖人工额外 slot。

## 7. 两实例 GitHub 账号通知行为

### 7.1 代码路径

- `src/sources/github.ts:298-343`：`pollNotifications` 使用 `notifications?all=true&per_page=50&since=…`。
- `src/infra/commands.ts:117-121`：`Commands.api` 把路径限定为 `repos/<repository>/…`，所以实际请求是**仓库级** `repos/<owner>/<repo>/notifications`，不是账号级 `/notifications`。
- `:318-324` 仍按 `notification.repository.full_name` 过滤（冗余保护）；`:341` 原子写 `KV.github.since`；`:344-374` 读 Issue/PR；`:384-403` 读评论并过滤 agent 自己的评论（`:397`）。
- `src/sources/poll.ts:17-18`：`cursorAt` 回退 5 秒，配合稳定 Trigger ID 去重。
- 没有 `PATCH /notifications` 或标记已读的调用；轮询不消费账号未读状态。
- 每个 stateDir 有独立的 `github-since`、`github-cursor:<n>`、`github-retry`（`src/kv.ts` 的 KV family），实例间不共享。

### 7.2 实测

详见 environment-baseline §5.2 与 `probes/github-notification-probe.md`。要点：

- A 仓库 3 条真实 bot 评论（含停机期间 1 条）→ A 3 个 Trigger，3 个 `ignore/not_human` Decision；B 仓库启动前 1 条未读（新实例不补历史），启动后 1 条 → B 1 个 Trigger，1 个 Decision。
- 两个实例的 Trigger URL 只指向自己仓库；没有交叉。
- 本轮通知由 `github-actions[bot]` 产生，验证的是通知路由/隔离；没有第二个人类账号在隔离仓库制造人工 @。人工 explicit 的实例行为由 bootstrap 接到 `sutrasky` 的 issue #1 证明（本 ticket 的来源）。
- A 停机期间的通知在重启后补收，且没有重复 Trigger。
- 轮询后账号级 `gh api notifications` 仍有 3 条未读（两个测试仓库 + MoYu），证明实例不标记已读。
- 通知相对评论有约 15–25 秒延迟；本次 5 秒回退覆盖了实验中的边界，但没有证明更长延迟/限流下不丢事件。

### 7.3 判断与限制

- **不要**把 GitHub Source 改成账号级通知轮询；当前仓库级路径已经是更安全的隔离方式。若平台需要跨仓库集中收件，应另做宿主级 dispatcher，而不是让每个实例读账号级流。
- 同一仓库**不能**跑两个实例：stateDir 锁只保护同一 state；两个 state 指向同一仓库会各自接单。必须用 §6 的 repository lease 阻止。
- 新实例不补启动前的历史；休眠实例重启会从持久化 `since` 补收。平台 UI 必须显示“监听暂停”与补收范围，不能承诺任意历史。
- 账号共享的 rate limit、通知保留期、`all=true` 分页和 410/404 语义仍需在阶段 3/4 用真实长跑验证；本 M0 只覆盖一次短窗口。

## 8. 补丁落点、顺序与契约测试

建议在 `integrations/superagent/patches/` 中按顺序维护，构建脚本在 `git apply` 失败时必须停止：

| 顺序 | 补丁 | 文件/锚点 | 依赖 | 最低契约测试 |
| --- | --- | --- | --- | --- |
| P1 | workspace Source + Channel + ThreadContext | §2.2；`cordis.patch.yml:7-12`、`tsdown.config.ts:10`、`package.json:17-18` | 固定 commit | 重投同 ID 只入库一次；scope 过滤；Channel 重试不重复；Source 禁用不接单 |
| P2 | 机器 Bridge（认证、capabilities、events、tickets、models） | `src/app/http.ts:75-79,230-247` 的同源约束不能复用；新增 `src/app/bridge.ts` + `runtime.ts:203` 注册 | P1 | 非机器身份 401/403；同源面板路由不暴露给机器；事件游标补发；重复回调幂等 |
| P3 | 可恢复暂停 | §4.2；`core/model.ts`、`core/tickets.ts`、`core/engine.ts`、`executor/dsh.ts`、`views/*`、`migration.ts` | P1/P2 | 停止完成证据；resume 保留现场；自动事件不唤醒；重启不自动恢复 paused；stop 不混用 |
| P4 | 任务模型/分支/执行模式 | §5.2；`core/model.ts`、`sessions.ts:149-153`、`executor/dsh.ts:424-470`、`settings.ts:156-166`、`migration.ts` | P2 | 不可用模型拒绝；固定模型；resume 同模型；不回退 |
| P5 | 统一执行准入/租约 | §6.2；`app/leases.ts` 新、`executor/dsh.ts:171-199/270-284/290-328/424-470/519-537/544-576`、宿主 supervisor | P1–P4 | 同仓库排队；两仓库并行；人工回复优先；lease 失联不双执行；重启恢复边界 |

顺序理由：P1 定义入口；P2 给平台一个受控机器面；P3/P4 需要持久 Ticket 字段与迁移；P5 覆盖所有启动路径，必须最后做（否则前面的路径会绕过租约）。

上线前门槛：

- 固定 commit 的 `pnpm check`（在干净环境）与新增契约测试；
- 隔离 profile 的 Source→Trigger→Decision 实测；
- 真实任务闭环：测试仓库真实 Issue → worker → PR（不能用 mock）；
- 暂停/恢复、重启、同仓库串行、两实例隔离各一组真实证据；
- 任何补丁冲突都停止构建，不做模糊 `patch -p1` 套用。

## 9. 未验证项（与本文件相关）

- 未实现 P1–P5，只有差异与落点。
- 未在隔离 profile 跑真实模型请求、真实 worker、真实 PR。
- 未实测 stop/retry 的完整停止证据、恢复和后台作业清理。
- 未实测宿主 lease/fencing；§6 是设计差异，不是已验证实现。
- 未实测同仓库双实例、长时通知延迟、限流、通知保留期。
- Feishu 路径有 1 条上游测试失败；如果后续启用 Feishu，需要先修复/隔离该测试。
- 运行时依赖是 alpha.2/rc.2 混合图；新增直接导入必须先做 API 对照与隔离测试。

## 10. 复核入口

- 机器可读摘要：[upstream.lock.json](upstream.lock.json)
- 环境、隔离实验与清理：[environment-baseline.md](../../docs/environment-baseline.md)
- 现场 bootstrap 只读检查：`curl -sS -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state`（不要 POST，不要重启）
- 固定 commit 的源码：`/root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2`（取证缓存，可删）
