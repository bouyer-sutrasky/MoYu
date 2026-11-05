# M5-A 验证记录

日期：2026-11-05。基线：`main@160a22db322571f3a12fcc76748f86260fd34c04`；返修实现 head：
`9931abbe736a0ccdaa2e054ae990ccf949e122b9`。
被测环境与设计见 [`M5-INSTANCES.md`](M5-INSTANCES.md)；本文只记实际执行过的命令、结果与未验证项。
所有实例均使用隔离 `DSH_HOME=/root/.dsh-m5`、独立 profile/state/worktree/端口和私有测试仓库；
3082 bootstrap、4300 线上实例、生产库 `moyu` 与 Nginx 未改动。

## 1. 环境与制品

| 项目 | 值 |
| --- | --- |
| 宿主 | Ubuntu 24.04.2 LTS，4 vCPU / 16 GB |
| Node / pnpm | v22.23.3 / 11.7.0 |
| PostgreSQL | 16.15；`moyu_m5a_live@127.0.0.1:55432`（隔离实例） |
| 平台 | API 4500、baseline UI 4501、dispatcher、supervisor 4490 |
| runtime | `/root/.dsh-m5`，profile `m5a/m5b/m5c`，面板 3402/3404/3406，Bridge 3401/3403/3405 |
| 测试仓库 | `Bouyer12/m5a-alpha-adf10ad9`、`Bouyer12/m5a-beta-adf10ad9`、`Bouyer12/m5a-gamma-adf10ad9`（私有） |
| 上游构件 | `dsh-superagent@0.1.0` @ `6337fc823ce20251c8de8085948165c81aaa701e`，`m4-final-verify` 构建；未新增上游补丁 |
| 基线 Web | `main@160a22d` 的 M4-UX 构建，服务在 4501；与 after 使用同一数据库 |

构建/制品摘要见 [`evidence/m5/artifacts.txt`](evidence/m5/artifacts.txt)。核心值：

```
api dist        6eccff5e…a50461
dispatcher dist ab172e05…da7d99
supervisor dist 5a102dce…2d223
web js/css      7e475c12…7d83b1 / 39a2cbfc…cb5424
migration 0010  dd09b7b3…6c55
migration 0011  1e105e7a…4227b0
upstream index  8d80bb7f…3c6252
```

### 本轮返修（2026-11-05）

| 发现 | 处理 | 验证 |
| --- | --- | --- |
| P1 `stopProcessTree` 只等父 PID | 改为记录 root/pgid/带 startTime 的子孙；父退出后按 process group 和已记录成员继续追踪；全部身份消失才返回 true；超时先 SIGKILL 再等 | `process.test.ts`：父先退子存活、子忽略 TERM、超时未退出、新服务 200ms 仍保留；live 短超时保留 `stopping/stop_failed` |
| P1 恢复 stopping/失败路径无条件休眠 | `stopInstance` 仅在全部退出且端口关闭后转 `sleeping`；失败保持 `stopping`、保留 pid/ownership、占容量；重启/启动失败/失联复用同一证明；新增 `retry_stop` | `stop-timeout-retention.json`、`supervisor-lifecycle.log`；DB `members=2` 时未被误报 stopped |
| P1 <5s 子孙被排除 | 取消年龄阈值；只排除 `gh`/`gh-agent` polling，其他子孙（含刚启动 200ms）保守保留 | `process.test.ts` 新服务保留；sleep/LRU 使用同一 `retainedDescendants` |
| P2 queued wake 覆盖优先级/时间 | `mergeQueuedWake` 取最高优先级（数值最小）和最早时间；重复 wake 不重置 | 纯函数测试 + live reply 10 → new_task 20 后仍 `queue_priority=10`、`duplicate:true` |
| 证据 head/日志未随 PR | `artifacts.txt` 记录实现 head/tree 与构建 hash；log 强制提交；新增 0011 回滚、并发、重启、停止失败、浏览器回归证据 | PR 文件列表包含全部脱敏日志；0011 回滚 11/0→12/1 |

### 事件契约返修（2026-11-05，approval M5A-link-import-03cee850）

