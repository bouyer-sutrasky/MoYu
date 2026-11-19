# M6-C B 段：PR 返修路由、执行交接与接单解释

本目录记录在隔离仓库、隔离 DSH 实例和隔离 PostgreSQL 上实际执行的 red → green。
截图与日志均为真实运行；没有用 mock 代替接单、执行或 PR 闭环。

## 基线

| 项 | 实际值 |
| --- | --- |
| `main` | `7e04a8a8b62bd7cfb0b00228668439d502adb714`（PR #81 合并后） |
| 分支 | `agent/pr-rework-routing-3cb6e2f7a321` |
| 测试仓库 | `Bouyer12/m6c-b-reroute-3cb6e2f7`（私有、一次性） |
| 测试 PR | #1，分支 `agent/change-value-to-2-3dba7ebf7c3d` |
| 数据库 | PostgreSQL 16，`127.0.0.1:55432`；红/绿库各从同一 `pre-rework` 快照恢复，22 条迁移 |
| 实例 | profile `m6c-b1`，panel `127.0.0.1:3491`，Bridge `127.0.0.1:4492`，`MOYU_REQUIRE_ADMISSION=1` |
| 平台 | API `127.0.0.1:4410` + dispatcher；未启动 supervisor |
| 生产 | 3082、正式库、正式服务均未改动 |

红基线使用 `origin/main` 独立 worktree 构建的 API/dispatcher；修复轮使用本分支构建。
两轮都从同一运行时状态快照、同一数据库快照和同一 PR head 开始。

## 复现的断点

1. 新任务入口向“待审阅”旧工单转交返修时，Bridge 发出
   `decision.ignored`，`reason.code=routed` 指向旧工单。平台 main 版本不解析原因，
   源任务只写成 `not_accepted`，`decision` 为空：UI 只显示“未接单”，没有目标工单链接，
   也不说明下一步。
2. 目标执行器实际完成了返修并更新同一个 PR，但源会话没有完成回执。
3. 源消息投递行缺 `handed_to_worker_at`（main 只在 `message.delivered` 写它，
   而这次只收到 `message.read`）。
4. 普通完成回复的 Outbox 回执被永久结为 `channelGone`：workspace Channel 省略
   `triggerId`，平台返回 422，Outbox 把 4xx 当作永久 gone（详见 `channelGone.txt`）。

## 修复内容

- `task_links.decision` 持久化运行时的结构化原因、routed 目标任务/会话和交接状态；
  `pr_updated_at` 防止旧 PR 事件覆盖当前 PR。
- dispatcher 在 `decision.ignored` 中区分 `routed`：
  - 记录目标工单和同仓目标会话；
  - 释放源任务租约；
  - 由 `routing` 循环在单执行槽下尝试唤醒目标：目标已持有当前代次时直接交接；
    目标 `admissionRequired` 时用 `/admit` 建立新的 Assignment；目标手动暂停时保持
    `deferred`，等人工继续后再交接；失败原因持久化，不凭 running/202 判定成功。
- `captureReportsOnce` 在目标新 report 落到目标会话时，给每个 routed 源会话写入一次
  中文完成通知（按 report 时间戳幂等）；目标失败/受阻时另有通知。
- `message.read` 同时补齐 `handed_to_worker_at`（read 必已 delivered）。
- 平台接受省略 `triggerId` 的 Channel 回调；上游补丁 `0028` 显式发送 `triggerId: null`。
- Web：routed 源任务显示“已转交 / 转交中 / 已转交（目标已暂停）/ 转交失败”，
  可跳到同仓目标工单；普通拒绝显示具体原因和中文下一步。

## 红 / 绿证据

| 项 | 红（main） | 绿（本分支） |
| --- | --- | --- |
| 源状态 | `not_accepted`，`decision={}` | `not_accepted`，`decision.outcome=routed`、`routingState=handed_off` |
| 源 UI | “未接单”，无原因/链接 | “已转交”，有“查看目标工单”和交接说明 |
| 源消息回执 | `delivered_at` 有，`handed_to_worker_at` 空，`read_at` 有 | 两者都有 |
| 源完成回执 | 无 | “已转交的返修已完成，PR #1 已更新，等待审阅。” |
| 同一 PR | 更新成功（说明交接实际发生，但平台不可见） | 更新成功，只改 `src/value.ts` |
| 普通 reply Outbox | `status=dropped, reason=channelGone` | `status=sent` |
| 普通非任务拒绝 | 通用“未接单” | 持久化 `said` 原因 + 中文下一步 |

截图（1440×900、浅色、同一新任务入口、同一会话位置）：

- 红：`ui-before-routed-source.png`
- 绿：`ui-after-routed-source.png`

## 命令与退出码

```bash
# 红：main worktree 构建
pnpm install --frozen-lockfile && pnpm build                     # exit 0
# 绿：本分支
pnpm build                                                      # exit 0

# 上游 0028 制品
integrations/superagent/build-patched.sh <pristine> /tmp/.../artifact-0028
# exit 0；lib/index.js sha256 d406608264508db2a4f5ad225c654a3af4c538a949f9276c818f2ac6d2e33f59
corepack pnpm@11.7.0 exec vitest run tests/workspace.spec.ts     # 8 passed, exit 0

# 隔离流程（API 4410 / Bridge 4492 / DB 55432）
取 pre-rework 快照 → 起实例和平台 → 新入口发返修 → 读平台 SQL、Bridge event、
ticket snapshot、Outbox 回执和 UI 文本；红/绿各一次，最后用 0028 制品再跑一次
普通 reply，Outbox 从 dropped(channelGone) 变 sent。
```

## 未验项

- 未做 C/D 段（页面位置恢复、主题白框、中文提示词、手机通知）。
- 未在正式 `moyu_m6c` 库或 3082 实例上执行；生产发布沿用现有流程。
- 目标工单手动暂停后的“继续”只做了集成测试和状态推导，没有在真实隔离实例上再跑一次
  人工 pause→resume 全流程；`deferred` 分支由真实 snapshot 的 `paused` 字段和
  PostgreSQL 集成测试覆盖。
- 未验证多目标并发 routed（同一目标多个源会话）在真实实例上的顺序；集成测试覆盖重复
  事件与重复 handoff 不产生第二次 admission。
- 红轮里目标 ticket 的 input 实际已有 deliveredTo/readAt；未复现 Issue 文字描述的
  “二者为空”。实际复现到并修复的是平台 `handed_to_worker_at` 为空、源会话没有回执，
  以及普通完成 reply 被 Outbox 结为 `channelGone`。
- Outbox 其它永久 4xx（会话不存在、401）仍按设计记为 gone，未改动。
