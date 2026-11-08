# M5-B 现场矩阵 — 本轮到哪了

基线 `main` = `f2ba6e91e66c964171b6ed9568bc942f5588ede3`；dispatcher 产物
`apps/dispatcher/dist/main.js` = sha256 `0e981c52f02435f3edea91cf51126c245d88c9619c09264ab5856255d5c9e4a6`
（211968 字节，本机 `pnpm build` 复现同值）。以下结论只用这份产物。

**这是一次不完整的矩阵取证。** 七项里只有第 2 项完整、第 5 项部分完成，
其余五项没有实测证据，因此不能说 M5-B 通过，也不应据此推进 M6。

> 复审轮（2026-11-07T17:43Z）之后更新：第 2 项已把**非 root** 这一半补齐
> （所有服务单元 `User=m5bmatrix` / `Uid: 995`，构建测试进程同身份，runtime 在委托的 cgroup 子树里），
> 见 `item2-boundary-cgroup.log`。第 5 项 paused 的「重启后游标推进」证据仍在补。

| # | 项 | 本轮结论 | 证据 |
| --- | --- | --- | --- |
| 1 | 全入口统一租约、停止后替代 | **部分**：三相位实测 —— c1（start 前 pause）与 c2（start 进行中 pause）**不通过**（票卡 `stopping`、`stoppedAt` 永远 null、平台 `blocked`、resume 被拒、仍持有执行租约），c3（start 后 pause）**通过**（`stoppedAt` 落库、租约归还、resume 接受）；双调度者**通过**（持租约者 delivered=2，另一个 delivered=0 / lease_wait=11）；GitHub→Web **通过**（真实 @ 提及评论 → trigger → decision accept/explicitRouted 10 秒 → ticket → 平台 task，Web API 可见 `source=github`）；Web→GitHub **通过**（运行中的票追加 Web 消息 `result:"stored"` 一次成功、票据新增 trigger 输入；该方向**设计上不回写 GitHub** —— `targetTrigger` 固定用 workspace channel，唯一 GitHub 写入是 GitHub trigger 自己通道上的接受回执 comment 6714588079。此前那次 409 是我把 source 改成探测仓库导致，已更正） | `item1-pause-start-three-phases.log`、`item1-entrance-orders.log`、`item1-web-to-github.log`、`stress-guard.log` |
| 2 | 非 root 与统一资源核算 | **非 root 已补齐 + 同一受管边界内的计量**：anchor/provider/supervisor/dispatcher/api 全部 `m5bmatrix`(995)、PG `postgres`(111)、runtime 与构建测试进程 995，逐 cgroup 读数；4/6/8 GiB 三档与混合真实负载压力**未做** | `item2-boundary-cgroup.log` |
| 3 | 4／6／8 GiB 预算与宿主余量 | **通过**：三档各自只节流不杀 —— 4 GiB 档峰值 3.14 GiB（`high` 107,093、`max`/`oom_kill` 0）、6 GiB 档 4.17 GiB（111,716）、8 GiB 档 6.23 GiB（123,306），宿主 `MemAvailable` 全程 7.9–11.1 GiB；上限本身用专门探针（`MemoryHigh=MemoryMax` + 请求额正好等于余量）真顶到 4 GiB，触发**切片内 memcg OOM**（`CONSTRAINT_MEMCG`、`oom_memcg=/m5bmatrix.slice`，只杀合成成员，服务全存活） | `item3-budget.log` |
| 4 | 准入、迟滞、OOM | **通过**：三仓库同时来任务 → 两个执行、第三个 `capacity_wait`（`waiting=capacity`）；切片内**成员级** OOM（内核 `CONSTRAINT_MEMCG` 杀掉 supervisor 子树下的实例 cgroup，`max 103/oom 4/oom_kill 2`，其余成员全存活）；暂停 A 后其实例 `evicted`、C 被调起执行、三个仓库 `waiting`/`error_code` 全部回到 `none` | `item4-admission.log` |
| 5 | 重启对账及保持暂停／等待／审阅 | **部分**：`paused` 通过（43 字段全同、双 PID 均变、重启后真实 resume 使 `runtime_cursors` 6 → 9）；`running` 两条路径都测了 —— between-steps（最后报告 `waiting`）**通过**（24 字段全同、游标 3 → 3 → 4），被打断回合（报告 `progress`）**不通过**（assignment 重发、状态转 `queued`、重启本身推进游标 2 → 3 且随后投递未再推进）；`waiting_input` 按窄化判据通过（状态/问题/注意力/报告/admission/执行目录保持，`assignmentId` 允许重发，记 `DIFFERS`）；`awaiting_review` 按新判据**通过**（真实 open PR #6：ready 后投影 `awaiting_review`、`ended: null`，关闭 PR 后转 `closed_unmerged`，PR 未合并、分支已删） | `item5-paused-restart.log`、`item5-running-between-steps-restart.log`、`item5-running-interrupted-turn-restart.log`、`item5-waiting_input-restart.log`、`item5-awaiting_review-attempt.log`、`item5-awaiting_review-pr.log` |
| 6 | 子进程与聚合 8 GiB 压力 | **部分**：全树递归遍历（9 子组、切片根 0 进程、runtime 四层含两个 `sleep 900`）与停后空树**通过**（停后 0 进程、端口全释放、无孤儿）；聚合压力**部分**：四服务同切片、成员上限和 3.5 GiB < 8 GiB，filler 顶到 6.19 GiB 时 `memory.high` 节流 18,697 次、切片本地 `max`/`oom_kill` 均为 0（调度而非 OOM 杀），**8 GiB 上限未顶到（未验证）** | `item6-processtree.log`、`item6-aggregate-stress.log` |
| 7 | 状态原因、恢复引导、重试与清错 | **通过**（重试耗尽一条判据不适用）：真实 OOM → supervisor `oom_killed` → 平台 runtime 投影给出自然语言 `reason` 与 `wake`/`sleep` 引导（含 `unavailableReason`）；按引导 `wake` 后任务 `queued→running`、实例回 `online/listening`；重启 PG+supervisor 后实例报 `ownership_unverified` 而非 `oom_killed`（旧错误未复活）。`重试耗尽`无自动多轮重试可耗尽：`tasks.ts:57 RETRYABLE = {failed, blocked}` 是人工重试命令，实测失败即 `failed` | `item7-recovery.log` |