- **可失败回归**：新增 `claims the Web conversation for an import event on an existing workspace task`；旧代码只更新 task 状态，不认领会话，会话保持 source=web。dispatcher integration 25/25 通过。
- **bridge 0022**：既有 workspace Ticket 后续挂上 GitHub input Trigger 时，从该 Trigger 取 number/url/isPr/text 发 `ticket.imported`；确定性键 `ticket-imported:<ticketId>:github:<number>`，纯 GitHub Ticket 保持旧键；不再用 `follows` 的 PR 编号冒充 Issue 身份。
- **dispatcher 认领**：import 事件命中既有 task 时，仅当该会话消息精确包含同 repo/number URL 才更新 source/external_key；不新建会话/任务。
- **live 结果**：conversation `ecca4f49…` 从 `web/null` 变为 `github/github:4`；task `775f5577…`、upstream ticket、assignment 与 PR #5（单文件/单 commit）均未变；正确 import 事件键计数 1；dispatcher 回放 24/25 后只认领一次。
- **制品**：runtime build `/root/src/upstream/m5a-link-import-build`，`lib/index.js` sha256 `975c73e8…b0910`；patch 0022 sha256 `4a89eaab…ef916`；dispatcher dist `8886a627…52f8`。
- **ignore 缺口**：仍无 pending_admission 终态事件；安全处置是继续保留 sleep/容量阻塞，不自动关闭未证明任务，需后续事件契约修复。

### 交付补证（2026-11-05，PR26-73daaa1-live-gate）

- **GitHub→Web（真人目标 issue #2，已闭合）**：sutrasky 05:48:39Z 创建 issue #2；runtime accept decision `1de62edf…`，ticket `dca336de…`，assignment `3e905a89…`，worker session `worker-dca336de…`。平台 task `406e433b…` 先 running v2 等确认；Web 消息 `6765844c…`（05:51:37.222Z，readAt 05:51:37.458Z）在同一 assignment 恢复执行；PR #3 单文件 `M4-DUAL-ENTRY.md`、单 commit `87646c9`、内容 `dual entry probe`；task `awaiting_review/version3`。同 clientMessageId 重发返回 200 duplicate，消息/投递/PR 计数不变。证据 `evidence/m5/m4-dual-entry.log`。
- **Web→GitHub（issue #4，真人目标，执行已闭合，平台导入未闭合）**：issue #4 无 @ 时先建 Web 会话 `ecca4f49…`，消息 `db4599d1…` 等待确认；owner @ 后 runtime 把 `github:4` 并入原 ticket `1d4215c9…`，input readAt `09:18:56.870Z`，同一 assignment `1f7f9d15…`。Web 确认 `e971e6fb…` readAt `09:22:38.959Z` 后执行，PR #5 单文件 `M4-WEB-FIRST.md`(+1/−0)、单 commit `dcfdb44`、内容 `web first probe`；重复回执 duplicate=true，task/PR 计数仍 1。**但**平台会话仍 `source=web/external_key=null`，无 `github:4` 行；bridge 在既有 workspace ticket 上挂 GitHub 线程时不发 `ticket.imported`，dispatcher 无法认领/记录导入，故不能标平台导入合并通过。证据 `evidence/m5/m4-web-first.log`。


- **pending_admission 根因**：隔离 beta 任务 `fbb374c3` 的 runtime decision 为 `ignore`（无仓库变更的 sleep 探针），平台没有 ignore/not_accepted 事件，task 永远停在 `pending_admission` 并计入 gate active，导致 sleep_refused。不是 runtime 未启动/故障；第二个 alpha 样本同样。证据 `evidence/m5/pending-admission-diagnosis.log`。
- **M4 live pause→resume**：真实 beta 任务 `26b59a78`：running v3 → stop 202 → stopped v7 → resume 202 → running v8 → completed v10；只产生 PR #4，单文件 `M4-RESUME.md`、单 commit、内容 `resume probe`，无重复 PR/commit。证据 `evidence/m5/m4-pause-resume.log`。
- **仍未闭合**：GitHub→Web/Web→GitHub 两种入口顺序的 live 全序列仍未同时重跑（已有在线人工 @ 导入与 M4 双入口集成测试，但未把集成测试当 live 证据）；pending_admission 的 ignore 传播仍待后续修复。

