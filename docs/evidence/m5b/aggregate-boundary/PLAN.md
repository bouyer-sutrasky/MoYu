# M5-B 补验：8 GiB 聚合硬边界与内存准入迟滞

日期：2026-11-08
Issue：<https://github.com/bouyer-sutrasky/MoYu/issues/42>（排单键 `M5B-D02F07F-AGGREGATE-PRESSURE`）
基线：`d02f07f1483e0c85a13c1dfe24d03d855a72d0a1`（来源 #31 / PR #32 的全线复验）

**本轮状态：未验。** 本目录只包含有界试验方案和只读预检；8 GiB 聚合硬边界与内存准入迟滞
**没有在真实隔离现场测量**，原因是排期依赖 #36、#41 尚未合并且 #36 的现场收敛动作未执行
（见 §1）。本轮只读，没有创建、移动或停止任何进程，没有触碰 3082 bootstrap、生产库、
4300 线上实例、共享 `55432` PostgreSQL 或其它仓库。

## 1. 依赖状态（现场事实）

| 依赖 | GitHub 状态 | 阻断点 |
| --- | --- | --- |
| #36 隔离现场验收环境 | Issue `OPEN`；PR #49 `OPEN`，两项必需检查绿、`CLEAN`/`MERGEABLE` | #49 文档 §4 的五项**所有者动作**未执行：收敛旧写授权、轮换共享凭据、安装专用探测凭据、`--apply` + `precheck.mjs --online`、重建并复跑。现场 `precheck` 仍为 `violated` |
| #41 cgroup 冷启动与归属 | Issue `OPEN`；PR #53 `OPEN`，两项必需检查绿、`CLEAN`/`MERGEABLE` | 未合并，矩阵的冷启动语义没有进入 `main` |

本机只读复核（原始输出见同目录 `preflight-*.log`）：

```text
$ stat -c '%U:%G %a %n' /root/.dsh-m5 /root/.config/gh-agent /tmp/m5bmatrix
root:m5bmatrix 770 /root/.dsh-m5
root:m5bmatrix 770 /root/.config/gh-agent
m5bmatrix:m5bmatrix 755 /tmp/m5bmatrix
$ ls /root/.config/m5bmatrix
ls: cannot access '/root/.config/m5bmatrix': No such file or directory
```

测试身份 `m5bmatrix` 仍能写共享配置目录、能读共享凭据，专用探测凭据不存在。这正是否定本单
排期条件的事实：**安全隔离尚未确认**，矩阵复跑保持阻断。Issue 明确要求「待安全隔离确认后
排期，先准备有界试验方案」，因此本轮交付停在方案与预检，不启动压力实验。

## 2. 已有实证与本单要补的两个缺口

已有实证（`docs/evidence/m5b/matrix/`，结论只对当时的产物有效）：

- 三档节流（4/6/8 GiB 档）各自只节流不杀：8 GiB 档峰值 6.23 GiB，`high` 107k–123k，
  `max`/`oom_kill` 增量为 0（`item3-budget.log`）。
- 切片硬上限机制用 **4 GiB** 单独探针顶到过：`MemoryHigh == MemoryMax = 4 GiB`，合成成员
  请求量等于剩余余量，最后一笔分配越过 `max`，触发**切片内 memcg OOM**
  （`constraint=CONSTRAINT_MEMCG`、`oom_memcg=/m5bmatrix.slice`，只杀合成成员，真实服务全存活）。
- 全栈 8 GiB 切片上 filler 只把聚合推到 **6.19 GiB**（`item6-aggregate-stress.log`）；
  `memory.high` 节流 18,697 次，切片 `max`/`oom_kill` 始终 0 —— **8 GiB 上限本身没有顶到**。
- 容量排队有实证（两个执行、第三个 `capacity_wait`/`waiting=capacity`），但那是**执行名额**
  等待，不是内存等待；`scripts/m5b/matrix/item4-abc.py` 自己也标明 A/B/C 切分未测得。

本单要补的：

