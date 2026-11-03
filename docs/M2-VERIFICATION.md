# M2「Passkey 与页面外壳」验证记录

日期：2026-11-03。范围：`docs/DEVELOPMENT-GUIDE.md` 第 2 阶段与 Issue #6 的 M2 验收。只记录实际执行过的命令与结果；未执行项单独列出。

## 验证环境

| 项 | 值 |
| --- | --- |
| 宿主 | Ubuntu 24.04.2 LTS，x86_64 |
| Node.js | 24.22.2（`.node-version`、`package.json` 的 `engines`） |
| pnpm | 11.7.0（corepack，`packageManager`） |
| PostgreSQL | 16.15，隔离集群 `127.0.0.1:55432`，数据目录在仓库外，仅回环监听 |
| 浏览器 | Chromium（Playwright 1.56.1，headless）+ CDP 虚拟认证器 |
| 正式 origin | `https://moyu.sutrasky.com`（nginx 反代 `127.0.0.1:4300`） |
| RP ID | `moyu.sutrasky.com` |
| CI 数据库 | GitHub Actions `postgres:16` service |
| 环境事实 | 域名、端口、反代与验收规范以 [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) 为准 |

本地 PostgreSQL 仅用于验收；集成测试与浏览器验收各自创建临时库并在结束时删除，不注册为宿主常驻服务。

## 命令与结果

### 1. 安装、格式、lint、类型与单元测试

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

结果：

- `pnpm install --frozen-lockfile`：成功，lockfile 通过 pnpm 11 供应链策略校验。
- Prettier `--check`：通过（固定 Harness token CSS 作为上游快照排除在格式化之外）。
- ESLint：通过。
- TypeScript：6 个 workspace 包全部通过。
- 单元测试：3 个测试文件、30 个测试通过。
  - `packages/contracts`：13
  - `apps/api`：14
  - `apps/dispatcher`：3

### 2. 构建

```bash
pnpm build
```

结果：成功生成 `apps/web/dist`、`apps/api/dist/server.js`、`apps/dispatcher/dist/main.js`。API 构建产物包含认证、SSE 与附件路由；Web 构建产物由 API 在同源提供。

### 3. 数据库迁移

```bash
DATABASE_URL=postgres://moyu@127.0.0.1:55432/moyu_dev pnpm db:migrate
```

结果：`migrate.completed`。M1 初始迁移 + M2 增量迁移 `packages/db/migrations/0001_tiresome_sally_floyd.sql` 应用成功；空库迁移与重复应用由集成测试再次验证。

### 4. 集成测试（真实 PostgreSQL）

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  pnpm test:integration
```

结果：3 个测试文件、16 个测试通过。

- `packages/db`：2 个文件、9 个测试。验证 13 张表（新增 `bootstrap_codes`）、10 个枚举（新增 `bootstrap_code_purpose`）、迁移幂等、消息投递事务与约束。
- `apps/api`：1 个文件、7 个测试。验证：
  - 首次绑定状态与一次性绑定码；同一码第二次交换返回 401。
  - WebAuthn challenge 单次消费，重放返回 409。
  - 跨 origin 的状态变更请求返回 403。
  - 已认证附件读取；撤销会话后附件和 `/auth/me` 返回 401。
  - 最后一个可用 Passkey 不能被撤销；撤销其它凭据会同时撤销绑定会话。
  - 有可用凭据时首次登记入口关闭，CLI 拒绝生成绑定码。
  - 登录 challenge 在验证失败后仍被消费，重放返回 409。

### 5. 真实浏览器验收

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  pnpm test:e2e
```

结果：退出码 0。`scripts/e2e.mjs` 创建临时数据库、启动构建产物、通过 `https://moyu.sutrasky.com` 执行真实浏览器流程，并在结束时删除数据库与临时附件。检查项全部通过：

| 检查 | 结果 |
| --- | --- |
| 正式 HTTPS origin 可访问 | 通过 |
| 首次登记页可打开 | 通过 |
| 服务器绑定码完成首次 Passkey 绑定 | 通过 |
| 绑定后首次登记入口关闭 | 通过 |
| 会话 Cookie 为 Secure / HttpOnly / SameSite=Lax | 通过 |
| 刷新后保持登录 | 通过 |
| 已初始化后访问 `/setup` 返回“初始化已完成”状态 | 通过 |
| 第二次浏览器用 Passkey 登录 | 通过 |
| 重放同一 challenge/verify 请求返回 409 | 通过 |
| 设置页新增 Passkey | 通过 |
| 设置页撤销 Passkey | 通过 |
| 最后一个 Passkey 的撤销按钮禁用 | 通过 |
| 受保护 SSE 连接建立 | 通过 |
| 撤销前附件可读取 | 通过 |
| 设置页撤销另一浏览器会话 | 通过 |
| 撤销后既有 SSE 关闭 | 通过 |
| 撤销后附件返回 401 | 通过 |
| 撤销后旧会话回到登录页 | 通过 |
| 当前会话退出登录 | 通过 |
| 丢失全部 Passkey 后 CLI 生成恢复码 | 通过 |
| 用恢复码重新登记 Passkey 并恢复登录 | 通过 |

截图与结果：见 [`docs/evidence/m2/README.md`](evidence/m2/README.md) 与 `docs/evidence/m2/e2e-result.json`。

