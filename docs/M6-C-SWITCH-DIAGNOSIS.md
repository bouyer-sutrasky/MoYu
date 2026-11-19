# M6-C 在线切仓诊断与可验证替代路径

更新时间：2026-11-19。范围是 Issue #87 第 2 项，基线 `e6470da1031946eba23aa40913227025dfee971a`。

## 1. 现场现象

工作台已切换仓库时，目标仓库的运行时若不在线，界面停留在「启动中」，
无法区分是在等在线名额、准备仓库副本还是启动进程，也没有已用时或失败后的
直接重试入口。现场两个动态实例（`m6c-2`、`m6c-3`）因为 GitHub 账号校验失败
进入 `fault / start_failed`；第 1 项已修复该启动失败，本项只处理切换过程本身。

## 2. 时间花在哪里

切换当前仓库本身只改地址和列表，不启动进程；耗时发生在目标仓库实例的
启动链：

1. **排队**：`MAX_ONLINE=2` 已满且没有可淘汰的空闲实例时，
   `reason_code=capacity_wait`；内存准入不足时是 `resource_wait` /
   `resource_over_budget`。
2. **仓库准备**：`git_state=preparing`，准备 bare 副本；执行准入在此之前
   返回 409，不创建任务。
3. **进程启动**：`state=starting`，监督器等待 panel、Bridge、写入受管配置；
   超过 `START_TIMEOUT_MS` 失败并停止进程。

这三段在数据库里都有真实时间：`activation_requested_at`（本次唤醒请求）、
`last_started_at`（进程启动）和新增的 `last_online_at`（校验通过、进入在线），
Git 准备还有自己的 `git_started_at/git_finished_at`。第 3 节把它们投影成
`runtime.activation`，界面按真实阶段显示，不再只显示一个「启动中」。

## 3. 原生「负责仓库」设置能否在线切换

上游的仓库绑定是 `source:github.config.repository`，Deployment 里的仓库由它
派生，确实是「负责仓库」的唯一来源。检查锁定产物
`superagent-e6470da10319/lib/index.js`：

- 保存 `source:github` 且仓库变化时，`setupChanged` 为真，返回
  `restarting: true` 并调用 `host.setup.restart()`；这是运行时插件 fiber 的
  重启，不是系统进程重启。`Setup.resolve()` 会重新探测账号、仓库并重写 worker
  环境。
- 已创建 Ticket 在创建时冻结 `base.repository`，所以旧 Ticket 保留原仓库绑定。
- Bridge 的 `POST /bridge/v1/triggers` 在
  `request.executionSpec.repository !== deployment.repository` 时返回 409：
  **切换后该实例不再接受旧仓库的新执行**。

因此原生设置可以做到「同一进程内改负责仓库，旧 Ticket 保留绑定」，但它不是
平台可直接复用的完整切换：

- `repository_instances` 以 `repository_id` 为主键，一个实例行的 Bridge URL、
  回调 token、profile、端口和 Git 副本都按仓库绑定；
- 旧仓库的网页会话、回复投递和后续任务仍指向自己的 `repositories` 行与
  Bridge 凭据；把实例改派给新仓库而不迁移这些行，会让旧仓库失去 Bridge，
  同时新仓库任务仍被路由到它自己的实例；
- 切换后的 prepare 命令、Git mirror 和运行目录需要按新仓库重建。

这不是一个设置字段的原地更新，而是 DB、API、supervisor、dispatcher 与
Git 副本的协同迁移；按 `docs/adr/0002-per-repository-runtime.md` 的每仓库隔离
边界，本次不把在线实例改派给另一个仓库。保留的替代路径是：目标仓库使用自己
的独立实例启动，旧仓库的会话与任务保持原绑定；切换过程按真实阶段和耗时展示，
失败给出原因和重试入口。

## 4. 本次替代实现

- `repository_instances` 增加 `activation_requested_at` 和 `last_online_at`
  （迁移 `0022`）。监督器在收到唤醒请求时记录前者，在启动校验通过时记录后者，
  并在 `supervisor.instance_online` 日志里带 `activationDurationMs`。
- `GET /api/v1/repositories` 与 `GET /api/v1/repositories/:id/runtime` 的
  `runtime.activation` 返回 `phase`、`requestedAt`、`onlineAt`、`elapsedMs`、
  `readyMs`、`detail` 和 `retryAction`。阶段优先级：故障/准备失败 →
  仓库准备中 → 启动中 → 在线且副本就绪 → 等待名额 → 空闲；进程已 starting
  但副本仍在准备时，界面显示仓库准备的真实内容和阶段，不再笼统显示启动中。
- Web 侧栏和工作台首页显示「切换中 · 等待在线名额 / 仓库准备中 / 启动中」、
  真实已用时、失败原因和重试按钮；切换未完成时每 2 秒回读真实状态。
- 已有任务、会话与仓库绑定不变；新任务仍按当前选择仓库的路由创建。

## 5. 验证与未验项

- `pnpm check`。
- `pnpm --filter @moyu/api test:integration` 覆盖 `activation` 投影。
- `pnpm --filter @moyu/web test` 覆盖阶段文案和耗时格式。
- 迁移正向/回滚在隔离数据库演练，见 PR 记录。

隔离栈已记录真实切换：同一仓库冷启动 12706 ms，副本就绪后再次唤醒
7190 ms（少 5516 ms）；休眠时预准备目标后切换为 10771 ms，切换期间不再出现
preparing；修复后冷启动在 starting 期间持续显示 preparing 至 Git 完成。
`docs/evidence/m6c-switch/runtime-timings.json` 保存采样。生产 release 尚未
重新部署并按发布流程复测。

**未完成**：本 PR 没有把在线实例原地改派给另一个仓库，仍采用每仓库实例和
预准备目标副本的路径；`repository_instances`、Bridge 凭据、runtime home、
worktree/mirror 与 dispatcher 路由的协同迁移拆到
[bouyer-sutrasky/MoYu#91](https://github.com/bouyer-sutrasky/MoYu/issues/91)。
