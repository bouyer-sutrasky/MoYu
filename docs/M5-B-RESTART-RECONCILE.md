# M5-B 打断回合接续与待审阅票重启对账

日期：2026-11-20。基线：`main@b6c2efab08e2703cc8e974dda7ff872db3122612`。
对应 Issue #95（衔接 #79；旧 Issue #39、旧 PR #50 仅用于追溯）。
本文只写**已实际执行**的检查；真实重启与真实 GitHub PR 验收依赖 #92 的隔离环境与 #94 的实例
生命周期，尚未执行，按 §7 复跑，不表述为通过。

## 0. 本轮到哪了

| 段 | 内容 | 状态 |
| --- | --- | --- |
| 平台侧修复 | 打断回合后运行时在同一租约下发的新 Assignment 由**权威运行时记录**采纳；保留预留行既有键，旧值入台账 | **完成**（本 PR） |
| 真实 PostgreSQL 用例 | 新旧回合交错、无状态事件的重发、重放只接续一次、非当前代次不采纳 | **完成**（红→绿，§4、§5） |
| 真实重启现场 | 隔离栈打断任务后重启 Bridge、dispatcher、supervisor、API 和两库，追加真实消息并核对游标与单 worker | **完成**（现场 A，§7） |
| 真实 GitHub PR 现场 | 真实开放 PR 在重启前后仍待审阅、关联稳定、关闭后正常结票 | **完成**（现场 B，§7） |
| 运行时补丁 | 宿主重启后的旧 Assignment 缺少 stop proof，replacement 永远被阻断；补丁 0031 从实例 cgroup 证明旧回合已不存在 | **完成**（§3.5） |

## 1. 缺陷与事实

一次执行代次的平台标识是 **（Ticket, 租约, fencing token）**。`assignmentId` 不是平台代次，
它是运行时自己的回合编号：宿主重启打断回合时，运行时结束旧回合，并在**同一个租约、同一个
fencing token** 下重发一个新的 Assignment。

修复前的平台侧事实：

- 预留行 `execution_reservations.assignment_id` 仍指向被结束的旧回合；
- `ticket.state_changed` 只能看到运行时投影出的状态；**状态不变的重发**（例如停在 `queued`
  时重启，`queued → queued`）不会产生状态事件，平台连新回合编号都看不到；
- 后续每个快照都被 `recoverReservedTasks` 记成 `admissionRecovery: snapshot_mismatch`，
  已 `claimed` 的预留行甚至不再进入恢复查询，`claimExecution` 永远匹配不上，丢响应恢复无法收口；
- 旧回合晚到的状态事件在租约仍匹配时仍可被当成当前事件投影，可能把任务从 `running` 拉回
  `queued`。

旧 PR #50 已尝试在 `ticket.state_changed` 上采纳新回合，但事件不是权威记录：它既晚于运行时
的实际回合，也可能根本不存在。本单改从 Bridge 的权威 Ticket 快照对账。

## 2. 安全恢复语义（本单确认）

1. **S1 同一张票、同一个租约**。宿主重启不是新的执行代次：fencing token 不变；旧回合结束、
   新回合开始，票回到 `queued` 再由新回合推到 `running`。
2. **S2 旧值可追溯**。旧回合的 `endedReason` 留在运行时 Ticket 里；平台在被替换时向
   `runtime_lease_events` 追加一条 `assignment_superseded`，记录旧值、新值和来源记录。
   两者都不改写、不删除。
3. **S3 预留行跟随当前回合**。`execution_reservations.assignment_id` 指向权威记录里的活回合；
   否则同一代次的后续快照与 `claimExecution` 全部按「不同身份」拒绝，恢复无法收口。
4. **S4 保留既有键**。迁移只改 `assignment_id`（和 `updated_at`）；预留行的 `id`、
   `repository_id`、`request_key`、`task_id`、`delivery_id`、`lease_id`、`fencing_token`、
   `state` 全部保持，因此同一代次的幂等键、任务和投递绑定不变。
5. **S5 只接续一次**。已指向活回合的预留行不再迁移、不再 claim、不再写台账；并发恢复由
   租约行与预留行锁串行化，只有第一次迁移写入台账。
6. **S6 非当前代次不采纳**。`Ticket`、`leaseId`、`fencingToken` 或运行时状态任一不匹配，
   都保持原预留并记录原因；只有 `queued`/`running` 的权威记录可以采纳。