1. **8 GiB 切片硬上限**：在真实成员（PG、API、dispatcher、supervisor+runtime、provider）
   同在的 8 GiB 切片上顶到 `memory.max`，记录 `memory.current/peak/events(.local)`、
   `MemAvailable`、内核 `oom_memcg` 作用域、成员存活与清理；并与 `memory.high` 节流、
   成员级 OOM 三种现象分开记录。
2. **内存准入迟滞（A/B）**：让第三个实例因**内存** `resource_wait` 排队（不是执行名额
   `capacity_wait`），释放压力越过 `budget - hysteresis` 后记录有界恢复、清错和无抢占。

## 3. 有界试验方案

### 3.1 环境

- harness：`scripts/m5b/matrix/stack.sh up`，单一受管切片 `m5bmatrix.slice`
  （`MemoryMax=8 GiB`、`MemoryHigh=6 GiB`、`swap.max=0`）。成员上限之和
  3,758,096,384 B = 3.5 GiB（pg 1 GiB、api 1 GiB、dispatcher 512 MiB、supervisor 512 MiB、
  provider 512 MiB），所以真实服务自己到不了 8 GiB，硬上限必须由**明确标注的合成 filler** 顶上。
- 运行身份：`m5bmatrix`（uid 995，非 root）；专用探测凭据与 3 个探测仓库（A/B/C 需要逐仓库
  凭据）属于 #36 §4.3 的所有者动作。
- 构建：从合并后的 `main` 全新构建；记录 `apps/dispatcher/dist/main.js` 的 sha256 与字节数
  （沿用 #31 的产物比对方式）。不重启 3082 bootstrap。
- 端口：`55433`（隔离 PG）、`4510`（API）、`4491`（supervisor）、`3851`（provider）、
  `3403/3404`（runtime Bridge/面板）；全部 loopback。
- 运行根与状态都在 `/tmp/m5bmatrix` 下的专用目录，不写共享 `/root/.dsh-m5`、
  `/root/.config/gh-agent`。

### 3.2 前置门（全部通过才允许启动；任一失败 → 未验并保留预检）

| 门 | 命令 | 通过判据 |
| --- | --- | --- |
| G1 隔离 | `node scripts/m5b/matrix/precheck.mjs --online` | `verdict=clean`，退出码 0 |
| G2 冷启动 | `scripts/m5b/matrix/stack.sh up`（空委托目录） | 一次成功；实例 cgroup 在 supervisor 委托子树内 |
| G3 边界预检 | `M5B_MATRIX_ROOT=… bash scripts/m5b/aggregate-boundary/preflight.sh`（`stack.sh up` 前后各一次） | 启动前 `verdict=ready`；`up` 之后重跑，五个成员全部 `active` 且各自 `ControlGroup` 在切片内 |
| G4 产物 | `pnpm build` + `sha256sum apps/dispatcher/dist/main.js` | 三个 dist 产物齐全，sha256 记入日志 |
| G5 宿主余量 | `/proc/meminfo` | `MemTotal ≥ 12 GiB` 且启动时 `MemAvailable ≥ 10 GiB`；运行期底线 4 GiB |
| G6 探测凭据 | #36 §4.3 | 三个探测仓库都能以测试身份 clone/读写；`bouyer-sutrasky/MoYu` 被拒 |

### 3.3 失配即退出（abort conditions）

2026-11-07 的现场事故是本方案每一条约束的来源：两个并行 filler 没有落进切片、跑在
`/system.slice` 里各吃掉约 10 GB，触发的是宿主全局 OOM（`journal: global_oom`），而不是切片
语义。因此：合成成员必须**逐个证明落位**、同一时刻**只有一个**、并且有宿主 4 GiB 底线；
这也是安全隔离确认前不启动任何压力实验的原因之一。

- 切片 `memory.max ≠ 8 GiB`、`memory.high ≠ 6 GiB`、`swap.max ≠ 0`（S2 的临时 `high=8 GiB`
  窗口除外，窗口结束必须恢复并复验）。
- 任一成员单元的 `ControlGroup` 不以 `/m5bmatrix.slice/` 开头。
- 合成 filler 没有先证明自己的 `cgroup` 在切片内（`stress-member.sh` 已在分配前断言；
  断言失败即退出，不分配一个字节）。
