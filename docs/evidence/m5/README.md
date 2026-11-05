# M5-A 证据目录

| 文件 | 内容 |
| --- | --- |
| `supervisor-lifecycle.log` | 从真实 supervisor 日志提取的 prepare/wake/spawn/online/evict/sleep/fault/stale-lock 事件（已脱敏） |
| `live-snapshot.txt` | 运行中的三仓库、实例 pid/端口/状态与 API 投影快照 |
| `concurrent-wake.log` | 同一仓库并发两次 wake 的结果与最终进程 |
| `restart-adoption.log` | supervisor 重启前后的实例 pid/state；alpha/beta 接续、gamma 保持休眠 |
| `process-exit-fault.log` | `kill -9` beta 后 `instance_lost`、端口关闭与后续恢复 |
| `github-sleeping.log` | 休眠仓库写入 GitHub @ 后 50 秒内无新会话、无进程 |
| `migration-0010-rollback.log` | 0010 回滚→重放的 psql 输出 |
| `migration-0011-rollback.log` | 0011（ownership）回滚后 11 条迁移/0 列，重放后 12/1 |
| `stop-timeout-retention.json` | 100ms 停止超时后 `accepted:false`、`stopping/stop_failed`、pid 与 ownership 保留 |
| `stop-timeout-request.log` | 短超时 supervisor 的启动记录（含最小配置边界） |
| `capacity-wake.log` | gamma 停止期间 beta 排队；reply 10 后 new_task 20 仍保留优先级 10 |
| `concurrent-submit.log` | 8 个同 `clientMessageId` 并发提交：1×202 + 7×200，1 条消息/1 次投递 |
| `late-receipt.log` | 同 id 晚到重试 200/duplicate，消息/投递仍为 1 |
| `start-stop-interleave.log` | wake 后立即 sleep，最终 sleeping、无残留进程 |
| `dispatcher-restart.log` | dispatcher 重启前后消息/投递/task 计数不变 |
| `supervisor-restart.log` | supervisor 重启后 alpha 同一 PID 接续，beta/gamma 保持休眠 |
| `browser-regression.json` | 真实 Chromium：会话分页 50→56、reload 后草稿恢复 |
| `github-online.log` | agent 自写 @ 未产生导入的现场（自回声过滤） |
| `github-online-import.log` | sutrasky 人工 @ 导入：1 conversation/message/task、bridge 一次、runtime 复用；17/17 断言 |
| `root-identity.log` | 过期 root startTime 的无关 sleep 未被信号；实例保持 stop_failed，dummy 退出后才 sleeping |
| `concurrent-prepare.log` | 并发 prepare 的 delta/epsilon profile 与两对端口不重叠 |
| `spawn-error.log` | 坏 DSH_BIN 下 failed repo `start_failed`、supervisor health ok、alpha 仍 online |
| `spawnfail-supervisor.log` | 坏 DSH_BIN supervisor 的 prepare/wake/fault 事件 |
| `wake-during-stop.log` | stop_failed 时 wake 保留 online，fake 退出后 starting→online，单进程 |
| `stop-port-proof.log` | Bridge 端口仍监听时保持 stop_failed，关闭后才 sleeping |
| `task-resume-wake.log` | 休眠仓库 resume 202、operation queued、实例转 starting |
| `migration-0012-rollback.log` | 0012 唯一索引回滚 12/0，重放 13/3 |
| `cgroup-adoption.log` | alpha adoption cgroup 与 pid |
| `cgroup-stop.log` | beta cgroup spawn/停止后目录移除 |
| `unknown-propagation.log` | root 已死 unknown 时 manager 保持 stop_failed 且 dummy 存活 |
| `unknown-adoption.log` | 过期身份 adoption 不迁 cgroup、不杀 dummy，sleep 保持 stop_failed |
| `pending-admission-diagnosis.log` | ignore 决策导致 pending_admission 并占 gate 的根因 |
| `m4-pause-resume.log` | live running→stopped→running→completed，PR #4 单文件/单 commit 无重复 |
| `artifacts.txt` | 基线/head、Node/pnpm/PostgreSQL、构建与上游制品 sha256 |
| `ui-checks.json` | 真实 Chromium DOM 断言：休眠文案、监听暂停、唤醒动作、添加仓库列表、重复冲突、before 无该状态 |
| `before-*.png` | `main@160a22d` 的 M4-UX Web 构建（同一数据库/仓库/视口/主题） |
| `after-*.png` | 当前 M5-A Web 构建；含休眠/在线状态与添加仓库对话框 |

截图由 Playwright 1.56.1 Chromium 在 1440×900 / 390×844、浅色/深色下生成，使用隔离测试会话 cookie；
没有使用 mock 页面，也没有伪造 DOM。真实设备 Passkey 不在本单验证范围。

未验证项、限制与复现命令见 [`../../M5-A-VERIFICATION.md`](../../M5-A-VERIFICATION.md)。
