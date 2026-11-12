# ISS-63 验证记录：按仓库配置检查命令

日期：2026-11-12。基线：`main@115d43d166465f211ba0a8d177fad3712e9162a0`。
被测代码：分支 `agent/repository-check-commands-63`，最终 head 以 PR #64 为准；实现提交 `6eb8500`，迁移回归修正 `ea7cf27`，红绿脚本 `a4ea850`，脚本 lint `9a1eca3`，审计行锁 `629fafa`，并发审计测试 `d2a406f`，评审修复与证据加固 `4a2bddb`，文档提交在其后。
红绿证据：`docs/evidence/m63/ISS63-check-commands.txt`（脚本 `scripts/m63/evidence.sh` 生成，运行于 `4a2bddb`；日志内还断言 base 树没有 `check_commands`、branch 树有该列，避免「用错树」造成假红）。

## 1. 范围

- 新增 `repositories.check_commands jsonb null`：`null` = 使用 supervisor 的 `REVIEW_CHECK_COMMANDS`，非空数组 = 该仓库自己的命令。
- 新增 `repository_audit_events`：每次被接受的命令变更记录 actor、from、to；与更新同一事务，并在事务内 `FOR UPDATE` 重读当前值，避免并发修改把同一旧值写成两条审计。
- 新增 `PATCH /api/v1/repositories/:id`，`POST /api/v1/repositories` 接受可选 `checkCommands`，`GET` 返回 `checkCommands`。
- supervisor 用现有 `DATABASE_URL` 直接读取该列；共享契约校验；非法/空值 **fail-closed 422**；`REVIEW_CHECK_TOTAL_TIMEOUT_MS` 约束一次检查的总预算。
- 最小 UI：侧栏选中仓库后的「检查命令设置」，可继承全局默认或按仓库自定义。

非目标：按分支/PR 覆盖、命令白名单/沙箱、`repositories.status` 语义、生产部署。

## 2. 红 → 绿证据（真实 PostgreSQL + 真实 supervisor 进程 + 真实 bash）

脚本用隔离库、`/tmp/m63-*`、回环端口 4790/4791；不启动 worker、不碰生产 API 4300/3082。

**红（base = `115d43d`，现状）**：两个仓库都没有（也没有列可放）仓库级命令，同一个 supervisor 的 `REVIEW_CHECK_COMMANDS=["printf global"]` 同时作用于两者。

```
repo-a (no per-repository config): HTTP 200
{"data":{...,"runs":[{"command":"printf global","exitCode":0,"passed":true,"output":"global"}]}}
repo-b (no per-repository config): HTTP 200
{"data":{...,"runs":[{"command":"printf global","exitCode":0,"passed":true,"output":"global"}]}}
BASE-MATCH: both repositories used the supervisor-wide command
```

**绿（branch，修复后）**：仓库 A `["printf repo-a"]`，仓库 B `null`（继承默认）。

```
repo-a (custom ["printf repo-a"]): HTTP 200
{"data":{...,"runs":[{"command":"printf repo-a","exitCode":0,"passed":true,"output":"repo-a"}]}}
repo-b (null = default): HTTP 200
{"data":{...,"runs":[{"command":"printf global","exitCode":0,"passed":true,"output":"global"}]}}
```

**非法配置 fail-closed**：直接把仓库 A 的列改成 `[""]`（数组长度为 1，能通过 DB 形状检查，但契约拒绝空命令）后请求检查：

```
repo-a (stored invalid [""]): HTTP 422
{"error":{"code":"invalid_request","message":"仓库检查命令配置无效，拒绝执行：must not be blank"}}
```

没有执行任何命令，也没有回退到全局默认。脚本最后恢复 A 的配置并输出 `RESULT PASS`。

## 3. 自动化测试（jd-mc，Node v24.22.2 / pnpm 11.7.0）

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | **EXIT=0**；`apps/supervisor` 79 tests / 8 files（含新增 resolver、总预算、配置交叉校验、service 用例），`packages/contracts` 26 tests；lint/format/typecheck 全通过 |
| `pnpm test:integration`（`TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres`） | **EXIT=0**；db `47 passed`，api `126 passed`，dispatcher `82 passed / 1 skipped` |
| `db` 集成中的 `rollback-0018` | 3 个用例通过：up/down/re-up、二次回滚拒绝、更晚迁移存在时拒绝、旧库升级保留行、`[]`/9 条越界被 CHECK 拒绝、正常 1 条可写 |
| `pnpm build`（证据脚本内） | 两棵树均成功，supervisor `dist/main.js` 可启动并监听回环端口 |

关键回归：现有 `rollback-0005/0006/0009/0014/0015/0016/0017` 与 `migrations` 套件按 0018 存在调整（先回滚 0018，或迁移计数 19、表/索引清单增加 `repository_audit_events`），断言未被削弱。

## 4. 逐条对 Issue #63 验收