- `MemAvailable < 4 GiB` → 立即停 filler 并中止。
- 五个真实成员任一不再 `active`，或 Bridge/API 端口丢失。
- cgroup 读数缺失（`aggregate.ok=false`）：不得把估算当测量，按 `resource_wait` 记录并中止。
- 单步 120 s、整轮 25 min 超时；超时按失败清理并标未验。
- 出现非预期 OOM（真实服务被杀）→ 中止、恢复切片、标未验。

### 3.4 S1 — `memory.high` 节流（8 GiB / 6 GiB，真实成员在场）

```bash
scripts/m5b/matrix/stack.sh up
# 6500 MiB 低于当前余量（约 7.5 GiB）也低于切片 max；stress-member.sh 会在分配前拒绝越界请求
scripts/m5b/matrix/stress-member.sh 6500 high-throttle
```

采样 40 × 1 s：切片 `memory.current`、`memory.events`（递归）与 `memory.events.local`、
每个成员 `memory.current/peak/events`、宿主 `/proc/meminfo MemAvailable`、
`/proc/pressure/memory`、`systemctl is-active` 五个单元。

通过判据：切片递归 `events.high` 增量 > 0；`max`/`oom_kill` 增量 = 0；
峰值 6.1–6.4 GiB；五个真实成员全程存活；`MemAvailable ≥ 4 GiB`。

### 3.5 S2 — 8 GiB 切片硬上限（本单的核心缺口）

先停 S1 的 filler，切片回到 8 GiB/6 GiB。然后：

```bash
# 1) 把 high 抬到 max，节流不再提前介入；trap 里必须恢复
systemctl set-property m5bmatrix.slice MemoryHigh=8589934592 MemorySwapMax=0
# 2) 请求量 = 剩余余量 - 32 MiB，32 MiB 步进；页表/slab 也计入 cgroup，最后一两笔可能越过 max
current=$(cat /sys/fs/cgroup/m5bmatrix.slice/memory.current)
want=$(( (8589934592 - current) / 1048576 - 32 ))
# 3) filler 单元加 OOMScoreAdjust=1000，让内核优先杀它而不是真实服务
scripts/m5b/matrix/stress-member.sh "$want" ceiling8      # 本轮需给该脚本加可选 OOMScoreAdjust
```

期望读数：切片递归 `memory.events` 的 `max` 增量 > 0、`oom_kill` 增量 ≥ 1；
`journalctl -k` 出现 `constraint=CONSTRAINT_MEMCG`、`oom_memcg=/m5bmatrix.slice`、
`task_memcg=/m5bmatrix.slice/m5bmatrix-stress-ceiling8.service`；被杀的是 filler；
五个真实成员存活；`MemAvailable` 回升并 ≥ 4 GiB。

清理：停 filler，`MemoryHigh=6442450944` 恢复并复验 `max=8589934592 high=6442450944 swap=0`。

若一个 120 s 窗口内没有越过 `max`，停掉该成员后按**新的余量**再起一个（同一时刻始终只有一个
合成成员），最多两次；仍未越过则如实标未验，不并发加注。判定：满足则「8 GiB 切片硬上限通过
（切片内 memcg OOM，只杀合成成员）」；若被杀的是真实服务，中止并标未验。

### 3.6 S3 — 成员级 OOM（与切片硬上限区分）

在切片内起一个**带自身 `MemoryMax=256 MiB`** 的合成成员，请求 320 MiB
（本轮需给 `stress-member.sh` 增加一个可选的成员 `MemoryMax`，否则它只起无上限成员）：

- 期望：成员 cgroup `memory.events.oom_kill` 增量 = 1；切片递归 `memory.events` 也 +1，
  但 journal 的 `oom_memcg` 指向**成员 cgroup**（`…/m5bmatrix-stress-member-*.service`），
  不是 `/m5bmatrix.slice`；五个真实成员不受影响。
