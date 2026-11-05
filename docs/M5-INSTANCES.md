# M5-A 多仓库接入与实例生命周期

日期：2026-11-05。基线：`main@160a22db322571f3a12fcc76748f86260fd34c04`。
范围：Issue #25 的 M5-A；M5-B 的租约资源扩展（8GB 聚合预算、cgroup 计量）不在本单。

M5-A 把“单仓库 dispatcher + 一个全局 Bridge”改为“按仓库调度 + 每仓库独立 runtime 实例”。
实例的进程、profile、state、worktree、端口和 Bridge 凭据由独立 supervisor 管理；平台 API 只提交
已授权的 repositoryId 和允许的生命周期操作。产品行为与 M4/M4-UX 的暂停/继续、双入口去重、冻结配置、
历史分页和草稿幂等保持一致。

## 1. 进程身份与边界

| 组件 | 身份 | 监听/路径 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- | --- |
| API | 平台服务进程 | `127.0.0.1:4300`（测试 4500） | 浏览器鉴权、仓库授权、调用 supervisor、读取实例投影 | 不执行任意 shell/path，不保存明文 Bridge token |
| dispatcher | 平台服务进程 | 无监听 | 按 DB 中在线实例建立每仓库循环 | 不使用全局 URL/token 顶替另一个仓库 |
| supervisor | 独立主机进程 | `127.0.0.1:4490`，Bearer | 固定模板准备/启动/停止/失联收敛 | 不接受前端命令、任意路径或任意端口 |
| runtime 实例 | 每仓库一个 DSH 进程 | 127.0.0.1 面板端口 + Bridge 端口 | 监听该仓库、执行/讨论任务 | 不访问其他仓库的 profile/state/凭据 |

supervisor 的实例映射来自固定的 `INSTANCES_CONFIG`：

```json
{
  "instances": [
    { "repository": "owner/alpha", "profile": "m5a", "dshPort": 3402, "bridgePort": 3401 },
    { "repository": "owner/beta",  "profile": "m5b", "dshPort": 3404, "bridgePort": 3403 },
    { "repository": "owner/gamma", "profile": "m5c", "dshPort": 3406, "bridgePort": 3405 }
  ],
  "portRange": { "start": 3401, "end": 3499 }
}
```

- 所有路径（`DSH_HOME`、profile、state、worktree、日志、凭据目录）都由 supervisor 的进程配置推导，
  请求只带 repositoryId；没有“传一个 shell 命令/路径”的接口。
- 未固定映射的新仓库可按 `PROFILE_TEMPLATE_DIR` 的固定模板分配未占用的 profile/端口；模板必须包含
  已构建的 `dsh-superagent` link 和 `cordis.patch.yml`。模板缺失或端口占用时启动失败并进入故障，不猜。
- 测试环境 supervisor 以 root 运行（宿主历史阶段相同），但它是独立进程、独立凭据目录和独立端口；
  生产部署必须放入专用非 root 用户与 systemd unit，并保持目录 0700/文件 0600。本单没有声称已完成生产切换。

### 隔离目录

| 项目 | 测试现场值 | 约束 |
| --- | --- | --- |
| `DSH_HOME` | `/root/.dsh-m5` | 目录 0700；不复用 bootstrap `/root/.dsh` 或 M4 `/root/.dsh-m4` |
| profile | `m5a` / `m5b` / `m5c` | 每仓库一个；profile 链接固定构建产物 |
| state | `/root/.dsh-m5/state/<profile>` | runtime 的 SQLite、Bridge 事件日志、worker gitconfig |
| worktree | `/root/.dsh-m5/worktrees/<profile>` | 执行器工作目录；停止后保留现场 |
| 面板端口 | 3402 / 3404 / 3406 | 仅 127.0.0.1 |
| Bridge 端口 | 3401 / 3403 / 3405 | 仅 127.0.0.1，按仓库独立 token |
| 实例 env | `/root/.dsh-m5/instances/<repositoryId>.env` | 0600；只含 `MOYU_*` 五个变量 |
| 平台凭据 | `/root/.dsh-m5/credentials/<repositoryId>.json` | 0600；Bridge token + callback token；DB 只存引用与 callback hash |
| 日志 | `/root/.dsh-m5/logs/<profile>.log` | 0600；DSH 启动行可能含临时 Web token，不入库、不提交 |

## 2. 持久化状态

