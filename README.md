# MoYu

**MoYu** —— 个人智能体工作台（内部概念名 Superagent Workspace）：ChatGPT 式布局，DeepSeek Harness 视觉变量；Work 接入 superagent，Chat 预留接口。

仓库当前处于 **M6-B「通知与历史清理」**：在 M1–M6-A 的 monorepo、Passkey、消息闭环、执行控制、多仓库调度与附件/审阅面板之上，实现由持久 SSE 事件驱动的浏览器通知、历史搜索与按 7 天规则清理 worktree。HTTPS 端到端部署、备份恢复与回滚手册属于 M6-C；页面不会把未实现能力伪装为可用。

- [用户如何发任务](docs/ISSUE-PLAN.md)：新仓库权限、独立实例引导、可复制 Issue。
- [开发指南](docs/DEVELOPMENT-GUIDE.md)：环境依据、仓库结构、阶段与验收。
- [接口契约](docs/API-CONTRACTS.md)：浏览器 API、事件流、Bridge 及上游差异。
- [管理员引导步骤](docs/BOOTSTRAP-RUNBOOK.md)：现有 agent 不能跨仓库或管理服务时的并列入口。
- [产品决策](docs/DESIGN.md)：已经确认的范围和行为。
- [部署与验收事实](docs/DEPLOYMENT.md)：现行域名、端口、反代、分支保护与截图规范。
- [M6-B 验证记录](docs/M6-B-VERIFICATION.md)：通知去重、历史搜索、7 天清理的红→绿证据与未验证项。
- [M6-B 证据索引](docs/evidence/m6b/README.md)：原始命令/输出/exit code 与 Before/After 截图。
- [M6-A 验证记录](docs/M6-A-VERIFICATION.md)：附件、diff/测试/PR 面板。
- [M4-UX 验证记录](docs/M4-UX-VERIFICATION.md)：历史分页、草稿/发送一致性、仓库偏好与浏览器证据。
- [M2 验证记录](docs/M2-VERIFICATION.md)：Passkey、会话撤销、SSE/附件保护与浏览器验收的实际命令和结果。
- [M2 视觉证据](docs/evidence/m2/README.md)：桌面/手机、浅色/深色的 Before/After 截图与复现命令。
- [M1 验证记录](docs/M1-VERIFICATION.md)：M1 的实际命令、结果、未验证项与迁移回滚。
- [环境与接口调研](docs/research/)：现场快照与未验证项。
- [M0 上游锁文件](integrations/superagent/upstream.lock.json)：固定上游制品与兼容性基线。

## 仓库结构

```
apps/web/                   React + Vite + CSS Modules 工作台外壳与 Passkey 页面
apps/api/                   Fastify：Passkey、会话、SSE、附件保护、健康检查
apps/dispatcher/            独立进程骨架：数据库连通性、等待 M3 投递循环
packages/contracts/         Zod 请求/响应/事件 schema
packages/db/                Drizzle schema、迁移、事务原语
packages/theme/             固定版本 Harness design tokens 与来源/许可证记录
integrations/superagent/    M0 固定的上游锁文件、补丁与契约测试
docs/                       指南、接口、决策与验收证据
.github/workflows/ci.yml    check 与真实 PostgreSQL 集成测试
```

`packages/runtime-client`、`deploy/` 属于后续阶段，M2 不预先建立空壳。

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

部署形态由 API 同时提供 Web 构建产物与 `/api/v1`（同源 Cookie）。最终 HTTPS 域名是
`https://moyu.sutrasky.com`，nginx 反代到 `127.0.0.1:4300`：

```bash
# 先准备 PostgreSQL，并在 .env 写入 DATABASE_URL、WEBAUTHN_* 等配置
pnpm db:migrate
pnpm build
WEB_DIST_DIR=apps/web/dist API_PORT=4300 NODE_ENV=production node apps/api/dist/server.js

# 首次绑定或全部 Passkey 丢失后的恢复：在服务器上生成短期一次性绑定码
pnpm auth:bootstrap
```

