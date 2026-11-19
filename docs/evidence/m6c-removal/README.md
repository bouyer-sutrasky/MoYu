# 仓库管理入口与移除确认：前后对照

同一套真实 Web shell、真实 API、真实 PostgreSQL 数据，两个本地进程分别从
`main` 和本 PR 分支启动。除 Web/API 代码版本外，场景完全相同。

| 项 | 值 |
| --- | --- |
| 基线 | `main` `e6470da1031946eba23aa40913227025dfee971a` |
| 变更后 | 本 PR 分支 `agent/repository-removal-0d75896816b6`（含 #89 的基线提交） |
| 仓库 | `Bouyer12/switch-evidence`（隔离测试库 `moyu_ui_evidence`） |
| 浏览器 | Chromium 1440×900，浅色主题 |
| 入口 | `http://127.0.0.1:5173/?repo=22222222-2222-4222-8222-222222222222` |

- `before-desktop-light.png`：`main` 侧栏只有「添加仓库」，没有仓库管理入口。
- `after-management-desktop-light.png`：同一侧栏显示「管理仓库」，弹窗列出已接入
  仓库、实例/仓库副本状态和「从 MoYu 移除」。
- `after-confirm-desktop-light.png`：确认页展示仓库全名、本地清理范围、GitHub
  远端不受影响，以及历史任务/会话 30 天只读保留与重新接入说明。

截图来自本地运行的真实应用（API 读取真实数据库行，Web 由 Vite 开发服务器
提供），不是静态页面或设计稿。本次未点击最终确认，因此没有删除取证仓库。
