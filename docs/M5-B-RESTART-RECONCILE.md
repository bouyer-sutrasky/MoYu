# M5-B 打断回合恢复与待审阅票双库重启对账

排单键 `M5B-D02F07F-RESTART-RECONCILE`（Issue #39）。基线 `main@d02f07f1`，实现时对齐到
`main@1001c25`（PR #46 之后）。本文只写**已实际执行**的检查与结果；现场（真实双库重启）部分
尚未执行，按 §5 的方案在 #36 落地后复跑，本文不把它表述为通过。

## 0. 本轮到哪了

| 段 | 内容 | 状态 |
| --- | --- | --- |
| 隔离红测 | 打断回合的「旧代次可追溯 / 预留行跟随 / 后续真实输入只投一次 / 游标推进」；`awaiting_review` 携带开放 PR 跨重启不自动开工、不丢 PR、PR 关闭正常结票 | **完成**（红→绿，见 §4） |
| 平台侧修复 | 同代次下运行时重发 assignment 时，预留行跟随并记台账（§3） | **完成**（本 PR） |
| 现场复跑 | 真实 Bridge + dispatcher + 两库完整隔离重启的前后对账（`awaiting_review` 开放期间重启、打断回合后的真实后续输入） | **未执行**：依赖 #36 的隔离验收环境（PR #49），上游补丁与构建需与 #33 协调（§5、§6） |
| `waiting_input` | 由 #33 独立跟踪，本文只固定边界，不改判据 | 不在本单 |

现场矩阵留下的原始观测（不改旧结论）：

- 打断回合：`docs/evidence/m5b/matrix/item5-running-interrupted-turn-restart.log` ——
  `assignment` 重发、平台 `running → queued`、`runtime_cursors` 只在重启时 2 → 3，随后的真实 Bridge
  投递没有再推进，脚本判定 `NOT proven`。
- 待审阅：`docs/evidence/m5b/matrix/item5-awaiting_review-pr.log` —— 真实 open PR 下
  `awaiting_review` 出现、关闭后转 `closed_unmerged`，但**开放期间没有做重启**。
- 步骤间 running：`docs/evidence/m5b/matrix/item5-running-between-steps-restart.log` —— 已通过，本单
  作为不回退的边界保留。

## 1. 代次与职责

一次执行代次的平台标识是 **（Ticket, 租约, fencing token）**。`assignmentId` 不是平台代次，
它是运行时自己的回合编号：宿主重启打断回合时，运行时结束旧 assignment 并**在同一个租约下**
重发一个新的。

| 事实 | 负责方 | 持久记录 |
| --- | --- | --- |
| 旧回合结束（`endedReason: hostRestarted`）、新回合创建、恢复注记与未取输入重新入队 | 运行时 `Assignments.interrupted()` / `Tickets.restart()` | 运行时 Ticket 存储（`assignments[]`） |
| 新回合的启动与「一个回合只启动一次」 | 运行时 effect 队列（`launch` 按 assignment id 幂等） | 运行时 effect KV |
| 平台投影、租约与回执、投递去重、游标 | dispatcher | `task_links`、`runtime_leases`、`runtime_lease_events`、`deliveries`、`runtime_cursors` |
| 预留行（丢响应恢复用）跟随当前回合 | dispatcher | `execution_reservations` + `assignment_superseded` 台账 |

## 2. 安全恢复语义（本单确认的规范）

宿主在回合进行中重启后：

1. **S1 同一张票、同一个租约**。重启不是新的执行代次：fencing token 不变，旧回合结束、新回合开始，
   票回到 `queued` 再由新回合推到 `running`。
2. **S2 旧代次与副作用可追溯**。旧回合的 `endedReason` 留在运行时 Ticket 里；平台在
   `runtime_lease_events` 记一条 `assignment_superseded`（`fromAssignmentId`/`toAssignmentId`/
   `bridgeEventId`/`reservationState`）。两者都不改写、不删除。
3. **S3 预留行跟随当前回合**。`execution_reservations` 指向新回合；否则同一代次的后续快照与
   `claimExecution` 全部按「不同身份」拒绝，丢响应恢复永远无法收口。
4. **S4 恢复不产生第二个 worker、不重复投递**。一个回合一次启动（运行时）；一条消息一条
   `deliveries` 行、一个 `upstream_trigger_id`（平台）。恢复注记是运行时自己入队的输入，
   平台不得把它当成一次投递再发一次。
