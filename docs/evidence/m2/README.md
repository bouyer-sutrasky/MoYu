# M2 Web 视觉与浏览器验收证据

本目录保存 M2「Passkey 与页面外壳」在真实 Chromium 中的截图。Before 与 After 使用相同视口、主题与浏览器；截图由 Playwright 直接生成，没有编辑页面内容或使用静态 mockup。

## 场景

| 项 | 值 |
| --- | --- |
| 浏览器 | Chromium（Playwright 1.56.1，headless） |
| 桌面视口 | 1440 × 900 |
| 手机视口 | 390 × 844 |
| 主题 | 浅色 / 深色各一组；M2 页面通过固定 Harness tokens 切换 |
| Before 基线 | `main` @ `886fd84`（M1 工程与存储） |
| After 变更版本 | 本 PR 分支 `agent/passkey-shell-m2-081454fa5bff` |
| After 地址 | `https://moyu.sutrasky.com`（nginx → `127.0.0.1:4300`） |
| After 认证 | Playwright + CDP 虚拟认证器；数据库为本次验收临时创建的隔离 PostgreSQL 库 |
| 采集时间 | 2026-11-03（UTC） |
| 环境事实 | [`docs/DEPLOYMENT.md`](../../DEPLOYMENT.md) |

## Before：M1 页面

M1 只交付最小工程与存储页面，没有登录、工作台三栏或手机抽屉。基线从 `main` 的干净 worktree 构建，API 只提供健康检查，Web 由 `vite preview` 在 `127.0.0.1:4173` 提供。截图中的“正常 · v0.1.0”来自真实 `/healthz`。

| 文件 | 场景 |
| --- | --- |
| `before-desktop-light.png` | 1440×900，浅色，M1 单页 |
| `before-desktop-dark.png` | 1440×900，深色，M1 单页 |
| `before-mobile-light.png` | 390×844，浅色，M1 单页 |
| `before-mobile-dark.png` | 390×844，深色，M1 单页 |

## After：M2 页面

After 使用本 PR 的 `pnpm build` 产物：API 同时提供 `/api/v1` 与 `apps/web/dist`，nginx 以 HTTPS 同源反代。截图前通过真实注册流程建立会话，并在隔离测试库中插入一条 `bouyer-sutrasky/MoYu` 仓库记录，仅用于展示仓库选择器与实例状态；它不代表 GitHub 权限校验或仓库接入已经完成。

| 文件 | 场景 |
| --- | --- |
| `after-desktop-light.png` | 1440×900，浅色，三栏展开（左栏 260px、中央会话、右侧详情 380px） |
| `after-desktop-dark.png` | 1440×900，深色，三栏展开 |
| `after-mobile-light.png` | 390×844，浅色，左侧导航抽屉打开 |
| `after-mobile-dark.png` | 390×844，深色，右侧详情抽屉打开 |

桌面截图默认展开右侧详情，以证明三栏布局；手机截图分别打开左侧导航与右侧详情抽屉。浅色/深色通过设置页的真实主题按钮切换。

## 浏览器验收（非截图项）

`scripts/e2e.mjs` 使用同名虚拟认证器完成首次绑定、Passkey 登录、刷新保持、challenge 重放拒绝、会话撤销、SSE 关闭、附件访问失效、凭据新增/撤销、退出与服务器恢复码重新绑定。验收只使用 CDP 虚拟认证器，不等同于真实硬件密钥验证；真机绑定由所有者在 PR 后完成。

结果文件：`e2e-result.json`（不含绑定码、Cookie、令牌或私钥）。

## 复现

After（需要已构建产物、隔离 PostgreSQL、nginx 指向 `127.0.0.1:4300`）：

```bash
pnpm install --frozen-lockfile
pnpm build
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres pnpm test:e2e
```

`test:e2e` 会创建并删除临时数据库、在 4300 启动构建产物、运行浏览器流程并写入截图与本目录的 `e2e-result.json`；不要与正在运行的部署实例同时执行。

Before（`main` @ `886fd84` 的干净 worktree）：

```bash
git worktree add --detach /tmp/moyu-m1-baseline 886fd84
cd /tmp/moyu-m1-baseline
pnpm install --frozen-lockfile
pnpm build
node apps/api/dist/server.js &                 # 127.0.0.1:3100，仅健康检查
pnpm --filter @moyu/web preview --port 4173 &  # 127.0.0.1:4173
# 用 Playwright 在 1440×900 / 390×844、浅色/深色下打开 http://127.0.0.1:4173/
```

Before 截图只在 `main` 基线 worktree 生成；After 截图由 `pnpm test:e2e` 生成。