虚拟认证器边界：本次使用 Playwright + CDP 虚拟认证器，只是自动化证据，不是真实硬件密钥验证；真机 Passkey 由所有者在 PR 后用自己的设备完成并确认。

### 6. CI

PR 提交后由 GitHub Actions 运行：

- `check (lint, format, types, unit tests, build)`
- `integration (real PostgreSQL)`

浏览器验收使用正式域名与本机 nginx，不在共享 CI runner 中伪造运行；CI 结果见 PR 检查页。

## 验收对照

| Issue #6 要求 | 状态 | 证据 |
| --- | --- | --- |
| 单所有者 Passkey 登录，服务器生成短期一次性绑定码 | 完成 | `auth/bootstrap`、CLI、集成测试与浏览器验收 |
| 首次登记后关闭初始化入口 | 完成 | `/api/v1/auth/state`、`/setup` 关闭状态、浏览器验收 |
| 支持新增与撤销凭据 | 完成 | 设置页、`/auth/credentials`、浏览器验收 |
| 退出与撤销浏览器会话 | 完成 | 设置页、`/auth/logout`、`/auth/sessions/:id`、SSE 关闭与 401 验收 |
| 通过服务器恢复 | 完成 | CLI 恢复码、浏览器恢复登记、集成测试 |
| 登录长期保持，不定期重新验证 | 完成 | 90 天滚动会话、刷新保持验收；无定时重验 |
| 校验 challenge、origin、RP ID 与用户验证 | 完成 | SimpleWebAuthn 校验参数、origin 拒绝测试、重放测试 |
| 正式 Passkey 只在最终 HTTPS 域名登记 | 完成 | 配置固定 `moyu.sutrasky.com`；e2e 仅临时测试库、虚拟认证器 |
| 桌面三栏界面，右侧详情默认收起 | 完成 | `after-desktop-light/dark.png`；详情默认关闭，截图时展开 |
| 手机抽屉，优先查看与回复 | 完成 | `after-mobile-light/dark.png`；抽屉与底部输入区 |
| 沿用固定版本 Harness 视觉变量 | 完成 | `packages/theme`，记录 0.2.1-rc.2 / 上游 commit / MIT |
| 系统、浅色、深色主题 | 完成 | 设置页主题切换、四组截图 |
| Chat 显示尚未接入 | 完成 | Chat 标签页明确占位与禁用输入 |
| 尚未实现的 Work 操作展示明确状态 | 完成 | 任务/仓库/输入按钮禁用并标注 M3/M4/M6 |
| 真实浏览器验证首次绑定、登录、刷新保持、重放拒绝、会话撤销 | 完成 | `e2e-result.json` 21 项检查 |
| 撤销后 SSE 与附件访问失效 | 完成 | 浏览器验收与 API 集成测试 |
| 桌面/手机截图与后续阶段入口说明 | 完成 | `docs/evidence/m2/` |

## 未验证项与已知限制

- **真机 Passkey**：没有硬件密钥，未做真实设备登记；由所有者在 PR 后完成。
- **CI 浏览器验收**：共享 runner 没有正式域名、nginx 与本机证书，`test:e2e` 只在验收主机运行，未加入 CI。
- **SSE 业务事件**：M2 只验证连接、持久事件回放、心跳与撤销关闭；任务/消息事件生产属于 M3。
- **附件上传**：M2 只实现受保护下载；上传、MIME 校验与 UI 附件属于 M3/M6。
- **恢复码的物理隔离**：恢复依赖服务器 CLI 与数据库访问；没有“远程找回”入口，这是设计约束。恢复流程用虚拟认证器验证。
- **多实例部署**：登录限流是单进程内存实现；多实例共享限流、跨实例即时关闭 SSE 未实现（跨实例仍由心跳重新校验会话）。
- **部署监督**：没有新增/修改 nginx、systemd 或 Compose；正式服务管理、备份恢复演练属于 M6。M2 的构建产物已在 `127.0.0.1:4300` + 现有 nginx 下验证，但未提交部署单元。
- **OpenAPI 文档**：M2 以共享 Zod schema 为契约来源，未生成 OpenAPI 文档。
- **localhost 开发**：Passkey ceremony 要求 origin/RP ID 与正式域名一致；本地 Vite 仅用于查看页面，不用于登记凭据，避免污染正式 RP ID。

## 迁移与回滚

M2 新增迁移：`packages/db/migrations/0001_tiresome_sally_floyd.sql`。

- 新增枚举 `bootstrap_code_purpose`。
- 新增表 `bootstrap_codes`（只存绑定码/注册 token 摘要）。
- `auth_challenges` 增加服务端 `context`。
- `sessions` 增加 `expires_at`，默认 `now() + interval '90 days'`。

应用：

```bash
DATABASE_URL=... pnpm db:migrate
```

回滚：迁移是前向的，没有自动 down 脚本。开发/测试库可直接删除并重建；生产回滚必须恢复到迁移前已验证的数据库备份。既有会话行会获得默认 90 天有效期，不删除任何数据；绑定码与 challenge 为短期行，可安全清理。

## 交付证据

- 截图与 Before/After 说明：[`docs/evidence/m2/README.md`](evidence/m2/README.md)
- 浏览器验收结果：`docs/evidence/m2/e2e-result.json`
- 固定主题来源与许可证：[`packages/theme/README.md`](../packages/theme/README.md)
- 接口实现边界：[`docs/API-CONTRACTS.md`](API-CONTRACTS.md)
