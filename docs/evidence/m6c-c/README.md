# M6-C C 段证据

基线：`2e785306f59767f07b91198f275591c050f9f34f`（#82 合并后的 `main`）。

After 浏览器截图与 `after-result.json` 采集于 `c9669e2`；最终 head `09cda53` 只增加了设置目标仓库的回退和「通知点击时关闭设置」两个非可视修正，不改变本文件记录的场景与截图。
实现与验收说明见 [`docs/M6-C-C-VERIFICATION.md`](../../M6-C-C-VERIFICATION.md)；
D 段调查见 [`docs/M6-C-D-NOTIFICATIONS.md`](../../M6-C-D-NOTIFICATIONS.md)。

## 环境

- 本机 Linux；Chromium 141（Playwright 1.56.1）。
- 独立测试库 `moyu_m6c_c_ui`（PostgreSQL 16，`127.0.0.1:55432`），不是生产库。
- 真实 API（`apps/api` 源码，`tsx`）监听 `3100`；Vite 开发服务器 After 在
  `5173`、Before 在 `5174`，均代理到同一个测试 API。
- 测试库里有 5 个 fixture 仓库、3 个会话和 fixture 凭据。路由与主题场景的
  `/bridge/v1/models`、`/branches`、`/capabilities` 与设置面板由本机 fixture
  HTTP 服务提供；产品代码没有 mock，浏览器走的是真实 API、真实数据库。
- 真实任务回执使用另一套隔离栈：隔离 Supervisor/DSH、API/Dispatcher、独立
  数据库 `moyu_m6c_c_real` 和一次性测试仓库；见下文与 `real-task/`。
- Before 是 `2e78530` 的独立 worktree，使用同一测试 API 和同一个浏览器脚本。

## 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @moyu/web test` | 通过，7 个路由解析/失败分类测试 |
| `pnpm check` | 通过（原始输出 `check.txt`） |
| `pnpm build` | 通过（原始输出 `build.txt`） |
| `TEST_DATABASE_ADMIN_URL=postgres://moyu:x@127.0.0.1:55432/postgres pnpm test:integration` | 通过；db 17 files/54 tests，api 18/133，dispatcher 19/100（1 skipped），supervisor 1/4（原始输出 `integration.txt`） |
| `integrations/superagent/build-patched.sh <pinned> /tmp/m6c-c-artifact` | 通过；`lib/index.js` sha256 `1fc0dbea8926deec4a724de700482f010d64fef032687e514782d523d6b54b66`（原始输出 `upstream-build.txt`） |
| 上游 `vitest run tests/prompts.spec.ts tests/prompt-config.spec.ts tests/panel-prompts.spec.tsx tests/m6c-preview.evidence.spec.ts` | 通过，4 files / 38 tests（原始输出 `upstream-prompt-tests.txt`） |
| `integrations/superagent/verify-lock.sh` | `baseline ok`（原始输出 `verify-lock.txt`） |

## 浏览器场景

结果文件：`browser/before-result.json`、`browser/after-result.json`。
截图在 `browser/`，同一场景使用同一视口、主题和测试数据。

| 场景 | Before | After | 截图 |
| --- | --- | --- | --- |
| beta 会话刷新恢复（1440×900 浅色） | 回退 alpha，`betaVisible=false` | beta 面包屑与 Beta 会话，URL 保留 | `before-restore-beta-conversation.png` / `after-restore-beta-conversation.png` |
| beta 设置→评估（1440×900 浅色） | 弹窗不打开 | 弹窗、beta 目标仓库、评估组 `aria-current=page` | `before-restore-beta-settings-eval.png` / `after-restore-beta-settings-eval.png` |
| 新任务三个选择器（1440×900 深色） | 背景 `rgb(255,255,255)` | 背景 `rgb(35,35,36)`、正文 `rgb(249,250,251)`、焦点边框 `rgb(122,170,255)` | `before-new-task-dark-desktop.png` / `after-new-task-dark-desktop.png` |
| 新任务选择器（390×844 深色） | 同一移动端布局 | 触发器与对话框使用主题 token | `before-new-task-dark-mobile*.png` / `after-new-task-dark-mobile*.png` |
| 新任务（1440×900 浅色） | 白底/深字 | 不变，正文可读 | `before-new-task-light-desktop.png` / `after-new-task-light-desktop.png` |
| 加载态 | — | 读取分支/模型时选择器仍为深色 | `after-new-task-loading-dark.png` |
| 空态 | — | 空分支/模型目录仍为深色 | `after-new-task-empty-dark.png` |
| 失败态 | — | 运行时不可达仍为深色，创建禁用 | `after-new-task-failure-dark.png` |
| 临时 503 深链接 | — | URL 保留，显示「地址已保留，可重试」和「重试」 | `after-route-retry-503.png` |

额外断言（`after-result.json`）：

- 深色三个选择器各 3 个：`base-branch`、`model`、`reasoning`。
- 取消后 `POST /api/v1/conversations` 数量为 0，回到当前仓库首页。
- 移动端 `ResponsiveSelect` 触发器 1 个；选择对话框正文 `rgb(249,250,251)`。
- 非法会话地址（404）回到 `?repo=<alpha>` 且显示「不存在或没有访问权限」。
- 临时故障：`browser/transient-route.json` 记录首次 503、刷新仍 503、恢复后点
  「重试」三个阶段；URL 全程保留，恢复后打开原 beta 会话。

## 临时故障与重试

`apps/web/src/shell/workspaceRoute.ts` 的 `isPermanentTargetFailure` 只在
403/404 时允许规范化地址；网络失败、超时与 5xx 一律保留 URL 并显示「重试」。
`browser/transient-route.json` 是真实浏览器的回归：第一次 conversation GET
返回 503、刷新仍返回 503 时 URL 与提示都保留；恢复后点「重试」打开原会话。
`pnpm --filter @moyu/web test` 同时锁定 403/404 为真、400/408/422/429/500/502/
503/504/0/null 为假。

## 提示词预览

`prompt-preview.json` 由锁定版源码的 `Prompts.preview(defaultPrompts())` 生成
（与 supervisor 的 prompts-preview 使用同一合成函数）。两种角色的 parts 都含
`runtime/language`；正文规则覆盖接单、提问、进度/失败、完成，并允许代码标识、
路径和必要术语保留英文。该 part 位于团队可编辑段之前，已有用户提示词、覆盖项和
版本历史不被改动。

## 真实任务回执

`docs/evidence/m6c-c/real-task/` 记录隔离 Supervisor/DSH + 隔离 API/Dispatcher +
独立 PostgreSQL + 一次性测试仓库上的真实任务。运行中实例的 HTTP prompts preview
含 `runtime/language`；任务完成并产生中文接单、4 条中文 `task.progress`、中文
完成 result/reply。任务产物、提交和文件 hash 在 `real-task/worktree.txt`。该任务
未触发提问或失败，已在 `real-task/README.md` 单列。

## 未验 / 限制

- 真实任务中的提问与失败/受阻未自然触发；需要另一条不同任务才能覆盖。
- 没有生产发布、生产数据库或生产服务验证；3082/bootstrap 实例未触碰。
- 没有真实手机通知证据（D 段）。
- 路由/主题场景的 fixture 运行时不可视为真实执行闭环证据；真实任务回执单独
  使用真实隔离执行栈。
