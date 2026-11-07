# M5-B 五项验收取证

本目录只记录在固定 head 上实际执行的结果；新增日志文件是本轮原始输出。基线为 PR #28
head `3278fb0e2e248dcaf32a59aba791a15339699b2a`；以下日志对应本单的未闭合项与复审返修。
历史日志保留原样，不追改旧结论。

## 本轮闭合

| 项 | 结论 | 日志 |
| --- | --- | --- |
| ② 生产 pause/replay 的生效投递计数 = 1 | 闭合：真实 dispatcher 暂停→继续后，同一 assignment 只持有一个 trigger input；丢失响应的重放返回 duplicate。另补同一 triggerId 的并发双 POST：一个 stored、一个 duplicate，运行时仍只有一份 input，resume 后只投递一次。 | `item2-pause-replay-live.log` |
| ③ fence 可观测性 | 闭合：选择「找到能读到实际 fence 的接口」；`GET /bridge/v1/tickets/:id` 返回 `admission`，resume 后新 assignment running、实际 lease/fence 与提交一致；旧代次 resume 返回 409 `admissionStale`，快照不变。 | `item3-fence-observability.log` |
| ④ 双库重启对账 | 闭合：Bridge SQLite 与 dispatcher PG 同时重启，逐字段比对一致，cursor 100→102；过期租约在生产 `maintainLeases` 路径上拒绝续租，红转绿。 | `item4-dual-db-restart-live.log` |

说明：`c64f38b` 中 `taskModel` 省略 null `reasoningEffort` 是 ② 的必要前置——Bridge 的
严格 model schema 会以 HTTP 400 拒绝 `"reasoningEffort":null`，消息无法进入运行时；
该修复不算作 ② 的投递计数本身。

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
- 生产 3082、生产库未改动；未改动 `/root/src/upstream/*` 源码，仅在该目录新增构建制品
  `m5b-admission-build21`。

日志中的 token 以 `***` 代替，未写入任何凭据。

## 验收闸口

以上各项以固定 40 位 head、干净工作树和该 head 上两项必需 PR 检查 success 为闸口；
未验证项不表述为通过。