迁移 `0010_wandering_living_lightning` 新增 `repository_instances`（每仓库一行）和
`repositories.bridge_callback_token_hash`；迁移 `0011_young_jimmy_woo` 增加 `repository_instances.ownership`
（root pid、process group、带 startTime 的成员快照）。状态：

| state | 含义 | 监听 | 在线名额 | 可执行动作 |
| --- | --- | --- | --- | --- |
| `sleeping` | 休眠/排队 | 暂停 | 否 | 唤醒；capacity_wait 时显示已排队 |
| `starting` | 正在启动并核验 profile/端口/Bridge | 未就绪 | 是 | 停止启动（受限） |
| `online` | 在线 | 是 | 是 | 休眠（无人工作且无保留后台服务时） |
| `stopping` | 正在停止并核验进程/端口 | 暂停 | 是（直到完整退出） | 失败时可重试停止 |
| `fault` | 启动失败/进程失联 | 否 | 否 | 重试启动 |

`desired_state` 区分“应在线”和“应休眠”，使 supervisor 重启后收敛而不是把人工休眠的仓库重新拉起。
`reason_code`/`reason_detail`/`waiting_for`/`last_progress_at`/`last_activity_at`/`last_started_at`/
`last_stopped_at`/`last_health_at` 是界面解释的事实来源；API 只在已有事实上翻译，不猜完成时间。

## 3. 调度规则

- 在线上限默认 2（`MAX_ONLINE`）；`starting`/`online`/`stopping` 都占名额，`fault`/`sleeping` 不占。
- 唤醒队列按 `queue_priority` 升序、`wake_requested_at` 先后排序；网页回复（10）优先于新任务（20），
  显式重试为 5，显式唤醒为 20。
- 容量已满时，如果存在最久无交互且无活动任务/操作/保留后台服务的在线实例，则按 LRU 淘汰它；
  否则请求者保持 `sleeping/capacity_wait`，不会为了腾位置杀死正在执行的实例。
- 每仓库执行名额复用 `runtime_leases` 的单活跃约束；`waiting_input`、`awaiting_review`、`stopped`、
  `blocked`、`failed`、`completed`、`closed_unmerged` 释放执行名额。实例是否在线与是否有执行名额分开。
- 休眠门控不是“idle 即停”：
  - 有 `pending_admission/queued/discussing/running/stopping` 任务或 queued/running 人工命令：拒绝；
  - DSH 进程仍有任何非瞬时的后台子孙进程（例如 worker 刚启动的测试服务）：拒绝；不按年龄放宽，
    新服务即使只有 200ms 也保守保留；
  - 只有已知的 GitHub polling 短命进程（`gh` / `gh-agent`）不计入保留服务；其他未知进程一律保留。
- 停止以进程所有权为准，不以父 PID 或端口单独作证：
  - 启动/停止途中持续记录 root pid、process group 和带 startTime 的子孙；父先退出后仍用 process group
    和已记录成员查找幸存子进程；
  - 信号发送前校验 root 与成员的 kernel startTime；PID 复用、过期 PGID 或无保存身份时不得杀当前进程；
    旧实例已退出则只释放自身名额，不触碰复用者；
  - SIGTERM 后等待所有已记录身份退出，超时后 SIGKILL 并继续等待；只有全部身份消失且 Bridge 端口关闭
    才进入 `sleeping`；
  - 超时/退出未知时保持 `stopping`（占用在线名额），保存剩余 ownership，返回 `accepted:false`；
    UI 显示 `retry_stop`，可重试停止；不得用 `pid:null`/`sleeping` 释放名额；
  - supervisor 重启、启动失败和进程失联路径使用同一停止证明；清理失败继续占用名额，不新建重叠实例。
- 排队唤醒合并而不是覆盖：同一仓库已在排队时，保留最高优先级（数值最小）和最早
  `wake_requested_at`；网页回复（10）不会被后到的普通新任务（20）降级或重置 FIFO。
- 停止期间到达的 wake 是新意图：`markSleeping`/停止失败写回前读取当前 `desired_state`，保留
  `wake_requested_at`，停止完成后由 tick 恰好启动一次，不被最终 sleeping 写覆盖。
- 执行命令唤醒：休眠仓库上的 `resume`（reply 10）/`start`/`retry`（retry 5）在写入幂等 operation 后
  请求 supervisor wake；重复 `clientCommandId` 也会重复幂等唤醒，避免首次响应丢失后永久 queued。
- 分配隔离：`prepare` 全程在 supervisor 锁内；分配器同时保留所有现有（含 sleeping）实例的
  profile、DSH 端口和 Bridge 端口，数据库再加 profile/port/bridge_port 唯一索引；并发 prepare 不会
  复用 state/worktree/端口/凭据。
