# 在线切仓阶段展示：前后对照

同一套真实 Web shell、真实 API、真实 PostgreSQL 数据，两个本地进程分别从
`main` 和本 PR 分支启动。除 Web/API 代码版本外，场景完全相同。

| 项 | 值 |
| --- | --- |
| 基线 | `main` `e6470da1031946eba23aa40913227025dfee971a` |
| 变更后 | 本 PR 分支 `agent/online-switch-0d75896816b6` |
| 仓库 | `Bouyer12/switch-evidence`（隔离测试库 `moyu_ui_evidence`） |
| 实例状态 | `starting`，Git 副本 `preparing / receiving / 42%` |
| 请求时间 | 激活请求已发起，`last_online_at` 为空 |
| 浏览器 | Chromium 1440×900，浅色主题 |
| 入口 | `http://127.0.0.1:5173/?repo=22222222-2222-4222-8222-222222222222` |

- `before-desktop-light.png`：`main` 只显示「启动中」，没有阶段、已用时或重试入口。
- `after-desktop-light.png`：同一状态显示「切换中 · 启动中 / 已用时 …」，同时保留
  「仓库副本准备中 · 接收对象 42%」这一独立阶段。

截图来自本地运行的真实应用（API 读取真实数据库行，Web 由 Vite 开发服务器
提供），不是静态页面或设计稿。数据库只用于本次隔离取证，不含生产数据。
