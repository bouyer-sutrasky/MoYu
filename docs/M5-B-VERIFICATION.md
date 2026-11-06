# M5-B 验证记录

日期：2026-11-06。基线：`main@af35caf9315b22d8c421584409bea329372862b8`。
被测代码：本分支实现提交（最终完整 head 在 PR 固定评论中记录）。本文只记录实际执行过的
命令、结果与未验证项；未完成项不表述为通过。

## 1. 现场预检

| 项 | 实测 |
| --- | --- |
| 宿主 | Ubuntu 24.04.2、kernel 6.8.0-53、4 vCPU、16 373 000 kB RAM |
| cgroup | cgroup v2 unified；memory 控制器可在独立子树启用 |
| 服务 | systemd 可用；Docker 未安装；Node 24.22.2（`/opt/moyu-node24`）、pnpm 11.7.0 |
| 数据库 | 隔离 PostgreSQL 16 `127.0.0.1:55432`；生产 `moyu` 未触碰 |
| 基线 | `origin/main` 与工作树 HEAD 均为 `af35caf…`；工作树开始时干净 |
| 既有服务 | 3082 bootstrap、4300 线上 API、3401–3404 M5-A 实例未改动 |

## 2. 静态检查与单元测试

```bash
corepack pnpm check
# eslint: 通过
# prettier --check: 通过
# typecheck: 8 个项目通过
# unit: contracts 13、runtime-client 13、api 20、dispatcher 3、supervisor 27
#       以及 guard 15 / verify-lock 15
corepack pnpm build
# API/dispatcher/supervisor/web 全部构建成功
```

构建制品 sha256（实现构建，非发布制品）：

```text
478a23f401be6ac8f59d4f17f2a2e83a39d41f7c6b63f418b0ffbc8d7adf20be  apps/api/dist/server.js
d612d86a9c6442dfcd18b647f6fed9c836bd9b3dc22b978adb351f0c8503a717  apps/dispatcher/dist/main.js
0c7cd368a9607d5a7e9ba77dc790a35fd04b27df92cf57a8ac79d9185da3d176  apps/supervisor/dist/main.js
131a0fd5afafd574797f9ab249519f37ec4636976585ed00c36627aeca1285a4  apps/web/dist/assets/index-CPacwuA8.js
39a2cbfc47d44d272bc18fad5772346b891e06713d07009e4357f7af51cb5424  apps/web/dist/assets/index-DnIo0nRx.css
b06e32aebd8dfa96845f74dc916613de7f4d775935c7ce27f5875fcef13f8196  packages/db/migrations/0013_loving_quentin_quire.sql
```

## 3. 真实 PostgreSQL 集成测试

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres corepack pnpm test:integration
```

| 套件 | 结果 |
| --- | --- |
| `@moyu/db`（含 0013 rollback → reapply） | 10 文件 / 36 测试通过 |
| `@moyu/api`（M4 暂停继续、双入口、分页、仓库生命周期） | 11 文件 / 66 测试通过 |
| `@moyu/dispatcher`（多仓库、operations、租约） | 4 文件 / 44 测试通过 |

租约测试覆盖：

1. 两个任务并发竞争同一仓库，只产生一条 `active` 租约，另一方得到 `held`。
2. 过期租约没有停止证明时拒绝替代（`stop_proof_required`），且不插入新代次。
3. 运行中的 Ticket 被原代次接管；停止证明到达后旧行 `recovered`，新代次 token 严格增大。
4. 旧代次的回执被拒绝，`runtime_lease_events` 记录 `stale_receipt_rejected`，任务状态不变。
5. 空闲/等待人工状态释放名额，任务与租约绑定清除。

资源策略单元测试覆盖预算内准入、硬上限拒绝、宿主余量/压力弹性、迟滞、未知 cgroup 按估算
计入、slice 上限低于/高于策略等 7 个用例。

## 4. 迁移回滚

```bash
# 独立 PostgreSQL 16
psql -v hash=<0013 sha256> -f packages/db/migrations/rollback/0013_loving_quentin_quire.down.sql
DATABASE_URL=postgres://moyu@127.0.0.1:55432/<isolated> \
  corepack pnpm --filter @moyu/db db:migrate
