# 0014 回滚保护证据（2026-11-20）

- 工单：Issue #93（[遗留重构 1] 保护 0014 迁移回滚）；旧 Issue #37、旧 PR #48 用于追溯。
- 复核基线：`b6c2efab08e2703cc8e974dda7ff872db3122612`（`origin/main`）。
- 实施分支：`agent/rollback-guard-0014-802b3250b91b`。
- 最终提交：`d64c4efa3a4b93654081d412c681129293178609`（首版 `6114223`；`d64c4ef` 按评审意见拒绝 NULL `created_at`）。
- 数据库：本机隔离 PostgreSQL 16（`127.0.0.1:55432`，数据目录 `/tmp/moyu-pgdata`），每个用例创建一次性数据库并在结束时删除；未读写生产库 `moyu_m6c`，未执行生产迁移。

## 实际运行制品及 hash（最终 `d64c4ef`）

| 制品 | sha256 |
| --- | --- |
| `packages/db/migrations/0014_execution_reservations.sql`（正向，未改） | `46344e9ba62e570e08f2797c21eaef6aaf194191378fa4860cee28444a01c1d3` |
| `packages/db/migrations/rollback/0014_execution_reservations.down.sql` | `9143f76c30e7bb25d08a95c2ea45b902e4ae191f063b5e44f9691898ee1aaa8a` |
| `packages/db/src/migrate.ts` | `546f4984c4c5f55c0e267b60c2692b6e5b5f02dbb0ed8b811af744aa0cd5ea5b` |
| `packages/db/test/integration/rollback-0014.integration.test.ts` | `547cb2dd1550339c623cc1d36fbc259dc0d643674d27b7241defb59e72134493` |

首版（`6114223`）的 down hash 为 `ecaefa24ece630778fd6e94e6d0bdc034bc1339106f495ef83be9e21ed24a95a`；修前基线 down hash 为 `d46a35afb8da6917812eef2bcee3c091d031e2b65785cfcf04b4b6dfea00d09d`。

## 修前（基线 `b6c2efa`，旧脚本）

```bash
psql 'postgres://moyu@127.0.0.1:55432/<one-off db>' -X -q -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/rollback/0014_execution_reservations.down.sql
```

完整输出见 [`red-baseline-b6c2efa.log`](./red-baseline-b6c2efa.log)。

- `down_exit=0`：在 0015–0024 已应用时仍执行成功。
- 修前快照：`table=execution_reservations`、3 个外键、`ledger_total=25`、0014 ledger 1 条、最新记录为 0024。
- 修后快照（同一数据库）：表被删除、3 个外键消失、`ledger_total=24`、0014 ledger 0 条；迁移器随后会跳过 0014，表不会重建。缺陷复现。

## 返修：拒绝 NULL `created_at`（评审 `edc77009`）

Drizzle 0.44.7 的 `drizzle.__drizzle_migrations.created_at` 允许为 NULL；迁移器用 `ORDER BY created_at DESC LIMIT 1`，PostgreSQL 会把 NULL 排在前面。首版守卫的 `>` 与 `=` 比较会跳过 NULL 行，仍可能执行删除。

- 红测（`631aa7a` 的守卫 + 新用例）：`2 failed | 10 passed`。其中「NULL 行在账本其他位置」用例执行了删除，只在断言拒绝时失败。见 [`null-red-631aa7a.log`](./null-red-631aa7a.log)。
- 修后 `d64c4ef`：在首个 DDL 前显式拒绝任何 NULL `created_at` 行，保留账本锁与纯 SQL。
- 两种场景的 psql 证据见 [`null-evidence-d64c4ef.log`](./null-evidence-d64c4ef.log)：
  - 账本其他位置存在 NULL 行：`down_exit=3`，`0014 rollback refused: 1 ledger row(s) have no created_at, so the migrator's latest order is undefined; repair the ledger first`；拒绝前后 `table=execution_reservations`、3 个外键、`ledger_total=26`、0014 ledger 1 条完全一致。
  - 0014 行本身 `created_at IS NULL`：`down_exit=3`（同一拒绝信息）；拒绝前后 `table`、3 个外键、`ledger_total=25`、0014 ledger 1 条完全一致。

## 修后：拒绝、合法回滚、重迁与锁（`d64c4ef`）

完整输出见 [`green-d64c4ef.log`](./green-d64c4ef.log)。

```bash
psql 'postgres://moyu@127.0.0.1:55432/<one-off db>' -X -q -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/rollback/0014_execution_reservations.down.sql
```

- 0015–0024 仍在时：`down_exit=3`，
  `ERROR: 0014 rollback refused: 10 later migration(s) are already applied; roll them back first`。
- 拒绝前后快照逐项相同：表存在、3 个外键、`ledger_total=25`、0014 ledger 1 条、最新记录仍为 0024。
- 合法回滚：依次执行 0024→0015 down（各自 `exit=0`）后再执行 0014 down（`exit=0`）；表、3 个外键、0014 ledger 均删除，`ledger_total` 15→14。
- 重迁恢复：`pnpm --filter @moyu/db db:migrate` `exit=0`；快照恢复为 `table=execution_reservations`、3 个外键、`ledger_total=25`、0014 ledger 1 条、最新记录为 0024。
- 账本锁：回滚在持有 `pg_advisory_xact_lock(918273647)` 时拒绝；`migrateDatabase` 在同一锁下等待；两个并发锁用例均通过。

## 自动化检查（最终 `d64c4ef`）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @moyu/db exec vitest run test/integration/rollback-0014.integration.test.ts --reporter=verbose` | 12 passed（[日志](./targeted-d64c4ef.log)） |
| `pnpm --filter @moyu/db test:integration` | 17 files / 64 tests passed（[日志](./db-integration-d64c4ef.log)） |
| `pnpm test:integration`（根脚本） | exit 0：db 64、api 142、dispatcher 100（+1 skipped）、supervisor 4（[日志](./root-integration-d64c4ef.log)） |
| 必需 CI | 见 PR #101 checks |

覆盖场景：后续迁移存在、hash 漂移、ledger 缺失、ledger 重复、NULL `created_at`（其他行与 0014 行）、0014 完全未应用、重复回滚、合法回滚、重迁恢复、DDL 后语句失败的事务回滚，以及账本锁双向串行化。

## 与旧 PR #48 的增量核对

- 旧 PR #48 把 0014 down 改成与 0004–0013 相同的调用方契约：`psql -v hash=<sha256>` 加 `\set`/`\if` 元命令，测试也改为 spawn `psql`。
- 本单明确要求「保留内置哈希和纯 SQL」，因此不采用旧 PR 的调用接口；内置 hash、普通客户端可执行性和事务性保持不变。
- 复用旧 PR 的失败场景，并按迁移器真实的 `created_at` 顺序判断“最新”，补充 NULL 时间戳拒绝、迁移器账本锁及双向串行化回归。

## 待验项

- 未在真实/生产库执行迁移或回滚（本单只授权一次性隔离 PG）。
- 必需 GitHub CI 由 PR 触发，合并由所有者完成。
- 本次不改 UI，无 before/after 视觉证据（不适用）。
