# M5-B 五项验收取证（head 6f71d726fdd5af359806c1211d3ca081088e9c01）

本目录只记录在固定 head 上实际执行的结果；新增日志文件是本轮原始输出。

## 1. PostgreSQL 回归：命令与断言（已完成部分）

执行目录：`/root/src/leases-resources-m5b-a59cb491b2e0`

```
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres CI=true \
  corepack pnpm --filter @moyu/dispatcher exec vitest run \
  test/integration/recovery-projection-branches.integration.test.ts --reporter=verbose
```

结果见 `projection-branches.log`：2 passed。断言：
- `projects a current-generation running event and records the branch`：state=`running`，`projectionBranches`=`projected`。
- `keeps a stopped task and its evidence when a queued event arrives`：state 仍 `stopped`，`stop_evidence` 保留 `pause-proof`。

外部 current-projection 组（真实 Bridge HTTP + SQLite + PG）：

```
cd /tmp/moyu-m5b-http-admit.npU95Tfh
PATH=/opt/moyu-node24/bin:$PATH TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  node_modules/.bin/vitest run \
  tests/moyu-review-cedcb82-current-projection.spec.ts \
  tests/moyu-review-cedcb82-pid-barrier-1039.spec.ts --reporter=verbose
```

结果见 `current-projection.log`：4 passed。断言：
- pause-race：暂停事务持锁期间 sync 等锁；提交后 state=`stopped`，`stop_evidence.reviewStoppedProof` 保留，cursor 前移。
- new-generation：event lease/fence 7 匹配当前 active lease；旧 reservation lease/fence 1 不再判 stale；state=`running`，cursor 前移。

## 2. 真实暂停/继续端点

未完成。本轮没有通过真实 `/bridge/v1/tickets/:id/pause|resume` HTTP 端点取得 stopped/queued 证据；现有证据仍是受控 executor + 数据库投影。

## 3. 租约与停止/重放原子性（exactly-once）

未完成。已知 claimExecution 条件更新与 stop_evidence 保护有单测，但缺少并发“停止 vs 重放”投递计数回归（同一 assignment 两次生效投递）。

## 4. 双库重启一致性

未完成。SQLite 与 PG 的联合重启、重启前后快照与 lease/fence 代次对照尚未执行。

## 5. 实际子进程启动/停止计数

未完成。现有 executor 为受控替身，未启动真实子进程，无启动/退出计数原始输出。

## 备注

head 6f71d72 两项 PR 检查 success；工作树在本证据提交前干净。以上 2–5 项按 §5ter 属未验收，不能转 ready 或合并。