### 第五轮返修（2026-11-05，review-key PR26-b65779e-cgroup-r5）

| 发现 | 处理 | 验证 |
| --- | --- | --- |
| P1 接管过期 PID 洗白 | `attachCgroup` 先要求 snapshot 中存在与 row.pid 匹配的当前身份；不匹配只写 `adoptedUnproven`，不迁移新 cgroup；cgroup 成员不再被无条件当成所有者 | live 保存 startTime='0' 的真实 sleep：接管后 `ownership_unverified`、cgroup 为空、sleep 返回 false/stop_failed，dummy 仍存活 |
| P1 只读直接 cgroup.procs | 改为按 `/proc/<pid>/cgroup` 扫描实例 cgroup 及 nested 子树；读取失败视为 unknown，不是空；停止等待整棵子树清零 | 单测 nested cgroup 中两个进程均被找到并停止；目录递归移除 |
| P1 旧实例 double-fork 后代 | 新 cgroup 不能证明历史后代；adoption 一律 `adoptedUnproven`，停止保持 unknown/占名额，不用新 cgroup 洗掉历史未知 | live 过期身份接管后 stop_failed；单测 adoptedUnproven + 空 cgroup 仍返回 overhead unknown |
### 第四轮返修（2026-11-05，review-key PR26-e8e6fe0-ownership-r4）

| 发现 | 处理 | 验证 |
| --- | --- | --- |
| P1 同 sid 不同 pgid 子进程漏检 | 新增 per-instance cgroup v2 边界；spawn 时由 shell 写入 `cgroup.procs` 后 exec，setpgid/setsid 子进程都继承；停止按 `cgroup.procs` 枚举并逐个复核 startTime | 单测：root 退出后 setsid child 仍被 cgroup 找到并停止，cgroup 清空；live beta cgroup pids 含 root+gh，stop 后 cgroup 目录移除 |
| P1 unknown 未贯穿 manager | `snapshot.unknown` 布尔贯穿 tick/reconcile/failInstance/stop；未知时保持 `stopping/stop_failed` 占名额，不因 Bridge 关闭 markSleeping；旧实例 adoption 时迁移进 cgroup | live 构造 root 已死、ownership 过期、dummy 存活：manager 保持 `stopping/stop_failed/online`，dummy 未杀；cgroup 停止成功后才释放 |
| 验收缺口 | 保留真实矩阵与限制：本轮新增真实进程/cgroup 证据，但 M4 live pause→resume、双入口仍以集成测试为准 | 见未验证项 |

### 第三轮返修（2026-11-05，review-key PR26-366ac47-lifecycle-r3）

| 发现 | 处理 | 验证 |
| --- | --- | --- |
| P1 信号发送未重新校验身份 | `send` 每次 SIGTERM/SIGKILL 前重新读取 `/proc` 并比对 startTime；失效成员移出 merged；不再对 PGID 盲发组信号 | 单测 spy：stale root 不产生任何 SIGTERM/SIGKILL；真实 stale-root sleep 保持存活 |
| P1 停止期间 wake 仍丢失 | `stopInstance` 入口保留当前 desired，不在重试时覆盖 online；`markSleeping`/stop_failed 读取当前 wake；未知成员保留时维持 stopping | live stop_failed 时 wake，DB `stopping/stop_failed/online`，进程退出后 starting→online，单进程 |
| P1 root 快照后孤儿漏检 | 保存 root 的 pgid/sid；root 已死时扫描旧 session 里的新子进程；身份不匹配成员列为 unknown 并阻塞，不盲杀 | 单测：仅 root 快照、root 退出后 fork 的 sleep 被找到并停止；stale root/PGID 返回 unknown 且不发信号 |

### 第二轮返修（2026-11-05，review-key PR26-da201222-lifecycle-r2）