5. **S5 真实后续输入必须成功且推进游标**。重启后的人话在同一个 Ticket 上被投递一次；
   `runtime_cursors` 必须因**重启事件**与**后续输入产生的运行事件**分别推进，而不是只在重启时动一次。
6. **S6 只在当前代次投影 raising**。非当前租约/token 的 `queued`/`running` 仍是陈旧事件：
   只记 `admissionProjection: stale_generation`，不改状态、不推进状态机（既有行为，本单保留）。

边界（不得因本单改动而回退）：

- `paused`：重启不启动、不发事件；只有带租约的 `resume` 才换新回合，游标随 resume 之后的事件推进。
- 步骤间 `running`（最后报告 `waiting`，回合已结束但仍持租约）：重启保留同一 assignment，不重发。
- `waiting_input`：由 #33 的上游补丁把 `ticket.attention` 计入 settled；本单不依赖、也不改动它。
- `awaiting_review`：票在等人，重启既不启动 worker 也不丢 PR；PR 关闭后由 `closed_unmerged` 正常结票。
- 租约/token 不同：仍是陈旧代次，走既有拒绝路径；本单的跟随只发生在**同代次**。

## 3. 平台侧实现（本 PR）

修复前（红，见 §4）：重启事件把票正确投影成 `queued`，但

- `execution_reservations` 仍指旧 assignment，平台无法回答「现在活着的是哪个回合」；
- 随后每个快照都被 `recoverReservedTasks` 记成 `admissionRecovery: snapshot_mismatch`，
  `claimExecution` 永远匹配不上，丢响应恢复无法收口；
- 旧代次在新回合到来后没有任何平台侧账目。

修复：

- `reservations.ts` 新增 `supersedeReservationAssignmentOn`：在同一事务里锁定预留行，
  只有 **ticket + lease + fencing token 相同、assignment 不同、状态为 `reserved`/`claimed`**
  时才把 `assignment_id` 指向新回合，并写一条 `runtime_lease_events(type='assignment_superseded')`。
  其余情况返回 `null`，行为不变。
- `sync.ts` 的 `ticket.state_changed`：在确认事件属于**当前活动代次**之后、读取预留行之前调用它，
  于是后续的 `reservationMismatch` 判定看到的是跟随后的身份；非当前代次的路径一个字没动。
- `leases.ts` 的 `appendLeaseEvent` 改为导出，供上面的台账复用。

不改平台状态机、不改租约规则、不改 `waiting_input` / `awaiting_review` 的判据；无数据库迁移。

## 4. 隔离红测（可复跑）

用例：`apps/dispatcher/test/integration/restart-interrupted-reconcile.integration.test.ts`
（真实 PostgreSQL，假 Bridge 只提供传输层；不需要现场矩阵、不需要 GitHub、不碰 3082）。

| 用例 | 覆盖的语义 |
| --- | --- |
| `keeps an interrupted turn traceable, delivers the follow-up once, and advances the cursor` | S1、S2、S3、S4、S5、S6 |
| `neither starts work nor drops the PR of an awaiting_review ticket across a restart, and ends it when the PR closes` | `awaiting_review` 跨重启不入队、不丢 PR、不占名额、关闭后结票 |

修复前（`git stash push -- apps/dispatcher/src`）原始输出见
`docs/evidence/m5b/restart-reconcile/isolated-red-green.log`：新用例红在

```text
AssertionError: expected 'assignment-before-restart' to be 'assignment-after-restart'
```

修复后同一文件 2/2 通过，dispatcher 集成全量 82 passed / 1 skipped。

**这个红测证明什么、不证明什么**：它证明平台侧对同代次重发 assignment 的对账语义，以及
「后续输入只投一次 + 游标推进」。它**不是**打断回合现场证据：真实的 worker 重启、launch 是否
真的起得来、两侧数据库同时重启后的对账，仍必须按 §5 在现场复跑。

## 5. 现场复跑方案（#36 落地后执行）

前置：

1. #36（PR #49）合并，现场矩阵改用独立测试身份与仅探测仓库凭据；
2. #33 的上游补丁定稿：它会让 `waiting_input` 保持同一 assignment 并改变 runtime 产物
   （`lib/index.js` hash 变），所以本单的现场证据必须在**同一份** 0001–00NN 补丁构建上跑；
