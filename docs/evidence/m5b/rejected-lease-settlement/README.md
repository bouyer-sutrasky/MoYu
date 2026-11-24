# 拒接任务按执行代次结清预留与租约（#96）

## 基线与分支

- 实施基线：`b6c2efab08e2703cc8e974dda7ff872db3122612`（2026-11-20 最新 `main`）。
- 分支：`agent/rejected-lease-settle-7baf8c04617e`。
- 上游依赖：`#95` 的 dispatcher 改动尚未落地；落地后需以新的 `main` 重跑本记录的自动化检查与现场验收。
- 环境：本机隔离 PostgreSQL `127.0.0.1:55432`（`/tmp/moyu-pgdata`），Node `v22.23.3`、pnpm `11.7.0`。没有触碰生产库、3082 bootstrap、4300/4310 线上服务。

## 改动摘要

- `decision.ignored` 按回执点名的每条消息逐条读取投递，要求投递存在且 `runtime_lease_id` / `fencing_token` 均非空并指向同一代次；随后锁定任务与租约，与当前代次比对。迟到回执命名旧代次时，不关闭新代次任务、不释放新代次租约。
- 投递缺失、租约或 token 为空、同租约 token 冲突、顺序置换或与锁定租约不一致时，保留任务、预留和租约，写 `ignored_evidence_rejected` 事件与结构化日志说明原因。
- 关闭 admission 与结清在同一事务：仅当无 runtime Ticket、无 `claimed` 预留、无在途投递、无排队命令、没有其它任务绑定该代次时，才把 `reserved` 预留置 `abandoned`、租约置 `released`（写 `stop_proof.kind=admission_ignored` 与释放事件）、清空任务绑定。
- 任一证据表明可能已执行时，任务仍投影为 `not_accepted`，但保留租约并写 `recovery_state=blocked`、`waiting_for=execution_stop_proof` 和可读原因。
- 普通拒绝与 `routed` 共用同一套代次校验；`#82` 的 routed 决策、目标链接和中文通知路径保持不变。
- 启动恢复 `recoverIgnoredLeases` 不再按 holder 盲放；历史 `not_accepted + active lease` 行按同一证据规则结清或保留。
- 无数据库 schema 变更，无上游补丁。

## 修前（红）与修后（绿）

修前使用基线 `b6c2efa` 的 `apps/dispatcher/src/{leases,sync}.ts`，只带入本次新增的回归测试：

```bash
$ TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
    pnpm --filter @moyu/dispatcher exec vitest run \
    test/integration/decision-lease.integration.test.ts
# exit 1；9 failed / 2 passed
```

原始输出：[`red-baseline.txt`](./red-baseline.txt)。

P2 审查（逐条校验投递证据）修复前，使用 head `f04f18a` 的
`apps/dispatcher/src/{leases,sync}.ts`，带入本次新增的逐条证据用例：

```bash
$ TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
    pnpm --filter @moyu/dispatcher exec vitest run \
    test/integration/decision-lease.integration.test.ts
# exit 1；6 failed / 9 passed
```

原始输出：[`p2-red-baseline.txt`](./p2-red-baseline.txt)。

修后：

```bash
$ TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
    pnpm --filter @moyu/dispatcher exec vitest run \
    test/integration/decision-lease.integration.test.ts
# exit 0；15 passed

$ TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
    pnpm --filter @moyu/dispatcher exec vitest run \
    test/integration/routing.integration.test.ts
# exit 0；13 passed

$ TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
    pnpm test:integration
# exit 0
# db 17 files / 54 tests
# api 18 files / 142 tests
# dispatcher 19 files passed + 1 skipped；113 passed + 1 skipped
# supervisor 1 file / 4 tests

$ pnpm check
# exit 0（lint、format、typecheck、unit tests、script tests）

$ pnpm build
# exit 0；dispatcher dist/main.js 282.53 KB
$ sha256sum apps/dispatcher/dist/main.js
0f67b57bc0df570470f4b0b1760f661b2e356c8940d42db7c39e92591e5ff9bf
```

原始输出：[`green-decision-lease.txt`](./green-decision-lease.txt)、
[`green-routing.txt`](./green-routing.txt)。

回归覆盖：

- 未开工代次：预留 `abandoned`、租约 `released`、任务绑定清空、释放事件一次；同仓下一任务取得更大的 fencing token 并真正可启动。
- 逐条投递证据：回执点名的每条消息都必须有投递，且租约 ID 与 fencing token 均非空、彼此一致；随后持锁比对任务绑定和租约行。部分消息缺投递、空 token、同租约 token 冲突、顺序置换以及投递 fence 与锁定租约行不一致时，均保留任务、预留和租约，并写 `ignored_evidence_rejected` 事件与结构化日志。
- `routed`：同一结清逻辑，`decision.outcome=routed`、目标 Ticket/任务/会话与 `routingState=pending` 保留。
- 迟到回执：旧代次消息不关闭新代次任务，不释放新租约，并记录代次不一致原因。
- 已有 runtime Ticket、已 `claimed` 预留、排队命令、在途投递：保留代次并记录具体原因。
- 两个 dispatcher 并发应用同一回执：只释放一次、只产生一个释放事件、预留只置一次 `abandoned`。
- 历史 `not_accepted` 行：无 runtime Ticket 时结清；有 runtime Ticket 时保留并阻塞。