7. **S7 被替换回合的事件不投影**。`runtime_lease_events` 已记该 Assignment 为
   `fromAssignmentId` 的晚到事件只记 `admissionProjection: stale_assignment` 并消费游标，
   不改状态、不动预留。

边界（不因本单回退）：`paused` 不自动开工；步骤间 `running` 保留同一 assignment；
`waiting_input` 仍由 #33 跟踪；`awaiting_review` 重启不启动 worker、不丢 PR、PR 关闭后正常结票。

## 3. 平台侧实现

### 3.1 `claimExecution`：同一事务内的权威迁移

`apps/dispatcher/src/reservations.ts`

- 入参新增可选的 `authoritative: AuthoritativeRuntimeAssignment`，字段是权威记录里的
  `ticketId`、`assignmentId`、`leaseId`、`fencingToken`、`state`、`sourceCursor`、
  `sourceEventId`、`observedAt`；同时必须带 `expectedAssignmentId`，即调用方读取该记录时
  预留行的 Assignment。
- 锁顺序与 `reserveExecution` 一致：先租约行，后预留行（`for update`），与并发 claim 不形成环。
- 先校验租约仍是该仓库 `active` 且 token 相同、预留行的 `ticket_id`/`lease_id`/`fencing_token`
  与入参一致。
- 锁内先比对 `expectedAssignmentId`：如果预留行已经被另一次恢复改走，直接返回
  `conflict: 'reservation_moved'`，不写入。随后若目标 Assignment 已在台账里作为
  `fromAssignmentId` 出现过（`assignment_superseded`），返回
  `conflict: 'target_superseded'`，同样不写入——这是“拒绝已记录为被替代的 assignment”。
- 仅当 `authoritative` 与本代次逐项相等、`expectedAssignmentId` 仍是锁内旧值、运行时状态为
  `queued`/`running`、预留行为 `reserved`/`claimed`、且 Assignment 确实不同，才在**同一事务**内：
  1. `update execution_reservations set assignment_id = …`（只改这一列，保留全部既有键）；
  2. 追加 `runtime_lease_events(type='assignment_superseded')`，`detail` 记录
     旧值 `fromAssignmentId`、新值 `toAssignmentId`、`requestKey`、`reservationState`、
     `source: 'bridge_snapshot'`、`sourceEventId`/`sourceCursor`、`runtimeState`、`observedAt`；
  3. 同一事务内完成 `reserved → claimed`。
- 其他任何差异仍抛 `execution reservation identity or generation does not match`，不迁移。

### 3.2 `recoverReservedTasks`：用权威快照驱动

`apps/dispatcher/src/sync.ts`

- 每轮先读 Bridge `GET /bridge/v1/tickets/:id`（文档定义的权威快照），把“读记录时预留行的
  Assignment”作为 `expectedAssignmentId` 一并交给事务里的 `claimExecution`，由它锁定并复核
  Ticket、租约、token 和记录字段。快照读取在事务前完成，HTTP 不占数据库锁；事务内的
  `expectedAssignmentId` 比较保证提交时预留行仍是该快照对应的旧值。
- 冲突时在**同一轮**重读预留行与权威快照后再试一次：旧快照（A2）若在更新的采纳（A1→A3）
  之后才拿到锁，会得到 `reservation_moved`；恢复据此重读 A3，第二次比较命中当前回合。连续
  两次冲突说明仍在并发变化，保留现状留给下一 tick，不猜测。
- 查询同时覆盖 `reserved` 与 `claimed` 的预留行：`claimed` 只在租约仍 `active` 时纳入，覆盖
  「回合已 claim、重启后状态不变地重发」这一旧实现看不见的分支。
- 已 `claimed` 且已指向活回合的行不再 claim；仅当有旧恢复证据时清除证据。
- 采纳时记 `admission.assignment_adopted`，并把 `sourceEventId`（该任务最近一条 Bridge 事件，
  若存在）与当时的 `runtime_cursors.cursor` 写入台账，作为「来源事件」。
- 非当前代次/非活状态/快照不可达时保持原预留，按既有格式记录 `snapshot_mismatch` 或
  `generation_mismatch`。

### 3.3 事件投影：被替换回合不得回写

`ticket.state_changed` 在租约与 token 匹配、但事件 Assignment 已被台账记为
`fromAssignmentId` 时，只写 `admissionProjection: 'stale_assignment'`、推进游标并返回；
不迁移、不投影。新回合（尚未采纳的更大 Assignment）不受影响，仍可投影，随后由权威快照采纳。