| 发现 | 处理 | 验证 |
| --- | --- | --- |
| P1 root 身份未验证 | 信号前比对保存的 kernel startTime；过期 root/PGID 不接纳、不发送信号；无保存身份不猜测 | 单测 stale root/PGID 后真实 sleep 仍存活；live 把无关 sleep 写入 gamma ownership 后 sleep，dummy PID 仍活 |
| P1 并发 prepare 复用 profile/端口 | `prepare` 进入 manager 锁；分配器保留所有现有（含 sleeping）profile/DSH/Bridge 端口；0012 唯一索引 | live 并发 wake delta/epsilon 得到 `m5x-5:3409/3410` 与 `m5x-4:3407/3408`，不重叠 |
| P1 单实例 spawn error 崩溃 supervisor | `ChildProcess` `error` 监听，收敛 `start_failed`，不退出进程 | `DSH_BIN=/nonexistent` 的隔离 supervisor：failed repo `fault/start_failed`，health 仍 ok，main alpha 仍 online |
| P1 停止期间 wake 丢失 | `markSleeping`/stop_failed 写回前读取当前 desired，保留 wake 字段 | live delta 在 `stopping/stopping` 时 wake；停止完成后 `online/listening`，单进程 |
| P1 休眠仓库 resume/start/retry 不唤醒 | task 命令写入后调用 `wakeRepository`（resume reply 10、start new_task、retry retry 5）；重复命令也幂等唤醒 | live delta sleeping 上 resume 返回 202、operation queued，实例变 starting；API 集成测试断言 wake body |
| P1 tick 绕过端口证明 | 进程身份全消失但 Bridge 端口仍监听时保持 `stopping/stop_failed`，端口关闭后才 sleeping | live gamma：真实 3405 listener 在时 stop_failed 占名额；关闭 listener 后 sleeping |
| P2 所有 gh 命令都可丢弃 | 分类只允许只读 list/view/search/status/api GET（含只读 flags）；`pr create`/`issue comment`/`api -X POST`/`-f` 保留 | 单测覆盖读/写命令；新服务 200ms 仍阻止休眠 |
## 2. 最终检查结果

| 检查 | 结果 |
| --- | --- |
| `corepack pnpm@11.7.0 --config.engine-strict=false lint` | 通过（0 error） |
| `prettier --check "**/*.{ts,tsx,mjs,cjs,json,yml,yaml,css,html}"` | 通过 |
| `corepack pnpm@11.7.0 -r --if-present typecheck` | 通过（8 个项目） |
| `corepack pnpm@11.7.0 -r --if-present test` | 通过：contracts 13、runtime-client 13、api 20、dispatcher 3、supervisor 19 |
| `@moyu/db test:integration` | 通过：9 文件 / 35 测试（含 0010/0011/0012 回滚、旧版本迁移、完整性） |
| `@moyu/api test:integration` | 通过：11 文件 / 66 测试（含 M4 暂停继续、分页、双入口、仓库生命周期、任务唤醒） |
| `@moyu/dispatcher test:integration` | 通过：3 文件 / 30 测试（含多仓库隔离、等待/审阅释放名额） |
| `corepack pnpm@11.7.0 -r --if-present build` | 通过（API/dispatcher/supervisor/web） |

完整 CI 还需在 PR head 上跑两次必需检查（`check`、`integration (real PostgreSQL)`）；本文件记录的是本地等价命令结果。

## 3. 验收矩阵与结果

| # | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 专用账号仓库查询、权限拒绝、重复添加 | **通过**：真实 `gh` 查询返回三个测试仓库与 push 权限；`POST` readonly/不存在 403、重复 409、只建一行 | `apps/api/test/integration/repositories.integration.test.ts`（5 通过）；实际 API 查询见运行记录 |
| 2 | A/B/C 分别启动、休眠、网页唤醒、容量排队；切换仓库不污染原任务/配置/凭据/cursor | **通过（生命周期+并发分配）**：三仓库各有独立 profile/state/端口/凭据；A/B 在线后 C 唤醒 `capacity_wait`；LRU 淘汰空闲实例；并发 prepare 另得 `m5x-4`/`m5x-5` 与两对不重叠端口，credentials 文件独立 | `evidence/m5/supervisor-lifecycle.log`、`concurrent-prepare.log`、`live-snapshot.txt`、dispatcher 集成测试 |
| 3 | A/B 忙 → C 排队 → 释放/最久无交互淘汰；人工回复优先；等待/审阅释放名额但不抢占运行 | **通过**：A/B 有真实运行任务/后台 `sleep 300` 时 C 进入 `capacity_wait`；空闲实例按 `last_activity` 被淘汰；C 先 reply（10）再 new_task（20）后 DB 仍为 `queue_priority=10` 且重复 wake 返回 `duplicate:true`，不重置 FIFO；等待/审阅释放名额由真实 PostgreSQL 测试覆盖（`waiting_input` lease released，`running` lease active） | `capacity-wake.log`、`concurrent-wake.log`、`operations.integration.test.ts` |
| 4 | 并发重复唤醒/提交、双入口顺序、启动与人工停止交错、晚到回执 | **通过（可达路径）**：8 个并发同 `clientMessageId` 提交为 1×202 + 7×200，只有 1 条消息/1 次投递；同 id 晚到重试仍 `duplicate:true`，消息/投递数不变；并发 wake 只产生一个 DSH 进程；wake 后立即 sleep 收敛为 `sleeping` 且无残留进程；停止期间 wake 在 `stopping` 时被接受并在停止后恰好启动一次；双入口的 GitHub→Web/Web→GitHub 语义由既有 M4 集成测试回归；在线 GitHub 人工 @ 已真实导入（sutrasky 2026-11-05T02:38:11Z，17/17 断言） | `concurrent-submit.log`、`late-receipt.log`、`concurrent-wake.log`、`start-stop-interleave.log`、`wake-during-stop.log`、`github-online-import.log` |
| 5 | supervisor/dispatcher 重启、实例失联、启动失败、子进程退出；停机保持；后台服务阻止休眠 | **通过（含返修）**：supervisor 重启接续 alpha 同一 PID；dispatcher 重启计数不变；kill -9 后 `instance_lost`/端口关闭/名额回收；stale lock 后重试在线；新启动 200ms 服务仍阻止休眠；坏 `DSH_BIN` 只让该仓库 `start_failed`，supervisor 与他仓在线；端口仍监听时不释放 stopping 名额；stale root 不杀复用进程，旧 session 孤儿能找回 | `spawn-error.log`、`stop-port-proof.log`、`root-identity.log`、`supervisor-restart.log`、`process-exit-fault.log` |
| 6 | 状态原因/等待对象/最后进展/恢复动作与现场一致；桌面/手机、浅/深真实浏览器 | **通过（DOM + 截图）**：休眠显示 GitHub 监听暂停、原因、最后进展、唤醒动作；停止失败显示 `stopping/stop_failed`、占位进程数和 `retry_stop`；添加仓库对话框列出账号仓库、重复添加显示冲突；before/after 使用同一场景/视口/主题 | `ui-checks.json`、`stop-timeout-retention.json`、`after-*.png` / `before-*.png` |
| 7 | M4 暂停/继续、双入口幂等、M4-UX 草稿/分页/偏好回归 | **通过（真实浏览器 + 集成测试）**：Chromium 下会话分页 50→56 且追加成功，草稿 reload 后恢复；M4 暂停/继续、双入口幂等、晚到回执由 API/dispatcher 集成测试覆盖。未把旧单仓库 live 停止证据当作多仓库路径证据 | `browser-regression.json`、`concurrent-submit.log`、`late-receipt.log`、全量测试输出 |


### 关键 live 结果（返修后 head `5b9f0c9`）

- **停止所有权**：在 `STOP_TIMEOUT_MS=100` 的隔离 supervisor 上停止 beta，`POST /sleep` 返回
  `accepted:false`；DB 保持 `stopping/stop_failed`，`pid=3917683`，`ownership.members=2`，
  日志 `portClosed:true` 但仍有 2 个进程存活。端口先关闭没有骗过停止证明，名额未释放；随后进程真正
  退出时 tick 才转为 `sleeping`。单元测试另外覆盖“父先退出、子仍存活”“子忽略 SIGTERM”“超时未退出”
  与“新启动 200ms 的服务仍保留”。
- **停止成功路径**：beta 在线时 `POST /sleep` 返回 `accepted:true`，DB 为 `sleeping/-`，进程消失。
- **容量与优先级**：短超时停止 gamma 期间 active 仍计入 stopping；beta 先 reply（10）再 new_task（20），
  DB 保留 `queue_priority=10`，第二次 wake `duplicate:true`；alpha 在满容量时 wake 不抢占。