- [x] 两个仓库各配不同命令，`review/checks` 返回 `command` 逐字一致、退出码正确（红绿证据）。
- [x] 未配置仓库回退 `REVIEW_CHECK_COMMANDS`，行为与改动前一致（绿段 repo-b）。
- [x] 非法/空数组 → 该仓库检查 fail-closed，返回明确 422，不静默跳过（绿段 invalid + resolver 单测）。
- [x] 迁移平滑（新增列可空，不回填；`rollback-0018` 旧库升级用例）。
- [x] 现有 MoYu 单仓库路径零行为变化（repo-b 回退；现有 review/API 集成测试全绿）。
- [x] 只有 owner 能写；每次变更写审计（API 集成测试：创建/修改/清除三条 from→to，no-op 不写；`findOwnedRepository` 404 其他/不存在仓库）。
- [x] 文档写明能力边界（`docs/API-CONTRACTS.md` 与 UI 文案）。

## 5. 安全约束

- 命令字段只在 owner 认证后可见/可写；PATCH 与 POST 都走 `authenticate`。
- supervisor 控制接口仍只收 `repositoryId + ticketId`；命令不经过 HTTP，避免「平台传任意 shell」这条面。
- supervisor 用共享 `repositoryCheckCommandsSchema` 校验：1–8 条、单条 ≤2000 字符、拒绝 NUL/换行/空白；非法即 422。配置阶段还拒绝「单条超时 > 总预算」，避免运行时静默截断。
- 审计更新在事务内 `FOR UPDATE` 重读当前值；并发 PATCH 的审计行形成 `null → A → B` 链（API 集成测试覆盖）。同值 PATCH 不再写 `updated_at` 或审计行。
- 检查子进程仍按 #58 的身份与白名单环境执行；本单只改「跑什么命令」，不改 `REVIEW_CHECK_UID/GID/HOME`、`setpriv`、cwd 或 env 白名单。
- 审计表只追加；`repository_id` 与 `actor_owner_id` 都是 `restrict`，删除仓库/owner 不会静默抹掉审计（当前也没有删除入口）。
- DB CHECK 拒绝 `[]`、>8 条和非数组；即使有人手改 DB，也不能把「空数组」变成跳过检查。

## 6. 未验证 / 已知限制

- **生产未部署**：本单只做代码与隔离证据；生产 supervisor/dispatcher/worker 仍是 M6-C 的事，`moyu.service` 仍为 root，`owners=0`。
- **UI 未跑真实浏览器**：新对话框通过 TypeScript/ESLint/Prettier，但本 PR 没有跑浏览器 E2E；生产接入时需在 M6-C 的 HTTPS 端到端里点一次。
- **总预算只单测**：`runChecks` 的 900s 总预算用 300ms 用例验证；没有真实 15 分钟命令的取证。
- **审计不对外暴露**：目前只在 `repository_audit_events` 表里，没有 API/UI 列表；Issue 未要求查询接口。
- **命令条数上限 8**：这是契约与 DB CHECK 的共同上限；超过会 422，属有意限制。
- 引用 M5-B 相关结论一律「未通过」；本单不改变 M5-B 判定。

## 7. 迁移与回滚

- `0018_zippy_warhawk.sql` 为向前迁移：新增 JSONB 列、审计表、索与 CHECK；不修改已有业务行，不回填。
- 回滚脚本 `packages/db/migrations/rollback/0018_zippy_warhawk.down.sql`：校验 0018 ledger 恰好 1 条、无更晚迁移；删索引/表/约束/列并删除 ledger。真实 PG 已跑 up/down/re-up 与拒绝路径。
- 生产回滚优先「恢复迁移前已验证备份」；旧代码可忽略新增列，因此也可先回退代码再决定是否回滚迁移。生产迁移前必须按 M6-C 做 fresh dump 与恢复演练，本单不替代该演练。

## 8. 复现

```bash
# 单元/静态检查（任意环境，Node 24.22.2 + pnpm 11.7.0）
pnpm check

# 集成（隔离 PostgreSQL）
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres pnpm test:integration

# 红绿证据（需要一棵 pre-change 树；脚本会 build 两棵树）
M63_BASE_TREE=/root/src/m63-base \
M63_BRANCH_TREE=/root/src/repository-check-commands-63 \
M63_DB_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
bash scripts/m63/evidence.sh
```

## 9. 变更文件

- DB：`packages/db/src/schema/repositories.ts`、`repository-audit-events.ts`、`schema/index.ts`、`migrations/0018_zippy_warhawk.sql`、`migrations/rollback/0018_*.down.sql`、`meta/0018_snapshot.json`、`meta/_journal.json`。
- 契约/API：`packages/contracts/src/repositories.ts`、`apps/api/src/routes/repositories.ts`、`domain/repositories.ts`、`domain/review.ts`、`runtime/supervisor.ts`。
- supervisor：`config.ts`、`store.ts`、`review.ts`。
- Web：`lib/api.ts`、`Sidebar.tsx`、`WorkspaceShell.tsx`、`RepositorySettingsDialog.tsx/.module.css`。
- 测试/证据：`apps/supervisor/test/review.test.ts`、`apps/api/test/integration/repositories.integration.test.ts`、`packages/contracts/test/contracts.test.ts`、`packages/db/test/integration/rollback-0018.integration.test.ts` 及既有迁移回归调整、`scripts/m63/evidence.{sh,mjs}`、`docs/evidence/m63/ISS63-check-commands.txt`。