## 与旧 PR #51 的增量

- 保留并复用其 `settleIgnoredAdmissionOn` 证据检查思路，但适配了 `#82` 已合入的 `routed` 决策、目标链接和中文通知。
- 修正其“先清空任务绑定再结清”的顺序问题：本实现先锁定并比对代次，再在同一事务内结清，失败时保留绑定。
- 未带入旧 PR 对 `scripts/m5b/local-provider.mjs`、`matrix/stack.sh` 和现场驱动脚本的修改；现场环境改由 `#92` 的隔离环境提供。
- 未改 schema；旧 PR 也没有迁移。

## 待验项（现场，依赖 #92 与 #95）

以下现场判据尚未执行，不能宣称已通过：

1. 真实 Bridge 收到 `decision.ignored` 后，同仓后续任务在旧 1 小时 TTL 前真正取得新代次并启动 worker。
2. 迟到/重放的真实回执不影响新代次租约与 worker。
3. 真实返修流程更新同一 PR，源会话只收到一次中文完成通知。
4. 使用 `#92` 的隔离环境与凭据边界，确认宿主哨兵与其它仓库不受影响。
5. `#95` 落地后以新的 `main` 重跑本文件全部自动化命令。

## 回退

- 代码回退：revert 本 PR 的提交，重新部署上一版 dispatcher 产物。
- 数据回退：无 schema 迁移；已结清的租约为 `released`、预留为 `abandoned`，恢复旧版本不会自动复用这些代次，需按既有租约恢复流程处理。
- 运行中服务：本 PR 未改部署单元、端口或 systemd 配置。

## 对齐 main 后的隔离现场（2026-11-24 UTC）

- 基线 `main@24de84534557f04f5ad4576279b7a317b5e78f21`，现场代码 `16f80ec475f1e700a70445718ec4afb29810bdf3`。
- `pnpm check`、`pnpm build` 均退出 0。GitHub Actions [45312500347](https://github.com/bouyer-sutrasky/MoYu/actions/runs/45312500347) 的 check 与真实 PostgreSQL integration 均通过。
- dispatcher SHA-256 `772e3e37b4bc42302f6d1ba821e84b9b9ae2d3a1cf8b53da07d750d035ba9b1a`。先用默认 runtime `64ce5c5aeb6d0671a195ee5aad66c941a641c29919f1a7603fe64cd0b288df6f` 验拒绝与重放。返修阶段改用包含 0029 报告归属字段的制品 `f37ecf5ebc2411057c5b0de92adde33bc95ad9b408346c6e5ffc164ffcf52f23`。旧制品缺少 `report.assignmentId`，只交接与更新 PR，正确保留了通知。
- 用 `scripts/m5b/matrix/stack.sh up` 启动 #92 隔离栈。在线门禁报告 `host_boundary=clean` 和 `verdict=clean`，包括专用探测凭据和私有负对照仓库。场景通过 `live.mjs new-task` 从真实 API 进入，loopback provider 依次调用 runtime 的 `orchestrator_route` 的 `ignore`、`accept` 和 `attach`，Bridge 生成实际回执，dispatcher 正常消费。
- 普通拒绝任务 `da99e0ee-aad1-4d8e-b6dc-6ac2c83d86d2` 为 `not_accepted`；旧租约 `21c129ec-5ebe-4fd6-9dc3-29e1977e3b3f` 在 TTL 前以 `admission_ignored` 释放。后续任务 `44839cd1-4994-47f3-a23f-5d8fc6a116d3` 在旧 TTL 前取得更高 fence 的租约 `bd6e3560-74ca-4a63-8d56-877300ed0752` 并进入 `running`。
- 在隔离 PostgreSQL 将 `runtime_cursors.cursor` 退到真实 `decision.ignored` 的前一条，让 dispatcher 重读 Bridge。游标追上原位置后，旧租约仍为 released、只有一条 released 事件，新租约仍为 active，代次和 TTL 断言保持通过。
- 真实返修源会话 `86ce224f-56c5-4231-824a-5ba7609b1863` 交接到 Ticket `f984f699eab58672c53aa597dc072173`。worker 通过真实 Git push 更新同一张 [测试 PR #19](https://github.com/Bouyer12/m5a-beta-adf10ad9/pull/19)，head 从 `c001961879c35b43600ddfdde8a750e982331a35` 更新为 `016bfaf713f932eef91e256476e2de442daa1e7a`。目标保持 `awaiting_review`，源任务的 routingState 为 `handed_off`。按源会话查询包含「已转交的返修已完成」和「PR #19」的出站消息，第一次和后续轮询均为 1 条。
