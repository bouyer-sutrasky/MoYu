# M4-UX 证据

本目录是 Issue #23「M4-UX 基础体验修复」的真实浏览器与自动化证据。基线为
`origin/main` = `40e857a9081b281fb3a93ebaea6986e0101f005d`。

## 文件

| 文件 | 内容 |
| --- | --- |
| `m4ux-e2e.json` | `scripts/m4ux/e2e.mjs` 的最终结果（22 项全部通过、基线 SHA、时间） |
| `runtime-evidence.json` | 独立 profile 中固定 0021 制品的真实 Bridge 分支与平台偏好请求/响应摘要、制品 sha256 |
| `m4ux-before-*.png` | 基线 commit `40e857a` 的真实构建，经同一隔离 API、数据库、Playwright、视口与主题采集 |
| `m4ux-after-*.png` | 本分支构建，与 Before 同场景同视口同主题 |

配对：

| 场景 | Before | After |
| --- | --- | --- |
| 桌面浅色 · 250 条消息首屏与“加载更早消息” | `m4ux-before-desktop-light-history.png` | `m4ux-after-desktop-light-history.png` |
| 桌面浅色 · 新建任务的本次实际配置 | `m4ux-before-desktop-light-new-task.png` | `m4ux-after-desktop-light-new-task.png` |
| 桌面浅色 · 刷新后的草稿 | `m4ux-before-desktop-light-draft.png` | `m4ux-after-desktop-light-draft.png` |
| 桌面深色 · 新建任务 | `m4ux-before-desktop-dark-new-task.png` | `m4ux-after-desktop-dark-new-task.png` |
| 手机浅色（390×844）· 历史消息 | `m4ux-before-mobile-light-history.png` | `m4ux-after-mobile-light-history.png` |

Before 的桌面浅色草稿图是“输入文字并刷新后”的空输入框：基线不会保存草稿。After 的同一场景恢复
了文字。Before 的历史页没有“加载更早消息”；Before 的新建任务页没有“本次创建实际配置”与
“保存为默认”，也无法选择已保存的仓库偏好。

## 复现

```bash
# 依赖：Node 22/24、pnpm 11.7.0、隔离 PostgreSQL、Playwright Chromium
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  node scripts/m4ux/e2e.mjs
```

脚本会：

1. 在隔离 PostgreSQL 创建一次性数据库并迁移到最新版本；
2. 建立两个仓库（`m4ux-main`、`m4ux-other`）、250 条历史消息（大量相同时间戳）、120 条历史任务、
   一个已停止任务和一个 GitHub 汇入任务；
3. 用真实 dispatcher 将仓库 B 的消息从 stored 推进到 delivered/read，并通过真实 SSE 断言浏览器
   已加载行就地更新；用可控响应时序覆盖初次加载窗口内 SSE 与合并草稿迁移/切会话/并发发送；
3. 在 `/root/src/m4ux-before` 建立基线 commit 的 detached worktree 并构建 Web/API（已有时复用）；
4. 启动真实 API 进程，用真实 Chromium 采集 Before/After 截图与 DOM 断言；
5. 删除一次性数据库（`--keep` 可保留）。

真实 runtime 分支/偏好证据：

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres   node scripts/m4ux/runtime-evidence.mjs --reuse-runtime
# 或省略 --reuse-runtime：脚本会创建独立 DSH profile、安装固定制品并启动（端口可配）
```

## 边界

- 浏览器验收中的模型/分支目录由脚本内的回环 HTTP 替身提供，用于隔离地验证平台的分支/模型校验与
  失效展示；真实 runtime 的分支接口另由 `runtime-evidence.json` 记录，二者不互相替代。
- 独立 runtime 使用 `/root/.dsh-m4ux` profile 与 `/root/src/upstream/m4ux-final-verify` 固定制品，
  只跑分支/偏好路径，不接收真实执行任务，也不重启生产 3082 实例。
