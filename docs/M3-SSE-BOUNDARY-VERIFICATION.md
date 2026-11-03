# M3 合并后 SSE 跨 500 条回放边界验收

日期：2026-11-04。范围：Issue #16「验收 M3 合并后 SSE 跨 500 条回放边界」。本记录只记录实际执行过的命令与结果，未执行项单列。

## 结论

**通过。** 在真实 PostgreSQL 16 与真实 `GET /api/v1/events` HTTP 路由上，501 条历史事件可完整回放；在回放暂停于 500/501 页边界期间持久化的第 502 条事件按序送达；用数据库实际分配的第 500 条事件 ID 作为 `Last-Event-ID` 重连，只补发第 501、502 条，无漏发、乱序或重复。

本次没有发现需要修复的生产代码问题，因此没有修改 `apps/api/src/routes/events.ts`；改动仅为新增验收回归与本文档。

## 基线与环境

| 项 | 值 |
| --- | --- |
| 基线 `main` SHA | `13f89b6fca34105dc7b0598cb80499241cce09e1`（PR #10 合并提交） |
| 仓库 | `bouyer-sutrasky/MoYu` |
| 宿主 | Ubuntu 24.04.2 LTS，4 vCPU / 16 GB |
| 本地 Node | v22.23.3（宿主已有；仓库锁定 24.22.2，最终以 PR 的 CI 为准） |
| pnpm | 11.7.0（corepack） |
| PostgreSQL | 16.15，`127.0.0.1:5432` |
| 隔离方式 | 每次测试创建临时库 `moyu_api_test_<pid>_<random>`，结束后 `DROP DATABASE ... WITH (FORCE)` |
| 被测路由 | `buildApp()` 在 `127.0.0.1` 随机端口调用真实 `app.listen()`，客户端用 `fetch` 连接 `GET /api/v1/events` |
| 实例隔离 | 未连接或改动 4300 线上实例、3082 bootstrap、其它 profile、nginx 与生产数据库 |

## 验收方法

新增回归测试：[`apps/api/test/integration/sse-replay-boundary.integration.test.ts`](../apps/api/test/integration/sse-replay-boundary.integration.test.ts)。

1. 通过生产用的 `appendEvent()` 事务路径，在连接建立前写入 501 条契约有效的 `task.progress` 事件，记录数据库实际分配的 `seq`。
2. 用预置会话 Cookie 发起真实 SSE HTTP 请求（首次无 `Last-Event-ID`）。
3. 客户端读取前 500 个 SSE 帧。测试只使用一个**测试内**的数据库代理，在路由读取第 2 页（`seq > 500` 的查询）前暂停；该代理不改生产代码，PostgreSQL 与 HTTP 路由都是真实的。
4. 在服务端回放暂停于 500/501 页边界时，提交第 502 条事件，并调用进程内 `publishWorkspaceEvent()` 触发实时通知；随后释放第 2 页查询。
5. 继续读到第 501、502 条；随后直接查询数据库 `events` 表，得到 502 条实际 `seq` 作为唯一预期。
6. 断开首连，用数据库实际分配的第 500 条 `seq` 作为真实 `Last-Event-ID` 请求头重连，断言只补发第 501、502 条。

说明：当前实现先完成首次 `flush()` 才订阅进程内 bus，因此在首次回放期间发布的 bus 通知不会直接驱动写入；第 502 条由持久游标循环在释放第 2 页查询后读出。这正说明回放期间的通知丢失不会造成漏发；bus 在订阅后唤醒实时流的路径由既有 [`sse.integration.test.ts`](../apps/api/test/integration/sse.integration.test.ts) 覆盖。

## 断言与结果

| 检查 | 结果 |
| --- | --- |
| 首次回放的 500 帧等于数据库前 500 条 `seq`，顺序一致 | 通过 |
| 回放暂停于页边界时提交第 502 条并发布通知 | 通过（测试数据库代理确认路由请求第 2 页后暂停） |
| 尾部 2 帧依次为第 501、502 条 | 通过 |
| 客户端收到的 502 个 SSE ID 与数据库 502 条实际 `seq` 完全一致 | 通过 |
| 顺序严格递增，每条只出现一次（`Set` 大小 = 502） | 通过 |
| 第 500、501、502 条都到达 | 通过 |
| 以数据库实际分配的第 500 条 `seq` 作为 `Last-Event-ID` 重连 | 通过 |
| 重连只收到第 501、502 条，顺序一致且无重复 | 通过 |

测试文件单独运行：

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu:moyu_test@127.0.0.1:5432/postgres \
  corepack pnpm@11.7.0 --filter @moyu/api exec vitest run \
  test/integration/sse-replay-boundary.integration.test.ts
# exit 0：1 passed
```

完整真实 PostgreSQL 集成测试：

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu:moyu_test@127.0.0.1:5432/postgres \
  corepack pnpm@11.7.0 --filter @moyu/db --filter @moyu/api --filter @moyu/dispatcher \
  test:integration
# exit 0：db 10、api 21、dispatcher 4，共 35 passed；其中新增边界回归 1 passed
```

## 其它检查

```bash
corepack pnpm@11.7.0 exec eslint .
# exit 0
corepack pnpm@11.7.0 exec prettier --check "**/*.{ts,tsx,mjs,cjs,json,yml,yaml,css,html}"
# exit 0，All matched files use Prettier code style
corepack pnpm@11.7.0 -r --if-present typecheck
# exit 0，7 个 workspace 包
corepack pnpm@11.7.0 -r --if-present test
node --test scripts/m3/guard.test.mjs
# exit 0：contracts 13、api 14、dispatcher 3、runtime-client 5；guard 14
corepack pnpm@11.7.0 -r --if-present build
# exit 0：web / api / dispatcher 均构建成功
```

## 必需 CI

在代码提交 `ce4d6484ef5c1561ff57892c6932958dd65fec9a`（本记录随后只追加文档）上，PR #18 的两项必需检查均通过：

- `check (lint, format, types, unit tests, build)`：success（49s）。
- `integration (real PostgreSQL)`：success（42s），run `41675410037`；Node 24.22.2 + PostgreSQL 16，包含本次新增回归。

## 未验证项与限制

1. 本地实际运行使用 Node v22.23.3，而不是仓库锁定的 24.22.2；上述 PR CI 已按锁定 Node 版本重复执行本回归。
2. 验证对象是隔离 API 进程的 loopback HTTP，不是 `https://moyu.sutrasky.com` 经 nginx 的正式链路；本次验收范围是 SSE 路由的持久化回放边界，不涉及反代缓冲/超时。
3. 测试使用的数据库代理仅存在于测试进程，用于确定性地把第 502 条事件卡在页边界；生产路由没有测试钩子，也没有改动。
4. 没有真实长时连接、网络抖动或客户端限速场景；这些不属于 Issue #16 的验收条件。

## 迁移与回滚

无数据库迁移、配置或生产代码变更。回滚只需撤回新增的测试文件与本文档；不影响运行中的 API、dispatcher、数据库或部署。
