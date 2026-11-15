# M6-C 验收表

更新时间 2026-11-15 22:55 (+08:00)。本表只写**实际观察到**的结果；没有真浏览器证据的项一律不算通过。

## 固定版本

| 项 | 值 |
| --- | --- |
| 代码 `main` | `22f887d820d0cc2e28897983d7c398b6470f8446`（#65 合并后） |
| 候选部署 release | `/opt/moyu-m6c/releases/b6fa35bb5394-home` |
| 部署内容 | `main` + PR #66（设置前端）+ PR #67（首页收敛），**两个 PR 尚未合并** |
| 上游 Superagent pin | `6337fc823ce20251c8de8085948165c81aaa701e`（补丁 0001–0025） |
| 运行时产物 | `/opt/moyu-m6c/artifacts/superagent-ad9650631bc3`，`lib/index.js` sha256 `07f46473b150ec97e35f1fe45090946df8e966f847c5269bcd5b2190a9fdd49b` |
| Web bundle | `index-BCMyha2F.js` |
| 数据库 | `moyu_m6c`，19 个迁移，25 张表 |
| 入口 | `https://moyu.sutrasky.com`（nginx → `127.0.0.1:4310`） |
| 服务身份 | `moyu-m6c`(988) / 检查身份 `moyu-m6c-check`(987:981) |

## 节点 A：可投入使用的原型

| 编号 | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| A01 | 基线冻结（提交、产物、数据库、端口） | Pass | `docs/evidence/m6c/RUN-20261115-candidate.md` |
| A02 | 复用 #64 而非重做 | Pass | #64 合并 `ff4785f0`；补充验证见下 |
| A03 | 按仓库独立实例 + 全局最多 2 在线 | Pass | 三仓库实测：唤醒第三仓库 → 空闲实例 `evicted`，稳态在线 2 |
| A04 | 每仓库 1 个执行槽 | Pass | `executionSlot` 字段 + 租约单活跃约束 |
| A05 | 复用租约/fencing，不自建调度 | Pass | `runtime_leases.fencing_token` bigserial；失败任务释放名额修复后投递 1 次成功 |
| A06 | A 失败绝不回退到 B 或全局 agent | Pass | 每仓库独立 profile/端口/凭据/stateDir；检查命令按仓库解析（A/B 实测不同命令） |
| A07 | 上游设置前端**源码移植**（非仿写） | Pass（部署）/ Blocked（真人操作） | 19 个上游客户端文件原样搬入；`pnpm check`+`build` 绿；**未在浏览器里被真人操作过** |
| A08 | 五分组 Sources/Eval/Execution/Prompts/Deployment | Pass | 面板六组 200 且带真实内容；bundle 含五组标签 |
| A09 | 逐字段映射表 + owner→repo→instance→真实配置绑定 | Pass | `docs/M6-C-VERIFICATION.md` 映射节 + 实例级读写实测 |
| A10 | 浏览器绝不出现运行时 URL/端口/路径/token | Pass | 前端只调 `/api/v1/repositories/:id/superagent/*`；token 只在服务端 |
| A11 | 保留 revision / 409 / 历史 / 提示词 diff | Pass（API 级） | 陈旧 revision → `409`；`stateDir` → `422`；`policy-history` 真实 revision |
| A12 | Deployment 用实例级 ConfigForm 快照/订阅/变更 | Pass | 适配器实现 `getSnapshot/subscribe/mutate`；B 上 `promptMaxChars=200000` 跨重启保留 |
| A13 | 修复启动覆盖配置 | Pass | 平台不变量重断言 + 首启种子；改动块才写 |
| A14 | 首页收敛为一屏 | Pass（部署）/ Blocked（视觉） | 新增 `WorkbenchHome`；bundle 含「当前仓库/待处理/执行槽」；**无截图** |
| A15 | #64 补验 6 项 | Pass | 见 `M6-C-VERIFICATION.md` 2026-11-15 20:20 节 |
| A16 | 两仓库各自检查命令 | Pass | A `echo repo-a-check-ok` / B `echo repo-b-check-ok`，同 supervisor 连续调用 |
| A17 | 真实依赖安装（检查身份） | Pass（身份级） | 检查身份下 `pnpm install --frozen-lockfile` 392 包 + `pnpm test` 100 通过；**review API 版本待 lessons 工单** |
| A18 | 备份/恢复演练 | Pass | 279KB dump → 隔离库，行数/索引/约束一致；临时 API 在恢复库上 `readyz` 200 且读到真实 owner |
| A19 | 迁移上行 + 回滚演练 | Pass | 空库 → 19 迁移 → 首启状态；恢复备份 → 回到真实 owner 状态 |
| A20 | 平台回滚演练 | Pass | 符号链接切换 + 重启，bundle 名变化，`auth/state` 不变，已切回 |
| A21 | 插件回滚演练 | Pass（程序）/ 无降级证据 | 产物符号链接切换 + sleep/wake，pid 4094447 换新，设置与部署值保留；只有一个产物，**未验降级** |
| A22 | 双入口去重（数据层不变量） | Pass | 四个唯一键逐个实测拒绝重复；行数无净增 |
| A23 | 双入口去重（端到端） | Not run / Blocked | 自己账号发的 issue `received=0`（需第二个 GitHub 账号）；网页先发需 owner 会话 |
| A24 | 手机宽度 + 深色主题截图 | Blocked | 需 owner 登录后截图 |
| A25 | 断线回放 / 重启语义 | Pass（部分） | 重启后实例 `settleDeadRuntime` → `instance_spawned` → `online`；`runtime_cursors` 表为空，**跨重启游标持久性未验** |
| A26 | 运行手册 | Pass | `docs/M6-C-RUNBOOK.md` 含演练过的备份/回滚/迁移步骤 |
| A27 | 三真实仓库容量与隔离 | Pass | alpha/beta 测试仓 + lessons 真实仓，2 在线 |