- 启动 error：`ChildProcess` 的异步 `error`（ENOENT/EACCES）有监听并收敛为该仓库 `start_failed`，
  supervisor 与其他在线实例继续服务；不再因单实例 spawn error 退出。
- tick 释放停止名额前重新读取 Bridge 端口：进程身份全部消失但端口仍在监听时保持
  `stopping/stop_failed` 并占名额，端口关闭后才 sleeping。
- 可丢弃 polling 只限只读 `gh`/`gh-agent`：`issue/pr list|view|status|diff|checks`、`search`、
  `repo view`、只读 `gh api`（含 pagination 等只读 flag）。`pr create`、`issue comment`、
  `api -X POST`、`-f/--field/--input` 等未知/写入命令一律保留。
- 实例进程存活但 Bridge 健康检查失败时，不再杀死进程；状态保持在线并显示 `bridge_unreachable`/
  监听未知，等待下一轮核验。只有进程实际退出才进入 `fault/instance_lost` 并回收名额。
- supervisor 重启时会核对 DB 的 pid/端口：在线进程被接续（同一 PID），半启动且 Bridge 未就绪的孤儿被
  停止并标记故障，`stopping` 残留被完成。启动前清理本 profile 的陈旧 lock 目录，避免 SIGKILL 后
  “Lock file is already being held”永久卡住；仍失败则进入故障等待重试。

## 4. 凭据与跨仓库隔离

- `repositories.bridge_credential_ref` 只保存 `file:<repositoryId>.json` 或环境变量名；M5 新仓库使用
  0600 文件。dispatcher/API 按仓库 id 读取对应文件，文件内容不返回给浏览器。
- 全局 `BRIDGE_URL`/`BRIDGE_TOKEN` 只允许作用于 `BRIDGE_REPOSITORY` 这一行，作为 M3/M4 单仓库兼容；
  其他仓库缺少自己的 endpoint 或凭据时拒绝投递，不会回退到 A 的 token/URL。
- 回调 token 按仓库摘要保存；Bridge 回调 `/api/internal/v1/runtime-events` 会先按会话所属仓库校验
  token 摘要，A 的回调不能写入 B 的会话。旧单仓库全局 callback token 仅对该兼容行有效。
- `runtime_cursors` 以 repository_id 为主键；`deferred_bridge_events`、`duplicate_tickets` 的唯一键都
  带 repository_id；dispatcher 为每仓库单独持有 Bridge 客户端和游标，切换仓库不改变已有任务。
- 同仓库仍只允许一个执行名额；不同仓库可并行，但受 2 个在线实例上限约束。

## 5. 接口变化

| 接口 | 变化 |
| --- | --- |
| `GET /api/v1/github/repositories` | 专用 GitHub 账号查询（`q`、`limit`），返回可访问仓库与 push 权限 |
| `POST /api/v1/repositories` | `{fullName}`；真实 GitHub 权限校验、重复 409、创建后请求 supervisor prepare/wake |
| `GET /api/v1/repositories` | 每项增加 `runtime` 投影（状态、原因、等待对象、监听、执行名额、动作） |
| `GET /api/v1/repositories/:id/runtime` | 单个仓库的同一投影 |
| `POST /api/v1/repositories/:id/wake` | 仅 repositoryId；忙时排队，不承诺立即在线 |
| `POST /api/v1/repositories/:id/sleep` | 仅在无活动工作且无保留后台服务时接受；拒绝时 200 + `accepted:false` 并给出原因 |
| `GET /api/v1/conversations` / `POST .../messages` | 服务端在提交/回复后按仓库请求唤醒；不改变冻结配置与幂等语义 |

## 6. 运维与回滚

- 只新增迁移 `0010`；回滚脚本 `packages/db/migrations/rollback/0010_wandering_living_lightning.down.sql`
  要求 0010 是最后一条且传入 SQL 的 sha256。验证步骤：
  `psql -v hash=<sha256> -f rollback/0010_....down.sql`，再 `pnpm --filter @moyu/db db:migrate` 重放。
- 回滚平台版本不会回滚已产生的实例进程；停 supervisor 前应先通过 sleep 停止运行中的实例，或确认它们
  只是本单测试实例。保留 `DSH_HOME`/state/worktree 不会自动清理现场。
- 生产切换、cgroup/8GB 预算、真实设备 Passkey 与正式 Nginx 变更不在本单授权范围内。