```

结果：0013 是最后一条迁移时回滚成功（删除两个新表、9 个新增列/约束），错误/缺失 hash 与
非最后一条时拒绝；reapply 后表、列、索引恢复。`rollback-0013` 测试通过。

## 5. 非 root 隔离 cgroup 与 8 GiB slice

```bash
bash scripts/m5b/nonroot-oom-check.sh
```

实测（`docs/evidence/m5b/nonroot-oom.log`）：

| 检查 | 结果 |
| --- | --- |
| 宿主启动前 MemAvailable | 14 376 560 kB（高于 8 GiB 安全下限） |
| slice 控制组 | `/moyu.slice/moyu-m5b.slice` |
| slice `memory.max` / `memory.high` | 8 589 934 592 / 6 442 450 944 字节（8 / 6 GiB） |
| 压测进程身份 | `nobody`（uid 65534），运行在 slice 内 256 MiB scope |
| scope `memory.max` | 268 435 456 字节 |
| 结果 | `oom-kill`，主进程 `killed/status=KILL`，`Memory peak: 256.0M`，swap peak 0 |
| 宿主结束后 MemAvailable | 14 374 360 kB（无宿主级 OOM） |

该 fixture 先读取自身 `memory.max`，只有 ≤256 MiB 才分配；使用 `MemorySwapMax=0` 强制在
cgroup 内 OOM，而不是让宿主回收/换出。单元与 cgroup 在退出时清理。此证据证明非 root
子组、单一 slice 上限与受控 OOM 可用；**不**证明完整非 root supervisor 生命周期或
平台/DB/runtime/三仓库同 slice 压力。

## 6. 浏览器 before/after

两个真实 API 实例读取同一个隔离数据库：before 为 `main@af35caf` 的 Web/API 构建，
after 为本分支构建；同一仓库、视口与主题。运行行是固定的运行时投影 fixture（用于视觉状态），
后端行为由上面的集成/单元测试验证，不把 fixture 当作 live supervisor 证据。

```bash
M5B_SESSION_TOKEN=<isolated session> node scripts/m5b/screenshots.mjs
M5B_SESSION_TOKEN=<isolated session> node scripts/m5b/ui-evidence.mjs
```

产物：`docs/evidence/m5b/` 12 张截图（beta 资源等待：桌面/手机、浅/深；gamma 重试/OOM；
alpha 在线并持有租约）、`ui-checks.json`、`records.json`。

DOM 断言结果：

| 状态 | before | after |
| --- | --- | --- |
| 资源等待仓库显示“等待内存余量 / 内存不足，等待实测余量” | 否 | 是 |
| 在线仓库显示执行代次 | 否 | 是 |
| 故障仓库显示“自动重试已用尽 / 已发生 OOM / 等待运行时” | 否 | 是 |

## 7. 故障事件（必须记录）

2026-11-06 约 01:53 CST，在一次非 root cgroup 探针中，内存压测进程未能写入预期的委托
cgroup（`cgroup.procs` 写入失败），实际运行在
`/system.slice/dsh-superagent.service`，触发内核全局 OOM，杀死了约 14.7 GB anon-rss 的
node 进程，主 3082 服务随之中断。未修改生产数据、Nginx、3082 配置或 systemd unit；
空的测试 cgroup 已清理，主服务由所有者恢复。此后没有再次执行宿主级内存压力测试。

该事件说明：没有先验证进程所在 cgroup 就分配内存是不安全的；仓库中的压测 fixture
`scripts/m5b/memory-hog.mjs` 因此先读取自身 `memory.max`，超过 256 MiB 或缺失即拒绝分配，
并且只应通过 `systemd-run` 放入独立 slice 后使用。

## 8. 未验证项

1. **非 root supervisor 的真实生命周期**：已用 `nobody` 在 256 MiB scope 中验证 cgroup
   OOM 与 8 GiB slice 上限，但未以非 root 运行 supervisor 本身，也未跑启动/停止/失联/重试
   的完整非 root 生命周期。
2. **平台+DB+runtime+构建测试同 slice 的完整压力**：slice 上限与子组 OOM 已验证；未在真实
   平台、隔离 DB、runtime 与三仓库同时运行时压到边界，不把 256 MiB 子组证据外推为完整
   8 GiB 聚合验收。
3. **三仓库资源压力、恢复后清错**：未完成 live 复现；OOM 子组证据不等于三仓库调度证据。
4. **上游 runtime admission**：start/retry/GitHub Trigger 尚未带上 admission；当前 fencing
   在平台控制面执行，在线 GitHub 入口存在 runtime 先执行的窗口。
5. 因此六类矩阵未完整通过，PR 不能按“全阶段完成”交付；需要继续补齐上述 live 证据与
   上游契约改动。

## 9. 回滚与清理

- 代码回滚：revert 本 PR；迁移回滚见 §4（只在 0013 为最后一条时执行）。
- 测试 UI：隔离 API 已停止，`moyu_m5b_ui` 已删除；截图与 JSON 保留在
  `docs/evidence/m5b/`。
- 测试 cgroup：`/sys/fs/cgroup/moyu-m5b-*` 已无残留；未改动线上/共享 cgroup。
