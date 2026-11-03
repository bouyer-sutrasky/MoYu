# M4 隔离实例证据

| 文件 | 内容 |
| --- | --- |
| `live-discussion.log` | 讨论会话接受、只读方案、`awaiting_review` |
| `live-start-pause-resume.log` | 讨论转执行、立即停止、停止证据与 resume 请求 |
| `live-pause-evidence.json` | 平台停止证据与 runtime Ticket `paused` 快照 |
| `live-execute-pr-closed.log` | 直接执行任务创建 PR #3；关闭后平台 `closed_unmerged` 与消息 409 |
| `live-resume-pr.log` | PR #4 绑定、stop、resume 后仍是同一 PR（`samePr: true`） |
| `upstream-0009-tests.log` / `upstream-0010-tests.log` | 0009/0010 的上游定向回归 |

环境：`/root/.dsh-m4`（profile `m4`、Web 3292、Bridge 3291），平台 API/dispatcher 4302，测试仓库
`Bouyer12/m3-loop-r3-68fa5d90`。3082/4300 未触碰。截图与 before/after 说明见
[`../../M4-VERIFICATION.md`](../../M4-VERIFICATION.md)。
