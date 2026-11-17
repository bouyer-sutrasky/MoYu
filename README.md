# MoYu

**MoYu** —— 个人智能体工作台（内部概念名 Superagent Workspace）：ChatGPT 式布局，DeepSeek Harness 视觉变量；Work 接入 superagent，Chat 预留接口。

MoYu 的公网候选环境已运行 M6-C 代码。正式交付边界、真机/生产未完成动作见
[M6-C 最终状态](docs/M6-C-FINAL-STATUS-2026-11-16.md)；当前真人验收发现的问题见
[Issue #79](https://github.com/bouyer-sutrasky/MoYu/issues/79)。

- [部署与验收事实](docs/DEPLOYMENT.md) · [发布与回滚手册](docs/M6-C-RUNBOOK.md)
- [开发指南](docs/DEVELOPMENT-GUIDE.md) · [接口契约](docs/API-CONTRACTS.md) · [产品决策](docs/DESIGN.md)
- [文档索引](docs/README.md)：按用途查找现行指南、历史设计和各阶段验收。

## 仓库结构

```
apps/web/                   React + Vite + CSS Modules 工作台外壳与 Passkey 页面
apps/api/                   Fastify：Passkey、会话、SSE、附件保护、健康检查
apps/dispatcher/            执行调度、消息投递、事件同步与租约协调
apps/supervisor/            仓库实例生命周期、资源准入与审阅检查
packages/contracts/         Zod 请求/响应/事件 schema
packages/db/                Drizzle schema、迁移、事务原语
packages/runtime-client/    MoYu 与运行时 Bridge 的客户端
packages/theme/             固定版本的 Harness 主题变量
integrations/superagent/    上游锁文件、补丁与契约测试
deploy/                     部署模板和服务配置
docs/                       指南、接口、决策与验收证据
.github/workflows/ci.yml    静态检查、构建与真实 PostgreSQL 集成测试
```

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | **24.22.2** | 精确版本由 `package.json` 的 `engines`、`.node-version` 与 CI 锁定；`engine-strict=true`。 |
| pnpm | **11.7.0** | 由 `packageManager` 与 corepack 锁定，不使用宿主机全局 pnpm 作为项目约束。 |
| PostgreSQL | **16+** | 本地实测 16.15，CI 使用 `postgres:16`。仅 `test:integration` 与 `db:migrate` 需要。 |

本地构建无需 Docker。数据库验证使用隔离 PostgreSQL 实例。

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

构建产物包括 Web、API、dispatcher 和 supervisor。公网入口由 nginx 转发至 API，
API 同源提供 Web 与 `/api/v1`。生产端口、服务名称、Passkey 引导和发布步骤详见
[部署说明](docs/DEPLOYMENT.md)和 [M6-C 运行手册](docs/M6-C-RUNBOOK.md)。

开发时也可以使用 Vite；注意本地 Vite 只用于查看布局，Passkey ceremony 必须在
`https://moyu.sutrasky.com` 完成，避免在 localhost 登记测试或正式凭据：

```bash
pnpm dev:api        # http://127.0.0.1:3100/healthz、/readyz
pnpm dev:web        # http://127.0.0.1:5173，Vite 代理 /api、/healthz 与 /readyz
pnpm dev:dispatcher # 启动本地调度器，等待 SIGINT/SIGTERM
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
| `pnpm test:integration` | **是** | 在真实 PostgreSQL 上创建空库、跑迁移，验证数据库迁移、API、dispatcher 和 supervisor 的集成行为。缺少 `TEST_DATABASE_ADMIN_URL` 时明确失败。 |
| `pnpm test:e2e` | **是**（通过 HTTPS 域名） | 用 Playwright + CDP 虚拟认证器在真实浏览器中验证首次绑定、登录、刷新保持、challenge 重放拒绝、会话撤销关闭 SSE、撤销后附件 401，并生成截图。需要已构建产物、nginx 反代与隔离数据库。 |
| `pnpm auth:bootstrap` | **是** | 服务器侧生成一次性绑定码；无 owner 时用于首次绑定，有 owner 且无可用凭据时用于恢复。明文码只打印到终端。 |
| `pnpm build` | 否 | 构建各工作区的产物。 |
| `pnpm db:generate` | 否 | 按 `packages/db/src/schema` 生成新迁移。 |
| `pnpm db:migrate` | 是 | 将已提交迁移应用到 `DATABASE_URL`。 |

集成测试示例，使用一个隔离的 PostgreSQL 管理连接：

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu:CHANGE_ME@127.0.0.1:5432/postgres \
  pnpm test:integration
```

测试会创建形如 `moyu_test_<pid>_<random>` 的空数据库、应用 `packages/db/migrations`，结束后删除该库。它不会使用 mock 或 SQLite 代替 PostgreSQL。

## 数据库迁移与回滚

Schema 位于 `packages/db/src/schema`，迁移位于 `packages/db/migrations`。
已有迁移保持原样，新增迁移通过 `pnpm db:generate` 生成。运行环境的备份、验证和回滚步骤见
[M6-C 运行手册](docs/M6-C-RUNBOOK.md)。

## CI

`.github/workflows/ci.yml`：

1. `check`：锁定 pnpm 11.7.0 与 Node 24.22.2，`pnpm install --frozen-lockfile`，执行 `pnpm check` 与 `pnpm build`。
2. `integration`：启动 `postgres:16` service，执行 `pnpm test:integration`，在真实 PostgreSQL 上执行集成测试。

浏览器端到端测试使用正式 HTTPS 域名，不在共享 CI runner 中伪造运行。

工作流不使用 mock 作为数据库证据；如果私有仓库的 Actions 未启用或额度不足，PR 会如实标注 CI 未运行，而不是伪造通过。

## 验证

各阶段的测试命令、环境、现场证据和未验证项见 [文档索引](docs/README.md)。
