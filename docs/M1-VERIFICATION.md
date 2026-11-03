# M1「工程与存储」验证记录

日期：2026-11-03。范围：`docs/DEVELOPMENT-GUIDE.md` 第 1 阶段与 Issue #3 的 M1 验收。只记录实际执行过的命令与结果；未执行项单独列出。

## 验证环境

| 项 | 值 |
| --- | --- |
| 宿主 | Ubuntu 24.04.2 LTS，x86_64 |
| Node.js | 24.22.2（`.node-version`、`package.json` 的 `engines`） |
| pnpm | 11.7.0（corepack，`package.json` 的 `packageManager`） |
| PostgreSQL | 16.15，独立集群 `127.0.0.1:55432`，数据目录在仓库外，仅回环监听 |
| CI 数据库 | GitHub Actions `postgres:16` service（见 CI 结果） |
| 浏览器 | 本地 Chromium（Playwright 驱动，见 `docs/evidence/m1/`） |

本地 PostgreSQL 是用于验收的隔离实例，不注册为宿主常驻服务，不监听公网；测试库由集成测试创建并在结束时删除。

## 命令与结果

### 1. 安装与静态检查

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

结果：

- `pnpm install` 成功，`pnpm-lock.yaml` 通过 pnpm 11 的供应链策略校验；`allowBuilds` 仅允许 esbuild 的平台二进制安装脚本。
- ESLint：通过。
- Prettier `--check`：通过。
- TypeScript：5 个 workspace 包（contracts、db、api、dispatcher、web）全部通过。
- 单元测试：3 个测试文件、17 个测试通过。
  - `packages/contracts`：9
  - `apps/api`：5
  - `apps/dispatcher`：3

### 2. 构建

```bash
pnpm build
```

结果：成功生成

- `apps/api/dist/server.js`（24.42 KB）
- `apps/dispatcher/dist/main.js`（18.25 KB）
- `apps/web/dist/`（`index.html`、CSS 与 JS bundle）
- 三个入口均含 source map。

### 3. 空库迁移

创建一个空的真实 PostgreSQL 数据库后：

```bash
DATABASE_URL=postgres://moyu@127.0.0.1:55432/moyu_dev \
  pnpm db:migrate
```

结果：

```json
{"level":"info","service":"moyu-db","event":"migrate.completed","message":"Database migrations applied successfully"}
```

同时由集成测试的 `createTestDatabase()` 在空库上应用同一迁移目录，证明迁移不依赖既有对象。

### 4. 集成测试（真实 PostgreSQL）

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  pnpm test:integration
```

结果：2 个测试文件、9 个测试通过（1.37s）。

覆盖的验收点：

1. **初始迁移**：创建 12 张表、9 个枚举；重复应用迁移不报错。
2. **约束**：`messages_conversation_client_message_uq`、`deliveries_message_uq`、`runtime_leases_active_repository_uq`、`runtime_leases_fencing_token_uq` 等索引存在；`client_message_id` 索引为部分唯一索引（`WHERE client_message_id IS NOT NULL`）。
3. **消息 + 待投递记录事务原子性**：
   - 成功路径同事务写入 1 条消息与 1 条 `pending` 投递记录。
   - 投递记录插入触发外键错误（`23503`）时，事务回滚，消息计数为 0。
4. **同一会话重复 `clientMessageId`**：第二次写入返回 SQLSTATE `23505`，约束名为 `messages_conversation_client_message_uq`，最终只有 1 条消息和 1 条投递记录。
5. **不同会话可使用相同 `clientMessageId`**：允许，证明唯一边界是会话级别。

### 5. API 运行时检查

以构建产物启动，`DATABASE_URL` 指向已迁移数据库：

```bash
DATABASE_URL=postgres://moyu@127.0.0.1:55432/moyu_dev \
  node apps/api/dist/server.js
```

结果：

- `GET /healthz` → `200`，`{"data":{"status":"ok","service":"moyu-api","version":"0.1.0","uptimeSeconds":2,"timestamp":"..."},"requestId":"..."}`，并返回 `x-request-id`。
- `GET /readyz` → `200`，`{"data":{"status":"ok","database":"ok"},"requestId":"..."}`。
- 未知路由 → `404`，共享错误封套 `{"error":{"code":"not_found","message":"Route not found","retryable":false},"requestId":"..."}`。
- 日志为 JSON lines，包含 `service`、`env`、`requestId`、请求/响应与耗时；`authorization`、`cookie`、`set-cookie` 配置为脱敏。
- `SIGTERM` 后输出 `server.shutdown` 并正常退出。

### 6. dispatcher 运行时检查

```bash
DATABASE_URL=postgres://moyu@127.0.0.1:55432/moyu_dev \
  node apps/dispatcher/dist/main.js