## 顺带修正（已在本轮落地）

- `item3-fence-observability.log` 末尾把 409 `admissionStale` 误写成 422 —— 已改为
  「409 `admissionStale`」并加更正说明；正文原始响应里一直是 409。
- `item4-dual-db-restart-live.log` 的维护循环红绿输出缺少筛选条件 —— 已补
  `-t "expired lease"`，并在基线上用同一筛选复跑对照（4 passed / 4 skipped）。
- `scripts/m5b/concurrent-trigger-race.mjs` 退出码只校验 HTTP 结果 —— 已在脚本头写明持久
  input 与投递次数是**另查两个库**证实的，并给出可执行的 SQL（Bridge SQLite / dispatcher PG）。

## 两项子状态的判断（详见 [RECOMMENDATION-waiting-awaiting.md](RECOMMENDATION-waiting-awaiting.md)）

- `waiting_input` 跨重启换 assignmentId：**缺陷**。`interrupted()` 的 settled 判定只看报告状态
  （`waiting/ready/blocked/failed`），而「在等一个人」记在 `ticket.attention` 上；`orchestrator_report`
  的词表里根本没有 `waiting`，提问写的是 `progress`，因此被当成没结论的回合重发。
  改法是一处上游补丁（`src/core/assignments.ts` 的 settled 条件加 attention），代价是 runtime 产物变化。
- `awaiting_review` 取不到：**判据问题，不是缺陷**。ready 报告只在不跟随任何未闭合 Thread 时结票
  （`src/core/assignments.ts:129-135` 有明确注释），PR 由 `src/sources/github-pull.ts` 绑成 Thread；
  本轮 fixture 不开 PR，所以合法地直接 `completed`。要现场看到它需要一个仍 open 的真实 PR。

## 现场发现（需要产品/代码决策，本单未擅自改）

1. **新受管 cgroup 根目录无法首次使用**：`supervisor/src/process.ts` 的 `ensureCgroup` 先调
   `enableSubtreeControllers(CGROUP_ROOT)`（此时目录还不存在，返回值被忽略），再 `mkdir`，
   于是子组没有 `memory.max`，`applyInstanceMemoryLimit` 必然失败，实例以
   `memory_limit_unavailable` 起不来。本 harness 由部署侧预建根目录规避，缺口仍在。
2. **`not_accepted` 的任务仍占着执行租约**：orchestrator 的 accept 决策被忽略（例如候选
   `trigger_id` 不匹配）时，任务进入 `not_accepted`，但 `runtime_leases` 里仍有一条 `active`
   记录绑定该任务，同仓库后续投递一直 `refused=held, waitingFor=execution_slot`，直到 TTL
   （默认 1 小时）才释放。实测两次，每次都要靠人工把租约置 `released` 才能继续。
3. **ready 报告直接结票，`awaiting_review` 观测不到**：worker 用 `orchestrator_report`
   报 `state=ready` 后，runtime 立刻 `ticket.ended{by:executor,outcome:completed}`；
   投影函数 `if (ticket.ended)` 先于 `report.state === "ready"` 生效，所以平台任务是
   `completed` 而不是 `awaiting_review`。本轮的 `awaiting_review` 场景因此无票可测。
4. **等待中的回合被打断会换 assignment**：`waiting_input` 票在重启后状态/问题/注意力都在，
   但 `assignmentId` 变了（被中断的回合重新下发）。另外 supervisor 在 worker 持有后台任务时
   正确拒绝 `sleep`（`sleep_refused`），所以本场景只能用 `kill -TERM` 的崩溃式重启。
5. **停 supervisor 不会停 runtime**：runtime 被 supervisor 移进自己的 instance cgroup，
   `systemctl stop` supervisor 单元后 runtime 仍在跑并占着 3403/3404，下一轮 start 报
   `port_in_use`。`stack.sh down` 现在用 `cgroup.kill` 显式收子树；这条正是第 6 项
   「孤儿残留」要独立验证的行为。

## 复跑门槛

本目录的日志都在同一份产物上跑出，且都带「命令 + 原始输出 + 判定」。任一后续提交若改动
dispatcher 或 runtime 产物，本目录结论即失效，需要按同样命令重跑。
