# M5-B 五项验收取证

本目录记录在给定 head 上实际执行的结果。基线为 PR #28 head
`3278fb0e2e248dcaf32a59aba791a15339699b2a`；以下新增日志对应本单的三个未闭合项。
历史日志保留原样，不追改旧结论。

## 本轮闭合

| 项 | 结论 | 日志 |
| --- | --- | --- |
| ② 生产 pause/replay 的生效投递计数 = 1 | 闭合：真实 dispatcher 暂停→继续后，同一 assignment 只持有一个 trigger input；丢失响应的重放返回 duplicate | `item2-pause-replay-live.log` |
| ③ fence 可观测性 | 闭合：选择「找到能读到实际 fence 的接口」；`GET /bridge/v1/tickets/:id` 返回 `admission`，resume 后新 assignment running、旧代次 admit 被 422 拒绝 | `item3-fence-observability.log` |
| ④ 双库重启对账 | 闭合：Bridge SQLite 与 dispatcher PG 同时重启，逐字段比对一致，cursor 100→102，过期租约拒绝续租红转绿 | `item4-dual-db-restart-live.log` |

## 已闭合（前序，勿重做）

- P1 过期租约被当当前代次：`sync.ts` / `operations.ts` 的当前代次查询带
  `expires_at` 过滤；`p1-expired-lease.log`。
- 规范轴：`projectionBranches` 有界（500）；`current-projection.log`、
  `projection-branches.log` 已入库。
- §5ter ①/⑤：真实 HTTP/SQLite+PG 回归与子进程启动/停止计数。

## 复跑环境

三项日志的现场值：

- 隔离 PostgreSQL 16：`127.0.0.1:55432`（本单数据库 `m5b_e2e_manual`）。
- m5b 阶段实例：Bridge `http://127.0.0.1:3403`，build
  `/root/src/upstream/m5b-admission-build21`，`MOYU_REQUIRE_ADMISSION=1`。
- 测试仓库：`Bouyer12/m5a-beta-adf10ad9`；dispatcher 由
  `node apps/dispatcher/dist/main.js` 真实循环启动。
- 生产 3082、`/root/src/upstream/*` 源码与生产库未改动。

日志中的 token 以 `***` 代替，未写入任何凭据。
