# MoYu

**MoYu** —— 个人智能体工作台（内部概念名 Superagent Workspace）：ChatGPT 式布局，DeepSeek Harness 视觉变量；Work 接入 superagent，Chat 预留接口。

仓库当前处于 **M1「工程与存储」**：TypeScript monorepo、共享契约、Drizzle 初始 schema 与迁移、最小 Web/API/dispatcher 骨架、结构化日志和 CI。Passkey、消息闭环与多仓库调度尚未实现，页面不会把它们伪装为可用。

- [用户如何发任务](docs/ISSUE-PLAN.md)：新仓库权限、独立实例引导、可复制 Issue。
- [开发指南](docs/DEVELOPMENT-GUIDE.md)：环境依据、仓库结构、阶段与验收。
- [接口契约](docs/API-CONTRACTS.md)：浏览器 API、事件流、Bridge 及上游差异。
- [管理员引导步骤](docs/BOOTSTRAP-RUNBOOK.md)：现有 agent 不能跨仓库或管理服务时的并列入口。
- [产品决策](docs/DESIGN.md)：已经确认的范围和行为。
- [M1 验证记录](docs/M1-VERIFICATION.md)：实际命令、结果、未验证项与迁移回滚。
- [环境与接口调研](docs/research/)：现场快照与未验证项。
- [M0 上游锁文件](integrations/superagent/upstream.lock.json)：固定上游制品与兼容性基线。

## 仓库结构

```
apps/web/                   React + Vite + CSS Modules 最小页面
apps/api/                   Fastify：健康检查、结构化日志、错误封套
apps/dispatcher/            独立进程骨架：数据库连通性、等待 M3 投递循环
packages/contracts/         Zod 请求/响应/事件 schema
packages/db/                Drizzle schema、迁移、事务原语
integrations/superagent/    M0 固定的上游锁文件、补丁与契约测试
docs/                       指南、接口、决策与验收证据
.github/workflows/ci.yml    check 与真实 PostgreSQL 集成测试
```

`packages/theme`、`packages/runtime-client`、`deploy/` 属于后续阶段，M1 不预先建立空壳。

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **24.22.2** | 精确版本由 `package.json` 的 `engines`、`.node-version` 与 CI 锁定；`engine-strict=true`。 |
| pnpm | **11.7.0** | 由 `packageManager` 与 corepack 锁定，不使用宿主机全局 pnpm 作为项目约束。 |
| PostgreSQL | **16+** | 本地实测 16.15，CI 使用 `postgres:16`。仅 `test:integration` 与 `db:migrate` 需要。 |

Docker 不是 M1 的构建或测试依赖；真实数据库验证可以使用任意隔离 PostgreSQL 实例。

## 快速开始

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm check
```

`pnpm check` 不连接数据库，包含 lint、Prettier 检查、类型检查与单元测试。构建：

```bash
pnpm build
```

构建产物为 `apps/web/dist`、`apps/api/dist/server.js`、`apps/dispatcher/dist/main.js`。

本地运行 API、Web 与 dispatcher：

```bash
# 先准备一个空 PostgreSQL 数据库，并在 .env 写入 DATABASE_URL
pnpm db:migrate
pnpm dev:api        # http://127.0.0.1:3100/healthz、/readyz
pnpm dev:web        # http://127.0.0.1:5173，Vite 代理 /healthz 与 /readyz
pnpm dev:dispatcher # 连接数据库并输出结构化启动日志，等待 SIGINT/SIGTERM
```

API 使用 Fastify/pino 输出 JSON 日志，包含 `service`、`env`、`requestId`、耗时等字段；`authorization`、`cookie` 与 `set-cookie` 在序列化前脱敏。`/healthz` 不依赖数据库；`/readyz` 检查数据库，未配置或不可达时返回结构化 503。

## 配置

复制 `.env.example` 为 `.env`，按本机替换 `CHANGE_ME`。仓库不提交 `.env`、token、私钥、Cookie 或真实绑定码；日志同样不记录这些内容。

| 变量 | 使用者 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | API / dispatcher | `development`、`test`、`production` |
| `API_HOST` / `API_PORT` | API | 默认 `127.0.0.1:3100` |
| `LOG_LEVEL` | API / dispatcher | pino 日志级别，默认 `info` |
| `DATABASE_URL` | API / dispatcher / 迁移 | PostgreSQL 连接串；仅本地示例带占位密码 |
| `TEST_DATABASE_ADMIN_URL` | 集成测试 | 管理连接，用于创建/删除隔离测试库；API 与 dispatcher 不使用 |
| `VITE_API_BASE_URL` | Web 构建 | 留空时使用同源路径与开发/预览代理 |

## 命令

| 命令 | 是否连接数据库 | 说明 |
| --- | --- | --- |
| `pnpm check` | 否 | lint + 格式检查 + 类型检查 + 单元测试；不需要真实 PostgreSQL。 |
| `pnpm test:integration` | **是** | 在真实 PostgreSQL 上创建空库、跑迁移，验证消息+投递事务原子性与 `clientMessageId` 唯一约束。缺少 `TEST_DATABASE_ADMIN_URL` 时明确失败。 |
| `pnpm test:e2e` | — | **M1 未提供**，脚本以非零码明确报告“未运行”，不输出伪成功。浏览器流程随 M2 引入。 |
| `pnpm build` | 否 | 构建 Web、API 与 dispatcher。 |
| `pnpm db:generate` | 否 | 按 `packages/db/src/schema` 生成新迁移。 |
| `pnpm db:migrate` | 是 | 将已提交迁移应用到 `DATABASE_URL`。 |

集成测试示例，使用一个隔离的 PostgreSQL 管理连接：

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu:CHANGE_ME@127.0.0.1:5432/postgres \
  pnpm test:integration
```

