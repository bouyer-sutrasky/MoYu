# M5-A 验证记录

日期：2026-11-05。基线：`main@160a22db322571f3a12fcc76748f86260fd34c04`。
被测环境与设计见 [`M5-INSTANCES.md`](M5-INSTANCES.md)；本文只记实际执行过的命令、结果与未验证项。
所有实例均使用隔离 `DSH_HOME=/root/.dsh-m5`、独立 profile/state/worktree/端口和私有测试仓库；
3082 bootstrap、4300 线上实例、生产库 `moyu` 与 Nginx 未改动。

## 1. 环境与制品

| 项目 | 值 |
| --- | --- |
| 宿主 | Ubuntu 24.04.2 LTS，4 vCPU / 16 GB |
| Node / pnpm | v22.23.3 / 11.7.0 |
| PostgreSQL | 16.15；`moyu_m5a_live@127.0.0.1:55432`（隔离实例） |
| 平台 | API 4500、baseline UI 4501、dispatcher、supervisor 4490 |
| runtime | `/root/.dsh-m5`，profile `m5a/m5b/m5c`，面板 3402/3404/3406，Bridge 3401/3403/3405 |
| 测试仓库 | `Bouyer12/m5a-alpha-adf10ad9`、`Bouyer12/m5a-beta-adf10ad9`、`Bouyer12/m5a-gamma-adf10ad9`（私有） |
| 上游构件 | `dsh-superagent@0.1.0` @ `6337fc823ce20251c8de8085948165c81aaa701e`，`m4-final-verify` 构建；未新增上游补丁 |
| 基线 Web | `main@160a22d` 的 M4-UX 构建，服务在 4501；与 after 使用同一数据库 |

构建/制品摘要见 [`evidence/m5/artifacts.txt`](evidence/m5/artifacts.txt)。核心值：

```
api dist        3f3a259c…21ad7
dispatcher dist 050153bc…1713
supervisor dist fc3afd1b…127
web js/css      2047786b… / 39a2cbfc…
migration 0010  dd09b7b3…6c55
upstream index  8d80bb7f…6252
```

## 2. 最终检查结果

| 检查 | 结果 |
| --- | --- |
| `corepack pnpm@11.7.0 --config.engine-strict=false lint` | 通过（0 error） |
| `prettier --check "**/*.{ts,tsx,mjs,cjs,json,yml,yaml,css,html}"` | 通过 |
| `corepack pnpm@11.7.0 -r --if-present typecheck` | 通过（8 个项目） |
| `corepack pnpm@11.7.0 -r --if-present test` | 通过：contracts 13、runtime-client 13、api 20、dispatcher 3、supervisor 5 |
| `@moyu/db test:integration` | 通过：8 文件 / 34 测试（含 0010 回滚、旧版本迁移、完整性） |
| `@moyu/api test:integration` | 通过：11 文件 / 65 测试（含 M4 暂停继续、分页、双入口、仓库生命周期） |
| `@moyu/dispatcher test:integration` | 通过：3 文件 / 29 测试（含多仓库隔离） |
| `corepack pnpm@11.7.0 -r --if-present build` | 通过（API/dispatcher/supervisor/web） |

完整 CI 还需在 PR head 上跑两次必需检查（`check`、`integration (real PostgreSQL)`）；本文件记录的是本地等价命令结果。

## 3. 验收矩阵与结果

| # | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 专用账号仓库查询、权限拒绝、重复添加 | **通过**：真实 `gh` 查询返回三个测试仓库与 push 权限；`POST` readonly/不存在 403、重复 409、只建一行 | `apps/api/test/integration/repositories.integration.test.ts`（5 通过）；实际 API 查询见运行记录 |
| 2 | A/B/C 分别启动、休眠、网页唤醒、容量排队；切换仓库不污染原任务/配置/凭据/cursor | **通过（生命周期）**：三仓库各有独立 profile/state/端口/凭据；A/B 在线后 C 唤醒 `capacity_wait`；LRU 淘汰空闲实例；每仓库 dispatcher 独立循环与 cursor | `evidence/m5/supervisor-lifecycle.log`、`live-snapshot.txt`、dispatcher 集成测试 |
| 3 | A/B 忙 → C 排队 → 释放/最久无交互淘汰；人工回复优先；等待/审阅释放名额但不抢占运行 | **部分通过**：A/B 有真实运行任务/后台 `sleep 300` 时 C 进入 `capacity_wait`；空闲实例按 `last_activity` 被淘汰；不抢占运行中任务。人工回复优先级已实现（10 vs 20），未用两个真实人工请求做竞态测量 | `supervisor-lifecycle.log`、DB `repository_instances`、dispatch 日志 |
| 4 | 并发重复唤醒/提交、双入口顺序、启动与人工停止交错、晚到回执 | **部分通过**：并发两次 wake 只产生一个 DSH 进程；启动中收到休眠/重新 wake 由 desired_state + generation 收敛；未重复 Ticket。双入口/M4 幂等由既有集成测试回归，未在本 live 栈重跑 GitHub→Web 全序列 | `evidence/m5/concurrent-wake.log`、supervisor 日志、既有 M4 测试 |
| 5 | supervisor/dispatcher 重启、实例失联、启动失败、子进程退出；停机保持；后台服务阻止休眠 | **通过**：supervisor 重启接续 alpha/beta 同一 PID，gamma 保持 sleeping；kill -9 beta 后 `instance_lost`/端口关闭/名额回收，wake 恢复；stale lock 导致 `start_failed`，清理后重试在线；beta 有真实后台任务时 sleep 返回 `accepted:false` 且进程保留 | `restart-adoption.log`、`process-exit-fault.log`、`supervisor-lifecycle.log`、`evidence/m5/live-snapshot.txt` |
| 6 | 状态原因/等待对象/最后进展/恢复动作与现场一致；桌面/手机、浅/深真实浏览器 | **通过（DOM + 截图）**：休眠显示 GitHub 监听暂停、原因、最后进展、唤醒动作；添加仓库对话框列出账号仓库、重复添加显示冲突；before/after 使用同一场景/视口/主题 | `ui-checks.json`、`after-*.png` / `before-*.png` |
| 7 | M4 暂停/继续、双入口幂等、M4-UX 草稿/分页/偏好回归 | **部分通过**：既有 API/dispatcher 集成测试与 M4-UX 单元测试全部通过；live 停止请求在 GitHub polling 子进程未退出时按既有规则变为 `blocked`，未伪报 stopped。没有重跑完整浏览器草稿/分页回归 | 全量测试输出；`M4-UX-VERIFICATION.md` 既有证据 |

### 关键 live 结果

- **容量与淘汰**：alpha 在线；添加 beta 后 beta 启动；添加 gamma 时 alpha 空闲，按 LRU 被
  `evicted_for_capacity` 停止，beta/gamma 在线；随后 beta/gamma 有真实任务时 alpha 唤醒得到
  `sleeping/capacity_wait`。
- **后台服务阻止休眠**：beta 的 DSH 进程下有 `bash -c date -Is; sleep 300` 与 `sleep 300` 两个存活
  超过 5 秒的后台子孙；`POST /repositories/:id/sleep` 返回 HTTP 200、`accepted:false`、
  `reasonCode=sleep_refused`，进程仍在，未用状态字段冒充已停止。
- **进程失联**：对 beta 执行 `kill -9` 后约 3 秒，DB 变为 `fault/instance_lost`、pid 为空、
  3403/3404 端口关闭；再次 wake 后新进程在线。
- **启动失败与恢复**：SIGKILL 遗留 `state/m5b.lock`，下一次启动在 120s 后 `start_failed`；
  修复后的 supervisor 清理该 profile 的陈旧 lock，重试后 `online`。
- **supervisor 重启**：alpha/beta 同一 PID 被接续，gamma 保持 sleeping，未因重启被错误拉起。
- **休眠 GitHub @**：beta 休眠且无进程时，在 `Bouyer12/m5a-beta-adf10ad9#1` 写入
  `@Bouyer12`；50 秒后该仓库会话数不变（仍为原有 1 条），也无新进程。
