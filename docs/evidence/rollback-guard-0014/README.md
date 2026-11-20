# 0014 回滚保护证据（2026-11-20）

- 工单：Issue #93（[遗留重构 1] 保护 0014 迁移回滚）；旧 Issue #37、旧 PR #48 用于追溯。
- 复核基线：`b6c2efab08e2703cc8e974dda7ff872db3122612`（`origin/main`）。
- 实施分支：`agent/rollback-guard-0014-802b3250b91b`。
- 实施提交：`61142238e532e4878d7d754ef71cfbc6a338387c`。
- 数据库：本机隔离 PostgreSQL 16（`127.0.0.1:55432`，数据目录 `/tmp/moyu-pgdata`），每个用例创建一次性数据库并在结束时删除；未读写生产库 `moyu_m6c`，未执行生产迁移。

## 实际运行制品及 hash

| 制品 | sha256 |
| --- | --- |
| `packages/db/migrations/0014_execution_reservations.sql`（正向，未改） | `46344e9ba62e570e08f2797c21eaef6aaf194191378fa4860cee28444a01c1d3` |
| `packages/db/migrations/rollback/0014_execution_reservations.down.sql`（修后） | `ecaefa24ece630778fd6e94e6d0bdc034bc1339106f495ef83be9e21ed24a95a` |
| `packages/db/src/migrate.ts`（修后） | `546f4984c4c5f55c0e267b60c2692b6e5b5f02dbb0ed8b811af744aa0cd5ea5b` |
| `packages/db/test/integration/rollback-0014.integration.test.ts`（修后） | `be88f8509a51282b22aba5a6531248bad11351f3cd3f8b264df88d7d8626fd6e` |

修前 down 文件 hash：`d46a35afb8da6917812eef2bcee3c091d031e2b65785cfcf04b4b6dfea00d09d`。

## 修前（基线 `b6c2efa`，旧脚本）

```bash
psql 'postgres://moyu@127.0.0.1:55432/<one-off db>' -X -q -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/rollback/0014_execution_reservations.down.sql
```

完整输出见 [`red-baseline-b6c2efa.log`](./red-baseline-b6c2efa.log)。

- `down_exit=0`：在 0015–0024 已应用时仍执行成功。
- 修前快照：`table=execution_reservations`、3 个外键、`ledger_total=25`、0014 ledger 1 条、最新记录为 0024。
- 修后快照（同一数据库）：表被删除、3 个外键消失、`ledger_total=24`、0014 ledger 0 条；迁移器随后会跳过 0014，表不会重建。缺陷复现。

## 修后（`6114223`）

```bash
psql 'postgres://moyu@127.0.0.1:55432/<one-off db>' -X -q -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/rollback/0014_execution_reservations.down.sql
```

完整输出见 [`green-6114223.log`](./green-6114223.log)。

- 0015–0024 仍在时：`down_exit=3`（`ON_ERROR_STOP`），
  `ERROR: 0014 rollback refused: 10 later migration(s) are already applied; roll them back first`。
- 拒绝前后快照逐项相同：表存在、3 个外键、`ledger_total=25`、0014 ledger 1 条、最新记录仍为 0024。
- 合法回滚：依次执行 0024→0015 down（各自 `exit=0`）后再执行 0014 down（`exit=0`）；表、3 个外键、0014 ledger 均删除，`ledger_total` 15→14。
- 重迁恢复：`pnpm --filter @moyu/db db:migrate` `exit=0`；快照恢复为 `table=execution_reservations`、3 个外键、`ledger_total=25`、0014 ledger 1 条、最新记录为 0024，与回滚前一致。
- 纯 SQL、无调用方参数：整个脚本可由 `psql` 或普通 `pg` 客户端直接执行；内置 hash 与正向文件 sha256 一致，并由测试断言固定。

## 自动化检查

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @moyu/db exec vitest run test/integration/rollback-0014.integration.test.ts --reporter=verbose` | 10 passed（[日志](./targeted-6114223.log)） |
| `pnpm --filter @moyu/db test:integration` | 17 files / 62 tests passed（[日志](./db-integration-6114223.log)） |
| `pnpm check` | exit 0（lint、format、typecheck、unit tests） |
| `pnpm build` | exit 0 |
| `pnpm test:integration`（根脚本） | exit 0：db 62、api 142、dispatcher 100（+1 skipped）、supervisor 4 |

覆盖场景：后续迁移存在、hash 漂移、ledger 缺失、ledger 重复、0014 完全未应用、重复回滚、合法回滚、重迁恢复、DDL 后语句失败的事务回滚，以及账本锁的双向串行化（回滚等待迁移锁、`migrateDatabase` 等待回滚锁）。

## 与旧 PR #48 的增量核对

- 旧 PR #48 把 0014 down 改成与 0004–0013 相同的调用方契约：`psql -v hash=<sha256>` 加 `\set`/`\if` 元命令，测试也改为 spawn `psql`。
- 本单明确要求「保留内置哈希和纯 SQL」，因此不采用旧 PR 的调用接口；内置 hash、普通客户端可执行性和事务性保持不变。
- 复用旧 PR 的失败场景（重复回滚、hash 不符/缺失、重复 ledger、后续迁移、事务内后续失败、未应用、合法回滚 + 重迁），并按迁移器真实的 `created_at` 顺序判断“最新”，补上迁移器账本锁及双向串行化回归。

## 待验项

- 未在真实/生产库执行迁移或回滚（本单只授权一次性隔离 PG）。
- 必需 GitHub CI 由 PR 触发，合并由所有者完成。
- 本次不改 UI，无 before/after 视觉证据（不适用）。
