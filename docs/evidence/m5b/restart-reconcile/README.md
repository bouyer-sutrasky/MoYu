# 重启对账证据（2026-11-20，Issue #95）

本目录只包含**真实执行过**的隔离检查。真实 Bridge/dispatcher/两库重启与真实 GitHub PR 验收
依赖 #92、#94，尚未执行，见 `docs/M5-B-RESTART-RECONCILE.md` §7。

## 环境

| 项 | 值 |
| --- | --- |
| 基线 | `main@b6c2efab08e2703cc8e974dda7ff872db3122612`（= `origin/main`） |
| 实现提交 | `0c97a7f43c9148d5d88715138c506c0826b55a37` |
| Node / pnpm | `/opt/moyu-node24/bin/node` v24.22.2；pnpm 11.7.0 |
| PostgreSQL | 16.15，隔离实例 `127.0.0.1:55432`，每文件独立建库并在 `afterAll` `DROP DATABASE … WITH (FORCE)` |
| 数据库迁移 | 无新增；最后一条仍为 `0024_deletion_operation_id.sql`（25 个迁移文件） |
| 生产/其它 | 未触碰生产库、3082 bootstrap、4300 线上实例、`/root/src/upstream/*` |

## 文件

| 文件 | 内容 |
| --- | --- |
| `isolated-red.log` | 首轮修前（`apps/dispatcher/src` 为基线，只加测试）同一命令：exit 1，3 文件失败，5 failed / 4 passed |
| `isolated-green.log` | 首轮修后同命令：exit 0，3 文件通过，9 passed |
| `isolated-interleave-red.log` | 并发旧快照返修前（代码为 `0c97a7f`，测试为本轮新增/更新）：exit 1，5 failed / 7 passed |
| `isolated-interleave-green.log` | 返修后同命令：exit 0，3 文件通过，12 passed |
| `full-checks.log` | 修后 `pnpm check` 与 `pnpm test:integration` 的套件汇总行与命令，两者 exit 0 |
| `artifacts.txt` | 完整 SHA、构建制品与哈希、测试计数、未验证项 |

## 修前 → 修后

```bash
PATH=/opt/moyu-node24/bin:$PATH \
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
pnpm --filter @moyu/dispatcher exec vitest run \
  test/integration/restart-interrupted-reconcile.integration.test.ts \
  test/integration/reservations.integration.test.ts \
  test/integration/recovery-review-idempotent.integration.test.ts
```

- 首轮修前：exit 1。关键失败 `expected 'assignment-after-restart' to be 'assignment-before-restart'`：
  预留行没有跟随运行时在同一租约下重发的 Assignment；已 claim 的预留行不再进入恢复路径。
- 首轮修后：exit 0。新增的权威快照采纳、无状态事件重发、并发/重放只接续一次、被替换回合晚到
  事件不投影全部通过。
- 返修（P2 并发旧快照）：修前 5 failed / 7 passed；修后 12 passed。锁内 expected assignment、
  冲突重读、拒绝已记为被替代的目标、重读仍不一致时保留现状均有真实 PG 用例。

## 现场待验（本目录未包含）

真实重启与真实 GitHub PR 的判据、命令见设计文档 §7；在 #92 环境与 #94 生命周期就绪后，
用合并后的同一构建复跑并把脱敏原始日志放到本目录的后续子目录中。
