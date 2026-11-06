# M5-B 执行生命周期诊断（2026-11-06）

## 责任方与持久状态

| 阶段 | 责任方 | 持久状态 | 关键 await / 重启边界 |
| --- | --- | --- | --- |
| 准入授予 | platform dispatcher `leases.ts` + upstream `Tickets.acceptAdmission` | `runtime_leases`、`admission-fence` KV（token/lease/ticket） | 租约到期、Bridge 请求前、`admit` 事务 |
| 实时输入 | upstream `Tickets.addInput` + `DshExecutor.deliver` | Ticket `undelivered`、`delivery` effect KV | `addInput` 事务提交后 enqueue |
| 持久重放 | `Effects` 消费 `launch`/`delivery` | effect KV、Ticket admission | 进程重启、effect 重试、session 恢复 |
| 最终会话副作用 | `DshExecutor.launch`/`deliverInput`/`retry` | Assignment `pending/running/ended`、Session inbox | prepare、`sessions.ensure`、`stopped`、`prompt` 授权回调 |
| 停止/替代 | upstream `Tickets.admit` + `DshExecutor.stop`/`stopped` | 进程内 `stopping`/`stopErrors`；Ticket ended | stop 后台 promise、重启 |
| 平台侧替代 | dispatcher `admissions.ts`、`operations.ts` | `task_links`、`runtime_leases`、`task_operations` | lease 等待、admit/retry、restart reconcile |

## 当前判定

- 旧代次实时投递：`Tickets.addInput` 和 `DshExecutor.deliverQueued`/`deliverInput` 已校验
  fence；旧代次保留 Input，不 prompt/不唤醒。
- 旧代次 launch：`launchQueued` 入口曾校验，但 `launch()` 的 `current()` 与 prompt 最终授权
  只查 Ticket/Assignment/暂停；在 prepare/ensure/stopped 的 await 中切到 B 新代次时 A 仍可能
  prompt/`assignmentStarted`。已把 `admissionCurrent` 加入 `current()`，因此每个 await 后的
  `current()` 和 prompt 授权回调都会拒绝 A。
- 持久重放：`launch`/`delivery` effect 消费时重新读取 Ticket 与 fence；旧 effect 不能唤醒。
- 停止证明：已新增 `src/executor/stop-proof.ts`，在 `stop()` 启动前持久记录旧
  lease/token、Assignment 和 **本 Ticket 的 job ID** 为 `unproven`；不再把整个 harness 的
  processTree 记入 A，避免 A 的证明污染 B。只有本次 stop 回调成功且本 Session 无运行 job 时才
  `completeStopProof`；unproven 记录不会被自动 settle，重启后空 job registry 也不能证明旧 job
  已退出。`track` 只结算发起该次 stop 的 Assignment，重复 record 保留既有证据。真实
  stop 拒绝分支已加入 DshExecutor 级测试（通用 `Error('kill refused')`，同一 host/内存 Map/
  Jobs 服务，直接调用私有 `assertStops`）。它只证明拒绝分支，不是真实 EPERM、真实受管
  runtime、持久存储重开或注册入口的 recovery replay；这些仍缺。
- 启动器：release 前登记 fd3 error/early exit，保存新 PID/cgroup ownership；同代事件已收敛
  一次失败。generation 比对与 DB 写失败交错仍缺独立探针。
- 第二候选：fresh-2 在 provider 前停住；现有证据只到 trigger 被存储、无新 assessment effect /
  provider 请求。尚未定位 trigger→eval→effect→session 的最早断点。

## 已有可失败/通过回归

- `tests/admission.spec.ts`：缺失/非数字/旧代次、同 token 第二 Ticket、wake 后再准入、
  旧代次 deliver 被挡、新代次替代一次、pause 优先。
- `apps/supervisor/test/process.test.ts`：EOF/错误信号/SIGKILL 父进程不执行、release EPIPE、
  cgroup 探针。
- `scripts/m5b/launcher-cgroup-check.sh`：实际 256 MiB probe、父子同组、marker、kill 后空。
- 未覆盖：真实 Jobs stop EPERM 持久证明、launch await 中切代次的真实 DshExecutor barrier、
  第二候选最早断点、双入口/pause-start/restart 现场计数。

## 安全行为

- 有 admission 但读不到 fence：`admissionCurrent` 返回 true（兼容旧库/未启用 fence 的实例）；
  M5-B 受管实例写入 fence 后以 fence 为准。
- 无 admission 的旧 Ticket：保持 legacy 行为；受管新 Ticket 在 `requireAdmission` 下必须有 token。

## 恢复红证据（2026-11-06）

- 记录一个真实 `sleep` 的 PID/starttime/cgroup 到持久 proof，终止并回收该进程后
  `identityAlive=false`，但 `replacementBlocked` 仍为 true、proof 仍为 `unproven`，因为没有
  原 stop 成功回调。这是当前恢复闭环的失败断言，不是通过项。
- 缺口根因：DSH Jobs 只暴露 job id，不暴露进程归属；共享 harness 进程树不能作为 A 的边界。
  需要每 Ticket/Assignment 的受管进程边界（cgroup/pid namespace）或可持久对账的 job 终止
  事件，才能把“已清空”写成权威证明。否则只能保守占用名额。
