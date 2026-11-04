# 宿主 supervisor 拥有每仓库 runtime 进程

每仓库的 DSH runtime 由独立 supervisor 进程按固定模板管理。API 只发送已授权的 repositoryId 和
wake/sleep/retry 等允许操作；supervisor 从自身配置解析 profile、state、worktree、端口和凭据，不接受
浏览器传入的 shell、路径或任意端口。supervisor 持久化休眠/启动中/在线/停止中/故障与原因、等待对象和
最后进展；在线上限 2，每仓库一个执行名额，人工等待/审阅释放名额但不自动杀进程。休眠前必须确认没有活动
任务或人工命令，且没有存活超过瞬时的后台子进程；Bridge 健康检查失败不杀死仍存活的进程，只有进程退出
才标记失联并回收名额。

选择该边界而不是让 API 或 worker 自己启动进程，是为了让“谁能启动什么”可审计，并让凭据、端口和
worktree 的解析只发生在一个不面向前端的位置。代价是新增一个部署进程和状态表；生产需专用非 root
systemd 身份，测试阶段仍使用隔离目录与端口。