开发时也可以使用 Vite；注意本地 Vite 只用于查看布局，Passkey ceremony 必须在
`https://moyu.sutrasky.com` 完成，避免在 localhost 登记测试或正式凭据：

```bash
pnpm dev:api        # http://127.0.0.1:3100/healthz、/readyz
pnpm dev:web        # http://127.0.0.1:5173，Vite 代理 /api、/healthz 与 /readyz
pnpm dev:dispatcher # 连接数据库并输出结构化启动日志，等待 SIGINT/SIGTERM
```

WebAuthn 的 RP ID 与 origin 必须和用户实际打开的页面一致。正式凭据只在最终 HTTPS 域名
`moyu.sutrasky.com` 登记；不要用 localhost、裸 IP 或其它域名登记正式或测试凭据。

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
| `WEBAUTHN_RP_ID` | API | Passkey RP ID，正式值 `moyu.sutrasky.com`。 |
| `WEBAUTHN_RP_NAME` | API | Passkey 展示名，默认 `MoYu`。 |
| `WEBAUTHN_ORIGIN` | API | 允许的 WebAuthn origin，正式值 `https://moyu.sutrasky.com`。 |
| `AUTH_SESSION_TTL_DAYS` | API | 服务端会话滚动有效期，默认 90 天；无固定重验周期。 |
| `AUTH_BOOTSTRAP_TTL_MINUTES` | API / CLI | 一次性绑定码有效期，默认 10 分钟。 |
| `AUTH_CHALLENGE_TTL_SECONDS` | API | WebAuthn challenge 有效期，默认 300 秒。 |
| `AUTH_COOKIE_SECURE` | API | 可选覆盖；默认按 origin 是否为 https 推断。 |
| `ARTIFACT_STORAGE_DIR` | API | 受保护附件下载根目录；部署时放在仓库外。 |
| `WEB_DIST_DIR` | API | 由 API 提供的 Web 构建目录，默认 `apps/web/dist`。 |
| `VITE_API_BASE_URL` | Web 构建 | 留空时使用同源路径与开发/预览代理 |

## 命令

| 命令 | 是否连接数据库 | 说明 |
| --- | --- | --- |
| `pnpm check` | 否 | lint + 格式检查 + 类型检查 + 单元测试；不需要真实 PostgreSQL。 |
| `pnpm test:integration` | **是** | 在真实 PostgreSQL 上创建空库、跑迁移，验证 M1 存储约束与 M2 Passkey 绑定码、challenge 单次消费、会话撤销、附件保护。缺少 `TEST_DATABASE_ADMIN_URL` 时明确失败。 |
| `pnpm test:e2e` | **是**（通过 HTTPS 域名） | 用 Playwright + CDP 虚拟认证器在真实浏览器中验证首次绑定、登录、刷新保持、challenge 重放拒绝、会话撤销关闭 SSE、撤销后附件 401，并生成截图。需要已构建产物、nginx 反代与隔离数据库。 |
| `pnpm auth:bootstrap` | **是** | 服务器侧生成一次性绑定码；无 owner 时用于首次绑定，有 owner 且无可用凭据时用于恢复。明文码只打印到终端。 |
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
| `sessions` | 浏览器会话；只保存会话 token 的摘要，`expires_at` 随活动滚动延长。 |
| `auth_challenges` | 一次性 WebAuthn challenge、类型、过期、消费时间与服务端 ceremony 绑定上下文。 |
| `bootstrap_codes` | 服务器 CLI 生成的一次性绑定码（只存摘要）、注册 token 摘要与完成时间。 |
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
- `bootstrap_codes.code_hash` 唯一；绑定码与注册 token 都只保存 SHA-256 摘要。
- 最后一个可用 Passkey 不能通过 API 撤销；撤销其它凭据会同时撤销与其绑定的浏览器会话。