### 3.5 运行时补丁 0031：宿主重启后的 stop proof

现场 A 首次复现出一个运行时缺陷：宿主重启后 `Assignments.interrupted()` 会创建新的 pending
Assignment，但旧的已结束 Assignment **没有 stop proof**；新加入的 replacement 准入
（`replacementBlocked`）因此永远返回 true，launch 效果每 5 秒以 `Later` 重试，票停在 `queued`，
后续输入不产生事件——与旧 PR #50 记录的现场现象一致。

`integrations/superagent/patches/0031-host-restart-stop-proof.patch`：

- `src/executor/stop-proof.ts`：新增实例 cgroup 读取与 `hostRestartProof`/`hostRestartProven`。
  当前宿主启动后，实例 cgroup 中任何早于本宿主启动时间（`/proc/<pid>/stat` 第 22 字段）的进程
  都是上一个宿主的遗留；没有这种进程、也没有未知启动时间时，才能证明旧回合不存在。
- `src/executor/dsh.ts`：`resume()` 在创建替换 Assignment 前先为被打断的 Assignment 记录
  stop proof；无登记 job 且 cgroup 无更老进程时完成 proof。登记 job 仍由停止回调完成后放行。
- `launch()` 在 `assertStops` 前重试结算 `endedReason=hostRestarted` 的未完成 proof，孤儿进程
  退出后的下一次 launch 可以继续，不会把 replacement 永远钉死。
- 上游契约测试 `tests/stop-proof.spec.ts` 增加 host restart proof 用例；补丁按 0001–0031
  顺序应用、typecheck、build 均通过（见现场制品记录）。

### 3.6 范围

- 无数据库迁移、无状态机/租约规则变更、无上游补丁；不改 runtime/Bridge。
- `appendLeaseEvent` 从 `leases.ts` 导出以复用台账写入（唯一导出变化）。

## 4. 真实 PostgreSQL 用例

隔离 PostgreSQL 16（`127.0.0.1:55432`，独立库，测试后 `DROP DATABASE ... WITH (FORCE)`）：

`apps/dispatcher/test/integration/restart-interrupted-reconcile.integration.test.ts`

1. **重启重发、无状态事件**：已 `claimed` 的预留行在旧回合被替换后，快照只改 Assignment、
   状态仍 `queued`，没有任何事件。恢复必须采纳新 Assignment、保留 `id`/`request_key`/
   `task_id`/`ticket_id`/`lease_id`/`fencing_token` 与 `claimed`，台账恰好一条；再跑一轮
   不新增；后续 `running` 事件推进游标；随后真实跟进消息只投一次（`deliveries` 一行、
   `upstream_trigger_id` 稳定、只一个 trigger 调用）。
2. **新旧回合交错**：采纳后旧回合的 `state_changed`（同租约、同 token）晚到，只记
   `stale_assignment`，任务仍 `running`、预留仍指新回合、台账仍一条。
3. **非活代次不采纳**：另一个 lease 的事件与快照都不能迁移；事件记 `stale_generation`，
   快照记 `snapshot_mismatch`，预留与台账不变。
4. **快照在飞行中变旧**：恢复读到旧快照 A2 的同时，另一条路径已把预留采纳到 A3；旧快照
   返回后必须 `reservation_moved`、重读权威记录，最终预留保持 A3，台账只有 A1→A3，
   不出现 A3→A2 的倒退。若重读仍返回旧记录 A2，平台无法排序（Assignment 无运行时时间戳），
   必须保留 A3 留给下一 tick，不能反向采纳；下一轮用与预留一致的记录收口。
5. **开放 PR 的 `awaiting_review` 跨重启**：重启对账保留状态与 `pr_url/pr_number`，维护释放
   租约且不启动 worker；PR 关闭后转 `closed_unmerged`，仍不启动。

`apps/dispatcher/test/integration/reservations.integration.test.ts`（真实库、直接调用）：

- 只有与预留行逐项相等的权威记录才迁移；Ticket/lease/token/Assignment/运行时状态任一不匹配、
  或缺少权威记录时全部拒绝，预留不动。
- 迁移只改 Assignment，预留行其余键与状态保持；台账旧值/新值/来源游标/观察时间正确。
- 重放同一权威记录：`supersededFrom: null`，不新增台账。
- 两个并发恢复读取同一权威记录：租约锁串行化；先到者采纳一次，后到者因
  `expectedAssignmentId` 已过期得到 `reservation_moved`，最终一条台账。
