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
| 1 | 全入口统一租约、停止后替代 | **未做**：GitHub→Web 与 Web→GitHub 顺序、pause 与 start 三处交错、两个调度者的外部副作用计数都没有实测 | — |
| 2 | 非 root 与统一资源核算 | **非 root 已补齐 + 同一受管边界内的计量**：anchor/provider/supervisor/dispatcher/api 全部 `m5bmatrix`(995)、PG `postgres`(111)、runtime 与构建测试进程 995，逐 cgroup 读数；4/6/8 GiB 三档与混合真实负载压力**未做** | `item2-boundary-cgroup.log` |
| 3 | 4／6／8 GiB 预算与宿主余量 | **未做**：6 GiB 调度阈值与弹性上限没有实证 | — |
| 4 | 准入、迟滞、OOM | **未做**：A/B 执行、C 排队、解除压力后的有界恢复/回收/清错没有实测 | — |
| 5 | 重启对账及保持暂停／等待／审阅 | **部分**：`paused` 字段比对通过（43 字段全同、双 PID 均变），但「重启后游标推进」证据待补；`waiting_input` 状态保住但 assignment 被重发；`awaiting_review` **取不到** | `item5-paused-restart.log`、`item5-waiting_input-restart.log`、`item5-awaiting_review-attempt.log` |
| 6 | 子进程与聚合 8 GiB 压力 | **未做**：全进程树遍历与孤儿验证、四类服务同切片聚合压力都没有实测 | — |
| 7 | 状态原因、恢复引导、重试与清错 | **未做**：真实 OOM／重试耗尽／人工恢复／旧错误清除并在重启后保持的闭环没有实测 | — |

## 顺带修正（已在本轮落地）

- `item3-fence-observability.log` 末尾把 409 `admissionStale` 误写成 422 —— 已改为
  「409 `admissionStale`」并加更正说明；正文原始响应里一直是 409。
- `item4-dual-db-restart-live.log` 的维护循环红绿输出缺少筛选条件 —— 已补
  `-t "expired lease"`，并在基线上用同一筛选复跑对照（4 passed / 4 skipped）。
- `scripts/m5b/concurrent-trigger-race.mjs` 退出码只校验 HTTP 结果 —— 已在脚本头写明持久
  input 与投递次数是**另查两个库**证实的，并给出可执行的 SQL（Bridge SQLite / dispatcher PG）。

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