测试会创建形如 `moyu_test_<pid>_<random>` 的空数据库、应用 `packages/db/migrations`，结束后删除该库。它不会使用 mock 或 SQLite 代替 PostgreSQL。

## 数据库 schema（M1）

| 表 | 用途 |
| --- | --- |
| `owners` | 单所有者身份。 |
| `passkey_credentials` | Passkey 凭据元数据（credential id、公钥、counter、transports、撤销时间）。 |
| `sessions` | 浏览器会话；只保存会话 token 的摘要。 |
| `auth_challenges` | 一次性 WebAuthn challenge、类型、过期与消费时间。 |
| `repositories` | 仓库、GitHub 数字 id、默认分支与实例状态。 |
| `conversations` | 会话及其固定的仓库、分支、模型与执行模式。 |
| `messages` | 会话消息；入站消息带稳定 `client_message_id`。 |
| `deliveries` | 消息的持久待投递记录，供后续 dispatcher 使用。 |
| `task_links` | 会话与上游 Ticket 的一对一映射及任务状态投影。 |
| `events` | 持久事件日志，`seq` 为 bigint（API 层按十进制字符串输出），含来源去重键。 |
| `runtime_leases` | 每仓库执行租约；含单调 fencing token 与活动租约唯一约束。 |
| `artifacts` | diff、检查结果、PR 引用、附件与日志等交付物。 |

关键约束：

- `messages` 上 `(conversation_id, client_message_id)` 的部分唯一索引（`client_message_id IS NOT NULL`），同一会话重复提交同一 `clientMessageId` 会得到 `23505`。
- `deliveries.message_id` 唯一；消息与投递记录必须在同一事务写入。存储原语为 `createInboundMessageWithDelivery`。
- `runtime_leases.fencing_token` 单调唯一；同一仓库最多一个 `active` 租约。
- `events.seq` 唯一；`(source, source_event_id)` 部分唯一索引用于来源去重。

HTTP 层对相同幂等键返回原结果或 409 的行为属于 M3 消息接口；M1 只交付数据库层唯一约束与事务原语。

## 迁移与回滚

初始迁移：`packages/db/migrations/0000_lush_master_chief.sql`（由 `pnpm db:generate` 生成，`meta/` 含快照与 journal）。

- 应用：`DATABASE_URL=... pnpm db:migrate`；drizzle 在 `drizzle.__drizzle_migrations` 记录已应用迁移。
- **不要修改已应用的迁移文件**；新增变更用 `pnpm db:generate` 生成后续迁移。
- 回滚：M1 迁移是前向迁移，没有自动 down 脚本。生产回滚必须恢复到迁移前已验证的数据库备份；开发/测试库可直接删除并重建（集成测试即每次从空库开始）。正式备份与恢复演练属于 M6 部署验收，M1 未声称完成。

## CI

`.github/workflows/ci.yml`：

1. `check`：锁定 pnpm 11.7.0 与 Node 24.22.2，`pnpm install --frozen-lockfile`，执行 `pnpm check` 与 `pnpm build`。
2. `integration`：启动 `postgres:16` service，执行 `pnpm test:integration`，真实创建/删除测试库。

工作流不使用 mock 作为数据库证据；如果私有仓库的 Actions 未启用或额度不足，PR 会如实标注 CI 未运行，而不是伪造通过。

## M1 未包含

- Passkey 注册/登录、会话撤销与初始化绑定码（M2）。
- `/api/v1` 消息、任务、事件与附件接口；HTTP 幂等响应（M3）。
- dispatcher 的实际投递循环、租约回收与执行准入（M3/M5）。
- 讨论只读边界、停止/继续、多仓库资源调度（M4/M5）。
- 完整主题 token、截图/附件、通知与清理体验（M2/M6）。
- `test:e2e` 与生产部署。

## 验证

本地与 CI 的实际命令、结果、环境、未验证项见 [docs/M1-VERIFICATION.md](docs/M1-VERIFICATION.md)。