- 倒退保护：A1→A2→A3 之后，晚到的 A2 快照分别以 `expectedAssignmentId=A3` 和
  `expectedAssignmentId=A2` 到达，得到 `target_superseded` 与 `reservation_moved`；
  预留保持 A3，台账顺序仍为 A1→A2、A2→A3。

`recovery-review-idempotent.integration.test.ts` 由旧的「重复 snapshot_mismatch 幂等」改为
「重复权威采纳幂等」：首轮采纳 `assignment-reissued` 并 claim，次轮版本与证据不变、台账不增。

## 5. 修前 / 修后

同一命令、同一隔离库；修前仅保持 `apps/dispatcher/src` 为基线，加入本单测试。

| 状态 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 修前（红，首轮实现） | 见 [`isolated-red.log`](evidence/m5b/restart-reconcile/isolated-red.log) | 1 | 3 文件失败，5 failed / 4 passed |
| 修后（绿，首轮实现） | 见 [`isolated-green.log`](evidence/m5b/restart-reconcile/isolated-green.log) | 0 | 3 文件通过，9 passed |
| 修前（红，并发旧快照返修） | 见 [`isolated-interleave-red.log`](evidence/m5b/restart-reconcile/isolated-interleave-red.log) | 1 | 5 failed / 7 passed |
| 修后（绿，并发旧快照返修） | 见 [`isolated-interleave-green.log`](evidence/m5b/restart-reconcile/isolated-interleave-green.log) | 0 | 3 文件通过，12 passed |
| 全量静态+单测 | `pnpm check` | 0 | lint/format/8 项目 typecheck；unit 通过 |
| 全量集成 | `pnpm test:integration` | 0 | db 54、api 142、dispatcher 108/1 skipped、supervisor 4 |
| 现场 A（隔离栈，含运行时补丁 0031） | `bash scripts/m5b/matrix/item5-restart.sh running-live` | 0 | Bridge/dispatcher/supervisor/API/PG 重启；cursor 5→8→9→10；deliveries 1→2；1 个 worker |
| 现场 B（真实 PR #17） | `M5B_MATRIX_RESTART_BEFORE_CLOSE=1 bash scripts/m5b/matrix/item5-awaiting-review.sh` | 0 | 重启后仍 awaiting_review、PR 绑定不变、无新 Assignment/operation/delivery；关闭后 closed_unmerged |

修前第一条失败：`expected 'assignment-after-restart' to be 'assignment-before-restart'`
（预留行没有跟随运行时重发的回合）。

全量检查的套件汇总见
[`full-checks.log`](evidence/m5b/restart-reconcile/full-checks.log)；完整 SHA、构建制品哈希与
未验证项见 [`artifacts.txt`](evidence/m5b/restart-reconcile/artifacts.txt)。

## 6. 与旧 PR #50 的增量

| 项 | 旧 PR #50 | 本单 |
| --- | --- | --- |
| 采纳依据 | `ticket.state_changed` 事件 | Bridge 权威 Ticket 快照；事件只作来源线索 |
| 无状态事件的重发 | 看不到，无法采纳 | 覆盖（真实 PG 用例 1） |
| 已 `claimed` 的预留 | 恢复查询不覆盖 | 覆盖，且只在租约仍 active 时 |
| 迁移与 claim | 事件路径迁移，后续 claim 另做 | 同一事务内迁移 + claim |
| 并发/重放 | 未覆盖同记录并发 | 租约/预留行锁串行化，台账只一条（用例 4） |
| 旧回合晚到事件 | 仍可投影 | `stale_assignment` 拒绝 |
| 数据库迁移 | 无 | 无 |

## 7. 现场复跑（已执行，2026-11-20）

结果与原始日志：

- 现场 A：[`field-item5-running-live.log`](evidence/m5b/restart-reconcile/field-item5-running-live.log)，
  Bridge 450966→451817、dispatcher 451131→451910，cursor 5→8→9→10，deliveries 1→2，
  `worker_session_dirs=1`，旧 Assignment `hostRestarted`、新 Assignment `running`。