- 与 S2 的区别只在 `oom_memcg`/`task_memcg` 的作用域和各自的 `memory.events`：
  S2 是切片自己越界（`oom_memcg=/m5bmatrix.slice`），S3 是成员自己越界。

### 3.7 S4 — 内存准入迟滞 A/B（与执行名额等待分开）

代码事实（`apps/supervisor/src/manager.ts:802-889`、`resources.ts:305-410`）：
两个名额都占用时先走 `capacity_wait`/`waiting=capacity`；有名额才做内存决策，
拒绝时 `resource_wait`（或 `over_budget`）/`waiting=memory`，并置 `resourceBlocked`；
再次准入要求聚合回落到 `budget - hysteresis` 以下，避免抖动。

为让 C 的等待是**内存**而不是名额，本场景用测试专用参数 `MAX_ONLINE=3`
（部署默认仍为 2；执行时在 `stack.sh` 的 supervisor `--setenv` 增一行
`--setenv=MAX_ONLINE=${M5B_MATRIX_MAX_ONLINE:-2}`，在 #49 合并后落地以免冲突）。

按代码默认值算出的阈值（由 `preflight.sh` 打印，`target=4096`、`budget=6144`、
`hard=8192`、`reserve=1024`、`hysteresis=256`）：

| `MAX_ONLINE` | 实例估算 | 已阻塞者停留 `resource_wait` 的聚合区间 | 新仓库被判 `over_budget` 的起点 |
| --- | --- | --- | --- |
| 2 | 2048 MiB | (3840, 4096] MiB | > 6144 MiB |
| 3 | 1366 MiB | (4522, 4778] MiB | > 6826 MiB |

步骤（3 个探测仓库 A/B/C，`M5B_MATRIX_EXTRA_REPOS`）：

1. `stack.sh up`；用真实 Web API 给 A、B 建任务并等两个实例 `online`，记录 PID。
2. **首次阻塞**（必须先让 C 进入 `resourceBlocked`，迟滞才有意义）。两条路径按顺序尝试：
   a. 自然拒绝：保持 `high=6 GiB`，filler 把聚合推到 5.5–6.2 GiB（projected = current +
      1366 MiB，落在 6.9–7.6 GiB：高于 `budget`、低于 `hard`，宿主余量也够，只有 PSI 能拒绝，
      所以同时采样平台 cgroup 的 `memory.pressure some avg10`）。给 C 建任务；若得到
      `resource_wait`（`waiting_for=memory`，detail 为预算/压力）即完成首次阻塞。
   b. 兜底：把 `high` 临时抬到 8 GiB，filler 把 current 推到 **> 6826 MiB**
      （projected = current + 1366 MiB > 8 GiB）→ C 得到 `over_budget`（同样是内存拒绝，
      同样置 `resourceBlocked`）；随后把 `high` 恢复 6 GiB 并记录 C 的 `over_budget` 行。
   `over_budget` 与 `resource_wait` 是同一判定函数的两种内存拒绝，日志必须写清是哪一条。
3. 降 filler 到聚合 current ∈ (4522, 4778] MiB。≤ 10 个 tick 内 C 必须是
   `state=sleeping`、`reason_code=resource_wait`、`waiting_for=memory`，detail 指出
   「仍高于迟滞边界」——这是**迟滞带**的直接证据（此时 projected 已不高于 `budget`，
   若没有 `blockedBefore` 本应立即准入）。每一步都把 C 的 `repository_instances` 行
   （`state/reason_code/waiting_for/resource_state/resource_detail`）与 supervisor 的
   `supervisor.resource_wait` 事件（projected/current/hostAvailable/pressure）原样抄进日志。
4. 继续降到 current ≤ 4500 MiB。≤ 10 个 tick 内 C 必须 `online`，`reason_code=online`、
   `error_code=null`、`resource_state=ok`；A、B 的 PID 不变（**无抢占**），
   仅出现 C 的 `supervisor.instance_spawned`。
5. 对照（名额等待）：另起一轮 `MAX_ONLINE=2`，A、B 在线时给 C 建任务 →
   `capacity_wait`/`waiting_for=capacity`。这样同一份日志里 `capacity` 与 `memory`
   两种等待各有独立读数。