- **迁移**：0010 在隔离库回滚后 `repository_instances` 消失、迁移数 10；重放后恢复、迁移数 11；
  脚本要求正确 hash 且 0010 为最后一条。

## 3. 实际命令

```bash
# 基线
git rev-parse HEAD   # 160a22db322571f3a12fcc76748f86260fd34c04

# 静态检查与单元测试（最终 head）
corepack pnpm@11.7.0 -r --if-present typecheck
corepack pnpm@11.7.0 -r --if-present test
corepack pnpm@11.7.0 -r --if-present build

# 集成测试（真实 PostgreSQL）
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  corepack pnpm@11.7.0 test:integration

# 定向 API / dispatcher 测试
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  corepack pnpm@11.7.0 --filter @moyu/api exec vitest run test/integration/repositories.integration.test.ts
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  corepack pnpm@11.7.0 --filter @moyu/dispatcher exec vitest run test/integration/multi-repo.integration.test.ts

# 迁移 rollback → reapply
psql -v hash=<sha256> -f packages/db/migrations/rollback/0010_wandering_living_lightning.down.sql
DATABASE_URL=postgres://moyu@127.0.0.1:55432/moyu_m5a_rollback \
  corepack pnpm@11.7.0 --filter @moyu/db db:migrate

# UI 截图与 DOM 检查（真实 Chromium，测试会话 cookie 注入）
M5_SESSION_TOKEN=<isolated session> node scripts/m5/screenshots.mjs
M5_SESSION_TOKEN=<isolated session> node scripts/m5/ui-check.mjs
```

## 4. 未验证项与限制

1. **没有在 live 栈完成三个仓库各自的完整 PR 交付**。已用真实 worker Ticket、Session 和后台命令验证
   生命周期与忙闲，但没有让每个仓库都跑到测试/PR 完成；M3/M4 的 PR 闭环证据仍以原阶段记录为准。
2. **在线 GitHub @ 导入未在本栈重跑**。本单只验证了“休眠时 @ 不唤醒”；在线时 GitHub Source 已由
   supervisor 配置为启用，但完整通知→Trigger→Ticket 链路沿用 M4 证据。
3. **并发规模有限**：只验证两次并发唤醒与三仓库容量，没有做多客户端/长时间 soak 或资源压力测量；
   8GB 聚合预算、cgroup 计量与 M5-B 租约扩展不在本单。
4. **生产 supervisor 身份未落地**：测试 supervisor 仍为 root；生产需专用非 root/systemd、目录和凭据
   权限见设计文档，本单没有做正式部署或 Nginx 变更。
5. **真实设备 Passkey 未重验**：截图使用隔离测试会话，未绕过产品 Passkey；真实设备验收需所有者参与。
6. **live 停止的既有边界**：当 GitHub polling 的 `gh` 子进程尚未退出时，M4 暂停证据会判定
   `blocked` 而不是 `stopped`。这是既有“不伪报停止”的行为；M5-A 没有修改暂停证据算法，只在容量/休眠
   门控中排除了短命 polling 子进程。该场景需要后续在 GitHub Source 轮询空闲时复测停止成功路径。
7. **截图对比**：before 为 `main@160a22d` 的 M4-UX Web 构建，after 为当前构建；同一数据库、同一
   仓库选择、视口和主题。截图由真实 Chromium 生成，但本执行模型不能直接读图，因而额外用 DOM 断言
   记录关键文案与动作；仍建议人工目视复核。

## 5. 复现与清理

- 复现所需隔离目录：`/root/.dsh-m5`（0700）、0060 凭据/环境文件、`instances.json`、三个私有测试仓库。
- 清理测试实例：先 `POST /api/v1/repositories/:id/sleep`（有后台服务会被拒绝），或按 profile 停止
  `dsh --profile m5a|m5b|m5c`；不要删除 `DSH_HOME` 之外的文件。
- 测试仓库与 Issue #1 只含生命周期探针，可保留供复核；删除是破坏性操作，由所有者决定。