- 现场 B：[`field-item5-awaiting-review.log`](evidence/m5b/restart-reconcile/field-item5-awaiting-review.log)，
  真实 PR `Bouyer12/m5a-beta-adf10ad9#17`；重启前后 runtime 保持 `awaiting_review`、
  PR JSON 一致、`ended=null`，平台无新 Assignment/operation/delivery；关闭后 `closed_unmerged`。
- 制品与编排修正：[`field-artifacts.txt`](evidence/m5b/restart-reconcile/field-artifacts.txt)。

原复跑判据（保留供复核）：

前置：

1. #92 的隔离验收环境可用（专用探测凭据与 `stack.sh` 的 fail-closed 门禁不得绕过）；
2. #94 的实例生命周期在隔离 Linux unit 上就绪；
3. 与 #96 的 dispatcher 改动按「本单优先」顺序落地，现场证据在合并后的同一构建上跑；
4. 上游参考目录只读，运行时改动只能走 `integrations/superagent/patches/`。

### 场景 A：打断运行回合

```bash
source /tmp/m5bmatrix/state.env
bash scripts/m5b/matrix/item5-restart.sh running-live
```

判据（全部满足；原始值入库）：

| # | 判据 | 记录 |
| --- | --- | --- |
| A1 | Bridge 与 dispatcher 的新旧 PID 都变化 | 重启前后 PID |
| A2 | 运行时旧 assignment `endedReason=hostRestarted`、新 assignment 存在，票经 `queued → running` | `/bridge/v1/tickets/:id` 快照 |
| A3 | 平台 `runtime_lease_events` 有 `assignment_superseded`（旧值/新值/来源），`execution_reservations.assignment_id` 指新回合且既有键不变 | 两侧 SQL |
| A4 | 后续输入 `deliveries` 恰好 1 行、`delivered`、`upstream_trigger_id` 稳定；重放返回 duplicate | 平台 SQL + Bridge 响应 |
| A5 | `runtime_cursors` 因重启事件推进一次、**后续真实输入再推进一次** | 三段原始值 |
| A6 | 同一 assignment 的 launch 计数为 1，无第二个 worker/session | 运行时日志/计数 |

### 场景 B：开放真实 PR 的 `awaiting_review`

```bash
source /tmp/m5bmatrix/state.env
bash scripts/m5b/matrix/item5-awaiting-review.sh
# PR 开放、票仍 awaiting_review 时重启 Bridge + dispatcher + 两库
```

| # | 判据 |
| --- | --- |
| B1 | 重启后票仍 `awaiting_review`，`pr.number/url` 不变、`ended` 为 null |
| B2 | 平台任务 `pr_url/pr_number` 保留，租约 `released`，`task_links.runtime_lease_id` 为空 |
| B3 | 无自动开工：无新 launch/start、无新 operation、无新投递 |
| B4 | 关闭 PR（不合并）后票转 `closed_unmerged`，平台同步，租约不占用 |

两侧完整 head、干净工作树、`apps/dispatcher/dist/main.js` 与运行时 `lib/index.js` 的 sha256、
新旧 PID 与脱敏日志入库。

## 8. 回退

- 代码：`git revert` 本 PR 提交并重建/重启 dispatcher；无上游补丁需要撤销。
- 数据：无 schema 变更，无需迁移回滚。已被采纳的预留行继续指向当时的权威回合，这是正确的
  运行状态；旧值保留在 `runtime_lease_events.detail`，回退代码不会把预留改回已结束的回合，
  也不会删除台账。若必须人工恢复某一行，用台账里的 `fromAssignmentId` 与当时的快照人工核对，
  不在回退脚本里自动改写。
- 回退后 `claimed` 预留行的恢复查询回到 `reserved` 范围；不影响已 claim 的当前回合。

## 9. 未验证与限制

1. 多仓库同时重启、`discussing` / `waiting_input` 回合的宿主重启（`waiting_input` 由 #33 跟踪）。
2. 宿主真实重启（OS reboot）而非本轮进程级重启；进程与两个数据库的隔离重启已完成。
3. 运行时孤儿进程长期存活时 replacement 会继续等待，待其退出后的下一次 launch 才会放行；
   本轮没有注入长期孤儿。
5. 台账的 `sourceEventId` 只在该任务已有 Bridge 事件时存在；无事件的重发只有
   `source: bridge_snapshot` + `sourceCursor`，这是权威记录的来源位置，不冒充事件。
6. 冲突重读最多一次：连续冲突时保留现状、等下一 tick；极端持续并发下会多延迟一个事件
   同步周期，但不会倒退或重复迁移。