HTTP 层对相同幂等键返回原结果或 409 的行为属于 M3 消息接口；M1 只交付数据库层唯一约束与事务原语。
M2 的认证接口、SSE 与附件保护已实现；仓库添加、任务与消息接口仍属于后续阶段。

## 迁移与回滚

初始迁移：`packages/db/migrations/0000_lush_master_chief.sql`（由 `pnpm db:generate` 生成，`meta/` 含快照与 journal）。

- 应用：`DATABASE_URL=... pnpm db:migrate`；drizzle 在 `drizzle.__drizzle_migrations` 记录已应用迁移。
- **不要修改已应用的迁移文件**；新增变更用 `pnpm db:generate` 生成后续迁移。
- 回滚：M1 迁移是前向迁移，没有自动 down 脚本。生产回滚必须恢复到迁移前已验证的数据库备份；开发/测试库可直接删除并重建（集成测试即每次从空库开始）。正式备份与恢复演练属于 M6 部署验收，M1 未声称完成。

## CI

`.github/workflows/ci.yml`：

1. `check`：锁定 pnpm 11.7.0 与 Node 24.22.2，`pnpm install --frozen-lockfile`，执行 `pnpm check` 与 `pnpm build`。
2. `integration`：启动 `postgres:16` service，执行 `pnpm test:integration`，在真实 PostgreSQL 上运行 DB 与 API 认证集成测试。

浏览器端到端测试使用正式 HTTPS 域名，不在共享 CI runner 中伪造运行。

工作流不使用 mock 作为数据库证据；如果私有仓库的 Actions 未启用或额度不足，PR 会如实标注 CI 未运行，而不是伪造通过。

## M2 已包含

- 单所有者 Passkey 首次绑定、登录、长期会话、退出与浏览器会话撤销。
- 服务器 CLI 生成短期一次性绑定码；首次登记后关闭初始化入口，全部凭据丢失时用于恢复。
- 新增/撤销 Passkey；禁止撤销最后一个可用凭据；撤销凭据时同时撤销绑定会话。
- challenge、origin、RP ID 与用户验证校验；challenge 单次消费，重放返回 409。
- 受保护 SSE 与附件下载；撤销会话立即关闭既有 SSE，后续访问返回 401。
- 桌面三栏（260px 左栏 / 居中会话 / 默认收起 380px 详情）、手机抽屉、系统/浅色/深色主题。
- 固定版本 Harness design tokens（`packages/theme`，MIT，记录来源 commit 与摘要）。

## M2 未包含

- `/api/v1` 消息、任务、仓库添加、事件生产与附件上传（M3 起）；当前 SSE 只承载持久事件回放与心跳。
- dispatcher 的实际投递循环、租约回收与执行准入（M3/M5）。
- 讨论只读边界、停止/继续、多仓库资源调度（M4/M5）。
- 系统通知、Web Push、清理设置与完整交付面板（M6）。
- 正式 systemd/Compose 部署与真机 Passkey 登记；真机由所有者在 PR 后完成。

## 验证

本地与 CI 的实际命令、结果、环境、未验证项见各阶段验证记录：M6-B 在 [docs/M6-B-VERIFICATION.md](docs/M6-B-VERIFICATION.md)，M6-A 在 [docs/M6-A-VERIFICATION.md](docs/M6-A-VERIFICATION.md)，M5-B 在 [docs/M5-B-VERIFICATION.md](docs/M5-B-VERIFICATION.md)，M4 在 [docs/M4-VERIFICATION.md](docs/M4-VERIFICATION.md) 与 [docs/M4-UX-VERIFICATION.md](docs/M4-UX-VERIFICATION.md)，M3 在 [docs/M3-VERIFICATION.md](docs/M3-VERIFICATION.md)，M2 在 [docs/M2-VERIFICATION.md](docs/M2-VERIFICATION.md)，M1 在 [docs/M1-VERIFICATION.md](docs/M1-VERIFICATION.md)。