3. 上游参考目录只读：改动走 `integrations/superagent/patches/`，不修改 `/root/src/upstream/*` 源码。

### 场景 A：打断回合

```bash
source /tmp/m5bmatrix/state.env
bash scripts/m5b/matrix/item5-restart.sh running       # 步骤间 running：不回退
bash scripts/m5b/matrix/item5-restart.sh running-live  # 回合进行中：本场景
```

判据（全部满足才算通过）：

| # | 判据 | 记录位置 |
| --- | --- | --- |
| A1 | 旧 PID 消失、新 PID 出现；dispatcher 也换了 PID | 日志 `bridge_pid_before/after`、`dispatcher_pid_before/after` |
| A2 | 运行时快照：旧 assignment `endedReason=hostRestarted`、新 assignment 存在，票经历 `queued → running` | 快照 `assignments[]`、`/bridge/v1/tickets/:id` |
| A3 | 平台 `runtime_lease_events` 出现 `assignment_superseded`，`execution_reservations.assignment_id` 指向新回合 | 两侧 SQL |
| A4 | `deliveries` 中该输入恰好 1 行、`delivered`、`upstream_trigger_id` 稳定；重放返回 `duplicate` | 平台 SQL + Bridge 响应 |
| A5 | `runtime_cursors`：重启事件推进一次、**后续真实输入带来的运行事件再推进一次**（本次必须严格大于重启后的值） | 三段原始值 |
| A6 | 只有一个 worker：同一 assignment 的 launch 计数 1，无第二个 session/job | 运行时日志/计数 |

若 A5 仍不推进，按 §7 记录的现场事实继续定位（上一轮的现象是重启后新回合停在 `queued`，
后续输入没有产生任何事件）。

### 场景 B：开放 PR 的 `awaiting_review`

```bash
source /tmp/m5bmatrix/state.env
bash scripts/m5b/matrix/item5-awaiting-review.sh        # 建票 → 真实 PR → awaiting_review
# 在 PR 仍开放、票仍是 awaiting_review 时重启 Bridge + dispatcher + 两库
```

判据：

| # | 判据 | 记录位置 |
| --- | --- | --- |
| B1 | 重启后票仍 `awaiting_review`，`pr.number/url` 不变、`ended` 仍为 null | 重启前后快照 |
| B2 | 平台任务仍 `awaiting_review`，`pr_url/pr_number` 保留，租约 `released`、`task_links.runtime_lease_id` 为 null | 平台 SQL |
| B3 | 没有自动开工：Bridge 无新 launch/start，`task_operations` 无新命令，`deliveries` 无新增投递 | 两侧 SQL + Bridge 日志 |
| B4 | `runtime_cursors` 不因重启之外的原因变化（重启本身可以有事件，但没有运行事件） | 三段原始值 |
| B5 | 关闭 PR（不合并）后票转 `closed_unmerged`，平台同步，租约不再被占 | 快照 + 平台 SQL |

两侧产物与身份：记录完整 40 位 head、干净工作树、`apps/dispatcher/dist/main.js` 与
runtime `lib/index.js` 的 sha256、新旧 PID；日志脱敏后入库。

## 6. 依赖与边界

- **#36 隔离验收环境**（PR #49）：现场复跑的前置，本单不重复它的修复。
- **#33 上游 `interrupted()` 判据**：与本单共用 `interrupted()` 入口，改动会影响 runtime 产物，
  现场证据必须在新产物上重跑；本单不替它决定 `waiting_input` 的语义。
- 本单不改 `/root/src/upstream/*` 源码、不重启 3082、不碰生产库与其它仓库。

## 7. 未验证项

1. 真实双库重启下场景 A、B 的全部判据（本 PR 只到隔离层）。
2. 重启后**新回合是否真的起得来**：上一轮现场观测（`item5-running-interrupted-turn-restart.log`）
   是新回合停在 `queued`、后续输入没有产生事件。隔离红测不覆盖运行时 launch 的真实失败模式，
   需在 #36 的现场用 A2/A5/A6 判据定位；若确认是运行时缺陷，按规矩走
   `integrations/superagent/patches/` 补丁，不在本单夹带。
3. `waiting_input` 的跨重启保持（#33）。
4. 现场只跑过单仓库、单票；多仓库同时重启未验证。