### 3.8 证据字段与判定

每个场景都记录：命令与退出码、时间戳、切片 `memory.current/peak/events/events.local`、
每个成员 cgroup 路径与 `memory.current/peak/events`、`/proc/meminfo`、
`/proc/pressure/memory`、`systemctl is-active`、相关 `journalctl -k` 行、必要时
`repository_instances` / `runtime_resource_samples` 的行。

三种现象的分辨表：

| 观测 | `memory.high` 节流 | 成员级 OOM | 切片硬上限 |
| --- | --- | --- | --- |
| 切片递归 `memory.events` | `high` ↑，`max`/`oom_kill` 不增 | `oom_kill` ↑（随成员事件递归上来） | `max` ↑、`oom_kill` ↑ |
| 切片 `memory.events.local` | 0（切片自身无常驻进程，预期为 0；证据里两者都记并注明语义） | 0 | 0 |
| 成员 cgroup `memory.events` | 不改 | `oom_kill` ↑ | 被杀成员自己的 `oom_kill` ↑ |
| 内核 `oom_memcg` | 无 | 指向成员 cgroup | `/m5bmatrix.slice` |
| 真实服务 | 全存活 | 全存活 | 全存活 |

判定只认原始读数；估算值（`aggregate.ok=false` 时）不得作为边界成立的证据。

### 3.9 清理与恢复

`trap` 覆盖每个失败路径：

1. 停 filler，恢复 `m5bmatrix.slice` 的 `MemoryMax=8589934592`、`MemoryHigh=6442450944`、
   `MemorySwapMax=0`，并读回复验。
2. `scripts/m5b/matrix/stack.sh down`（`cgroup.kill` 收 runtime 子树）。
3. 复验：切片树 0 进程、`3403/3404/4510/4491/3851/55433` 无监听、无 `failed` 单元、
   无 `m5bmatrix-*` 残留单元、Bridge 凭据目录已清空。
4. 清理失败不得当作通过；标记未验并贴出残留。

### 3.10 时间预算

`up` 约 3 min；S0/S1 约 2 min；S2 约 2 min；S3 约 1 min；S4 两轮约 6 min；`down` 约 1 min。
整轮上限 25 min，每个采样窗口 120 s 超时。

### 3.11 证据落盘

`docs/evidence/m5b/aggregate-boundary/run-<UTC 时间戳>/`：`commands.log`（命令与退出码）、
`raw-<scenario>.log`（原始读数）、`sha256.txt`（产物）、`SUMMARY.md`（逐项判定与未验项）。
日志脱敏：不出现 token、私钥、Cookie 或文件内容，只出现路径、owner/mode 与计数。

## 4. 本轮未验项

- 8 GiB 聚合硬边界：**未验**（没有真实成员在场的 8 GiB `memory.max` 探针）。
- 内存 `resource_wait` 与迟滞恢复：**未验**（没有 A/B 现场读数）。
- 现场隔离：`precheck=violated`（#36 §4 未执行）。
- 专用探测凭据与多仓库范围：不存在/未探测。
- 4 GiB 硬上限探针仍是目前唯一已触发的切片上限证据；它证明机制，不证明 8 GiB 切片的边界行为。

## 5. 复跑门槛

1. 合并 #49（#36）与 #53（#41），由所有者执行 #36 文档 §4 的第 1–4 步：
   收敛旧写授权、轮换共享凭据、安装专用探测凭据（含 3 个探测仓库）、
   `prepare-nonroot.sh --apply` + `precheck.mjs --online` 退出 0。
2. 从合并后的 `main` 重新构建，记录 dispatcher sha256。
3. `M5B_MATRIX_ROOT=… bash scripts/m5b/aggregate-boundary/preflight.sh` 退出 0（`verdict=ready`），
   并在 `stack.sh up` 之后重跑，确认五个成员的实际 `ControlGroup` 都在切片内。
4. 按 §3 执行 S1–S4，落盘 §3.11 的证据并给出逐项判定。
