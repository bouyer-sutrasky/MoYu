# M6-C A 真实运行证据（2026-11-17）

代码：`c1a03401d285f530754361713fc24c0c91f88ca9`（返修后的 A 分支；
含并发 reservation 修复）。上游补丁：0001–0027。

运行环境：主机 `lavm-flnape7bgu`，服务身份 `moyu-m6c`（uid 988），
systemd unit `User=moyu-m6c`、`Delegate=yes`、`DelegateSubgroup=supervisor`。
release `/opt/moyu-a/releases/c1a03401...`，数据库 `moyu_a_repair`，
状态 `/var/lib/moyu-a`；未触碰正式 4310/4491 栈、`moyu_m6c` 库或 3082 实例。

真实仓库：`Bouyer12/m6c-a-repo-cache-20261117`（私有测试仓）。
repository id `87b05f90-4f4f-4f1c-83fa-5aac305c51b1`。
conversation `b256d44b-d1f1-4c49-9f5f-9c319cdec74d`，
task `6895b931-bdbf-4f2e-a9b7-0dfec4581ce6`，
upstream ticket `25cf6ca2ac20478aea758be823716829`。

## 时间线

| 时间（+08） | 事实 | 证据 |
| --- | --- | --- |
| 17:31:46 | `moyu-m6c` 下实例准备，profile m6c-a2 | `supervisor.log` |
| 17:31:53 | 真实 GitHub mirror 完成，head `c8ff4ec…` | `supervisor.log`, `repository-preparation.sql.txt` |
| 17:34:55 | DSH runtime 在线，单进程 PID 1575318 | `processes.txt`, `supervisor.log` |
| 17:35:06 | 创建 execute 会话/task | `task.sql.txt` |
| 17:36:34 | 删除副本后首任务失败：检出失败、worker 未启动 | `real-run-failed-page.txt`, `events.jsonl` seq 1–3 |
| 17:36:43 | 仓库层重新准备完成（attempt 2） | `repository-preparation.sql.txt` |
| 17:36:47 | 原 task ID retry，进度：准备开始/就绪/worker 启动 | `events.jsonl` seq 4–9 |
| 17:37:42 | 任务 `awaiting_review`，PR #1 | `task.sql.txt`, `pr.json` |

## 副作用

`side-effects.txt`：1 delivery、1 ticket、1 assignment、1 worktree、1 DSH
进程、1 PR；仓库 clone 2 次（初始 + 恢复），没有按任务重复远端克隆。
`deliveries.sql.txt`、`task-operations.sql.txt`（仅 1 次 retry）、
`worktree-commit.txt`、`pr.json`。

## Web 进度

`real-run-failed-progress.png`：失败态，显示「任务工作区准备失败（阶段：
检出工作区）；worker 未启动」并带「重试」入口。
`real-run-retry-progress.png`：原 task 重试后的实时进度。
`real-run-final.png`：完成态与 PR。

## 超时

`timeout/`：注入慢 SSH 并将仓库准备超时设为 10 s，`timeout-preparation.sql.txt`
记录 `failed` 与中文超时原因；`timeout-recovery.sql.txt` 记录恢复后的 ready。
`timeout/supervisor-timeout-window.log` 是同一时间窗的服务日志。

## 并发测试

`concurrency-test.log`：12/12 通过，其中
`joins two concurrent preparations instead of starting a second clone`
使用 `Promise.all`，并断言 `gitAttempts === 1` 与实际 `clone`/`fetch`
子进程计数为 1。