## 节点 B：M6-C 正式上线

以下每一项都需要 owner 参与或授权，当前状态全部是 Blocked。

| 编号 | 验收项 | 状态 | 阻塞点 |
| --- | --- | --- | --- |
| B01 | 合并 PR #66（设置前端） | Blocked | 等 owner 审阅合并 |
| B02 | 合并 PR #67（首页收敛） | Blocked | 等 owner 审阅合并 |
| B03 | 合并后重新固定版本 + 重跑验收 | Blocked | 依赖 B01/B02 |
| B04 | 设置页真人操作验收（改值→保存→切仓库→回读） | Blocked | 需 owner 真机 passkey |
| B05 | 手机宽度 / 深色主题截图 | Blocked | 需 owner 登录 |
| B06 | 生产库迁移与备份 | Blocked | 生产库 `moyu` 至今未被打开；需 owner 授权 |
| B07 | 服务身份切换正式化 | Blocked | 需 owner 决定 |
| B08 | 3082 交接 | Blocked | 3082 仍在监听，按边界未触碰 |
| B09 | 整机重启演练 | Blocked | 需 owner 授权 |
| B10 | 正式域名上的真机 passkey 体检 | Blocked | 需 owner 操作 |

## 已知缺口（不是验收项，但会影响后续）

1. `events_source_event_uq` 缺 repository 维度：同一 `source_event_id` 无法存在于两个仓库，去重更强但隔离语义不对。
2. `runtime_cursors` 表为空，但代码里有写入路径（`apps/dispatcher/src/sync.ts:1286/1333`）：Bridge 事件消费在运行中并没有把游标落库。重启后会从头部重放，靠 `events_source_event_uq` 去重兜底。结果是"能用但不该这样"：游标持久化事实上未生效，重放规模随事件量线性增长。已在 A25 记为部分通过。
3. dispatcher 在 supervisor 重启窗口内每秒写一条 `event_sync_error`（error 级）：不是故障，但日志噪音大。
4. 部署内容领先 `main` 两个未合并 PR：合并前不能称"main 即线上"。