- **并发提交/晚到回执**：8 个同 `clientMessageId` 请求 1×202 + 7×200，DB 只有 1 条消息、1 次投递；
  之后同 id 重试 200/duplicate，计数仍为 1/1。
- **启动/停止交错**：gamma wake 后 150ms 内 sleep，最终 `sleeping/sleeping/-`，没有残留 DSH 进程。
- **重启**：supervisor 重启后 alpha 仍为 PID 3919012；dispatcher 重启前后消息/投递/task 计数为 1/1/1。
- **浏览器回归**：Chromium 首次加载 50 条会话，点击“加载更多任务”后 56 条；草稿 reload 后恢复。
- **在线 GitHub 人工 @ 导入（已闭合）**：`sutrasky` 于 2026-11-05T02:38:11Z 在
  `Bouyer12/m5a-alpha-adf10ad9#1` 写入 `@Bouyer12`；Bridge 于 02:39:02Z 收到一次
  `ticket.imported`（轮询延迟约 51 秒）。DB 只有 1 个 GitHub conversation、1 条 inbound message、
  1 个 task，无重复；task 从 running 走到 completed v4，runtime 复用 m5a（pid 3919012，3401/3402），
  worker session `worker-499f76…` 的标题与导入 ticket 一致。先前 agent 自写评论
  `6637745507` 导入数为 0，自回声过滤正常。验收脚本 `scripts/m5/online-import-acceptance.sh`
  在本机重跑 17/17、exit 0；首次重跑时 task 已 completed，断言允许 running/awaiting_review/completed，
  其余导入/计数/进程断言未放宽。
- **root 身份**：把无关 `sleep 300` 的 PID 以错误 startTime 写进 gamma ownership 后 sleep，`accepted:false`、`stopping/stop_failed`、dummy 仍存活；dummy 退出后 tick 才 sleeping。
- **并发 prepare**：delta/epsilon 同时 wake 得 `m5x-5:3409/3410`、`m5x-4:3407/3408`，profile/端口/凭据互不覆盖；容量仍按 2 执行。
- **spawn error**：坏 `DSH_BIN` 的隔离 supervisor 仍 health ok，失败仓库 `fault/start_failed`，main alpha `online/3919012`。
- **停止/唤醒交错**：短超时下 stop_failed 时 wake，DB 为 `stopping/stop_failed/online`，fake 进程退出后 `starting/online`，只有一个 m5c 进程。
- **端口证明**：真实 3405 listener 在时 gamma 保持 `stopping/stop_failed`；关闭后转 sleeping。
- **休眠 resume**：sleeping delta 上 resume 返回 202、operation queued，实例转 starting（任务行以隔离 DB 的保留 ticket 构造，只验证唤醒链）。
- **迁移**：0010/0011/0012 均在隔离库完成 rollback→reapply；0012 回滚后 12 条迁移/0 个唯一索引，重放后 13/3。
- **cgroup**：alpha adoption cgroup 含 pid 3919012；beta 新 spawn cgroup 含 root+gh，stop 后 cgroup 移除。
- **unknown**：root 已死但 ownership 过期、dummy 存活时，manager 保持 `stopping/stop_failed/online`，dummy 未杀。
- **adoption**：保存 startTime='0' 的 dummy 接管后 `ownership_unverified`，未迁入 cgroup；sleep 返回 false/stop_failed，dummy 仍活。

## 3. 实际命令

