# M4 隔离实例证据

| 文件 | 内容 |
| --- | --- |
| `live-discussion.log` | 讨论会话接受、只读方案、`awaiting_review` |
| `live-start-pause-resume.log` | 讨论转执行、立即停止、停止证据与 resume 请求 |
| `live-pause-evidence.json` | 平台停止证据与 runtime Ticket `paused` 快照 |
| `live-execute-pr-closed.log` | 直接执行任务创建 PR #3；关闭后平台 `closed_unmerged` 与消息 409 |
| `live-resume-pr.log` | PR #4 绑定、stop、resume 后仍是同一 PR（`samePr: true`） |
| `live-stop-background-job.log` | 真实 `npm test` 后台作业停止前后 PID/进程树、jobs 与平台 stopped |
| `live-closed-pr.log` | PR #5 关闭后的 `closed_unmerged`、409 与 PR 状态 |
| `live-resume-missing-worktree.json` | worktree 缺失时 resume 被拒、平台 blocked |
| `live-discuss-boundary.log` | 只读 preset/sandbox、凭据读取拒绝、进程/挂载身份 |
| `live-github-import-dedupe.log` | 真人 GitHub @ 导入、单 task、notice、cursor 继续 |
| `live-web-continuation.log` | 停止中消息 stored、resume 后 read、回复来源 |
| `live-duplicate-queue.log` | 重复 runtime Ticket 的持久化暂停与无重复副作用 |
| `live-discuss-sandbox.log` | 独立 UID/只读快照/无写凭据的讨论 runtime |
| `live-discuss-lifecycle.log` | 运行中讨论暂停/恢复与并发快照隔离 |
| `live-discuss-ownership.log` | A 停止/B 继续、进程组归属与硬重启清理 |
| `live-web-alias.log` | Web 普通消息/URL 合并交错、幂等与目标 task 单写入口 |
| `upstream-0009-tests.log` / `upstream-0010-tests.log` | 0009/0010 的上游定向回归 |

环境：`/root/.dsh-m4`（profile `m4`、Web 3292、Bridge 3291），平台 API/dispatcher 4302，测试仓库
`Bouyer12/m3-loop-r3-68fa5d90`。3082/4300 未触碰。截图与 before/after 说明见
[`../../M4-VERIFICATION.md`](../../M4-VERIFICATION.md)。
