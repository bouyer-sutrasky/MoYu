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
| 真实重启现场 | 隔离栈打断任务后重启 Bridge、dispatcher 和两库，追加真实消息并核对游标与单 worker | **未执行**：依赖 #92 环境与 #94 生命周期（§7） |
| 真实 GitHub PR 现场 | 真实开放 PR 在重启前后仍待审阅、关联稳定、关闭后正常结票 | **未执行**：同上（§7） |

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
  `sourceEventId`、`observedAt`。
- 锁顺序与 `reserveExecution` 一致：先租约行，后预留行（`for update`），与并发 claim 不形成环。
- 先校验租约仍是该仓库 `active` 且 token 相同、预留行的 `ticket_id`/`lease_id`/`fencing_token`
  与入参一致。
- 仅当 `authoritative` 与本代次逐项相等、运行时状态为 `queued`/`running`、预留行为
  `reserved`/`claimed`、且 Assignment 确实不同，才在**同一事务**内：
  1. `update execution_reservations set assignment_id = …`（只改这一列，保留全部既有键）；
  2. 追加 `runtime_lease_events(type='assignment_superseded')`，`detail` 记录
     旧值 `fromAssignmentId`、新值 `toAssignmentId`、`requestKey`、`reservationState`、
     `source: 'bridge_snapshot'`、`sourceEventId`/`sourceCursor`、`runtimeState`、`observedAt`；
  3. 同一事务内完成 `reserved → claimed`。
- 其他任何差异仍抛 `execution reservation identity or generation does not match`，不迁移。

### 3.2 `recoverReservedTasks`：用权威快照驱动

`apps/dispatcher/src/sync.ts`

- 每轮先读 Bridge `GET /bridge/v1/tickets/:id`（文档定义的权威快照），再在事务里交给
  `claimExecution`，由它锁定并复核 Ticket、租约、token 和记录字段。快照读取在事务前完成，
  HTTP 不占数据库锁；事务内的锁和逐项比较保证提交时仍是同一代次。
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

### 3.4 范围

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
4. **开放 PR 的 `awaiting_review` 跨重启**：重启对账保留状态与 `pr_url/pr_number`，维护释放
   租约且不启动 worker；PR 关闭后转 `closed_unmerged`，仍不启动。

`apps/dispatcher/test/integration/reservations.integration.test.ts`（真实库、直接调用）：

- 只有与预留行逐项相等的权威记录才迁移；Ticket/lease/token/Assignment/运行时状态任一不匹配、
  或缺少权威记录时全部拒绝，预留不动。
- 迁移只改 Assignment，预留行其余键与状态保持；台账旧值/新值/来源游标/观察时间正确。
- 重放同一权威记录：`supersededFrom: null`，不新增台账。
- 两个并发恢复读取同一权威记录：租约锁串行化，只有一个迁移一次，最终一条台账。

`recovery-review-idempotent.integration.test.ts` 由旧的「重复 snapshot_mismatch 幂等」改为
「重复权威采纳幂等」：首轮采纳 `assignment-reissued` 并 claim，次轮版本与证据不变、台账不增。

## 5. 修前 / 修后

同一命令、同一隔离库；修前仅保持 `apps/dispatcher/src` 为基线，加入本单测试。

| 状态 | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 修前（红） | 见 [`isolated-red.log`](evidence/m5b/restart-reconcile/isolated-red.log) | 1 | 3 文件失败，5 failed / 4 passed |
| 修后（绿） | 见 [`isolated-green.log`](evidence/m5b/restart-reconcile/isolated-green.log) | 0 | 3 文件通过，9 passed |
| 全量静态+单测 | `pnpm check` | 0 | lint/format/8 项目 typecheck；unit 通过 |
| 全量集成 | `pnpm test:integration` | 0 | db 54、api 142、dispatcher 105/1 skipped、supervisor 4 |

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

## 7. 现场复跑（依赖 #92、#94，尚未执行）

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

1. 真实双库重启下的场景 A、B 全部判据（依赖 #92、#94）。
2. 重启后运行时新回合是否真的起得来（上轮现场停在新回合 `queued`、后续输入没有事件）；
   隔离用例不覆盖运行时 launch 的真实失败模式，若确认是运行时缺陷按补丁流程另交。
3. `waiting_input` 跨重启（#33 跟踪）。
4. 多仓库同时重启、`discussing` 回合的宿主重启。
5. 台账的 `sourceEventId` 只在该任务已有 Bridge 事件时存在；无事件的重发只有
   `source: bridge_snapshot` + `sourceCursor`，这是权威记录的来源位置，不冒充事件。