```bash
# 基线
git rev-parse HEAD   # 160a22db322571f3a12fcc76748f86260fd34c04

# 静态检查与单元测试（最终 head）
corepack pnpm@11.7.0 -r --if-present typecheck
corepack pnpm@11.7.0 -r --if-present test
corepack pnpm@11.7.0 -r --if-present build

# 集成测试（真实 PostgreSQL）
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  corepack pnpm@11.7.0 test:integration

# 定向 API / dispatcher 测试
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  corepack pnpm@11.7.0 --filter @moyu/api exec vitest run test/integration/repositories.integration.test.ts
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  corepack pnpm@11.7.0 --filter @moyu/dispatcher exec vitest run test/integration/multi-repo.integration.test.ts

# 迁移 rollback → reapply
psql -v hash=<sha256> -f packages/db/migrations/rollback/0010_wandering_living_lightning.down.sql
DATABASE_URL=postgres://moyu@127.0.0.1:55432/moyu_m5a_rollback \
  corepack pnpm@11.7.0 --filter @moyu/db db:migrate

# UI 截图与 DOM 检查（真实 Chromium，测试会话 cookie 注入）
M5_SESSION_TOKEN=<isolated session> node scripts/m5/screenshots.mjs
M5_SESSION_TOKEN=<isolated session> node scripts/m5/ui-check.mjs

# 在线 GitHub 人工 @ 导入验收（只读；M5_* 变量可覆盖）
bash scripts/m5/online-import-acceptance.sh
```

## 4. 未验证项与限制

1. **没有在 live 栈完成三个仓库各自的完整 PR 交付**。已用真实 worker Ticket、Session 和后台命令验证
   生命周期与忙闲，但没有让每个仓库都跑到测试/PR 完成；M3/M4 的 PR 闭环证据仍以原阶段记录为准。
2. **在线 GitHub 导入的样本与延迟边界**：本轮只有一次人工 @ 样本（sutrasky，2026-11-05T02:38:11Z），
  从评论到 Bridge 接收约 51 秒；休眠仓库唤醒后再导入、以及多次/长期轮询没有重跑。导入→会话→task→
  进程复用已闭合，但不能外推为所有轮询时序的统计结论。
3. **并发规模有限**：只验证两次并发唤醒与三仓库容量，没有做多客户端/长时间 soak 或资源压力测量；
   8GB 聚合预算、cgroup 计量与 M5-B 租约扩展不在本单。
4. **生产 supervisor 身份未落地**：测试 supervisor 仍为 root；生产需专用非 root/systemd、目录和凭据
   权限见设计文档，本单没有做正式部署或 Nginx 变更。
5. **真实设备 Passkey 未重验**：截图使用隔离测试会话，未绕过产品 Passkey；真实设备验收需所有者参与。
6. **M4 任务停止的 live 路径未重跑**：没有在 live 栈制造一个运行中任务并等待 GitHub polling 空闲后
   停止；既有 API/dispatcher 集成测试覆盖暂停/继续与 `blocked` 语义，M5 实例停止成功路径已单独验证。
   本轮不把集成测试等同于 live 任务停止。
7. **pending_admission ignore + 反向导入事件（明确处置）**：ignore 无终态事件使 task 永久 pending_admission；反向场景在既有 workspace ticket 上挂 GitHub 线程时 bridge 不发 `ticket.imported`，平台无法认领 Web 会话/记录 `external_key=github:4`。两者都是 M4 runtime/平台事件契约缺陷，非 M5 实例生命周期；本轮只诊断、绕行和记录，未改 runtime 契约。需要后续补事件投影/认领与回归，不能以 runtime 线程关联冒充平台导入通过。
8. **未知/复用身份**：root 已死且旧 session 中无匹配成员时会保持 `stopping/stop_failed` 占名额，不做 PGID 盲杀；需要人工确认后清理，这是有意的保守行为。
8. **截图对比**：before 为 `main@160a22d` 的 M4-UX Web 构建，after 为当前构建；同一数据库、同一
   仓库选择、视口和主题。截图由真实 Chromium 生成，但本执行模型不能直接读图，因而额外用 DOM 断言
   记录关键文案与动作；仍建议人工目视复核。

## 5. 复现与清理

- 复现所需隔离目录：`/root/.dsh-m5`（0700）、0060 凭据/环境文件、`instances.json`、三个私有测试仓库。
- 清理测试实例：先 `POST /api/v1/repositories/:id/sleep`（有后台服务会被拒绝），或按 profile 停止
  `dsh --profile m5a|m5b|m5c`；不要删除 `DSH_HOME` 之外的文件。
- 测试仓库与 Issue #1 只含生命周期探针，可保留供复核；删除是破坏性操作，由所有者决定。