```

结果：输出 `dispatcher.ready`（含 `deliveryLoop: "not-implemented-until-m3"`），收到 `SIGTERM` 后输出 `dispatcher.stopped` 并退出。M1 不伪造投递行为。

### 7. 干净 checkout

从 GitHub 重新 clone 本 PR 分支（不是本地工作区），验证提交内容自包含：

```bash
git clone --depth 1 --branch agent/engineering-storage-m1-d43804e68d37 \
  ssh://git@ssh.github.com:443/sutrasky/MoYu.git /tmp/moyu-clean
cd /tmp/moyu-clean
pnpm install --frozen-lockfile
pnpm check
pnpm build
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres pnpm test:integration
```

结果：

- HEAD：`7a35fd4d32dfe736bd7890c5156b108ce75bcaec`；tracked files：102。
- Node 24.22.2 / pnpm 11.7.0；`pnpm install --frozen-lockfile` 成功（复用 store 后 1.5s）。
- `pnpm check`：退出码 0（lint、格式、5 包类型检查、17 个单元测试通过）。
- `pnpm build`：退出码 0（Web/API/dispatcher 全部产物）。
- `pnpm test:integration`：退出码 0（2 个文件、9 个测试通过）。
- 在干净目录创建空库 `moyu_clean` 后执行 `pnpm db:migrate` 成功；从干净目录启动构建产物，`GET /healthz` 与 `GET /readyz` 均返回 200。

### 8. 缺少依赖时的明确失败

- 未设置 `DATABASE_URL` 执行 `pnpm db:migrate`：输出 `migrate.config_error`，退出码 1。
- 未设置 `TEST_DATABASE_ADMIN_URL` 执行 `pnpm test:integration`：2 个测试文件因缺少管理连接失败，9 个测试跳过，退出码 1；未输出成功。
- `pnpm test:e2e`：明确报告 M1 未提供浏览器端到端测试，退出码 1。

## 验收对照

| Issue 要求 | 状态 | 证据 |
| --- | --- | --- |
| TypeScript monorepo，拆分 Web、API、dispatcher、契约、数据库 | 完成 | `apps/`、`packages/` |
| 锁定 Node 与 pnpm 并提交 lockfile | 完成 | `.node-version`、`packageManager`、`engines`、`pnpm-lock.yaml` |
| 最小 Web 页面 | 完成 | `apps/web`，构建成功；见 `docs/evidence/m1/` |
| API 健康检查与结构化日志 | 完成 | `/healthz`、`/readyz`、JSON 日志 |
| CI | 完成（待工作流运行结果） | `.github/workflows/ci.yml` |
| Drizzle schema 覆盖所有者、凭据、会话、challenge、仓库、消息、任务、投递、事件、租约、交付物 | 完成 | 12 张表 + 9 个枚举 |
| 空库迁移 | 完成 | 手工迁移 + 集成测试 |
| 消息与投递记录事务原子性 | 完成 | 集成测试（成功与回滚） |
| 同会话重复 `clientMessageId` 的数据库唯一约束 | 完成 | 集成测试（23505 + 约束名） |
| HTTP 幂等响应留待 M3 | 按范围未实现 | 仅数据库原语，README 已注明 |
| README、脱敏配置示例、check 与 test:integration 区分 | 完成 | `README.md`、`.env.example`、根 scripts |
| PR 附干净 checkout 构建步骤、实际命令与结果 | 完成 | 见 PR 描述与本文第 7 节（GitHub 全新 clone，check/build/integration 均退出码 0） |
| Web Before/After 视觉证据 | 完成（基线无旧界面，见说明） | `docs/evidence/m1/`：同 URL、1440×900、浅色；Before 记录基线无应用的连接拒绝，After 为构建产物实际页面 |

## 未验证项与限制

- **HTTP 幂等响应**：Issue 明确随 M3 消息接口实现；M1 只证明数据库唯一约束与事务原语。
- **浏览器端到端测试**：`test:e2e` 在 M1 不可用并明确失败；Passkey 流程在 M2 引入。
- **CI 实际运行结果**：工作流已提交；PR 事件上的 GitHub Actions 运行结果需以 PR 页面为准。若私有仓库 Actions 未启用或额度不足，本项将保持“未执行”而不是标记通过。
- **生产迁移回滚**：只验证了前向迁移；没有自动 down 迁移，生产回滚依赖迁移前备份。备份与恢复演练属于 M6。
- **部署、容器、Nginx、两实例资源控制**：不在 M1 范围。
- **Web 视觉基线**：默认分支此前没有 Web 应用，无法截取“修改前页面”；替代证据与限制见 `docs/evidence/m1/README.md`。

## 迁移回滚方法

1. 迁移文件：`packages/db/migrations/0000_lush_master_chief.sql`，由 `pnpm db:generate` 生成，`meta/` 包含 journal 与 snapshot。
2. 已应用迁移不得原地修改；变更通过新迁移完成。
3. 开发/测试库：删除测试库即可回到空库（集成测试每次如此）。
4. 生产库：恢复到执行迁移前的已验证备份，再部署对应旧版本。M1 没有执行生产恢复演练，不能据此宣称生产回滚已完成。
