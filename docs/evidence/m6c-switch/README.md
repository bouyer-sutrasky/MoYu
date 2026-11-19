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

## 返修：combined starting + preparing（2026-11-20）

初次提交的阶段优先级是「启动中 → 仓库准备中」，所以进程已经 `starting`、Git
副本还在准备时，界面会显示笼统的「启动中」，把真正的阻塞点藏起来。现在优先级
改为「故障/准备失败 → 仓库准备中 → 启动中 → 在线且副本就绪」，并新增 4 个
单元回归（starting+preparing、online+preparing、starting+ready+、准备失败）。

真实隔离栈（`docs/evidence/m6c-switch/runtime-timings.json`）用真实 API、
supervisor 和 dsh 实例、`MAX_ONLINE=2`、五个一次性仓库测量：

- 同一仓库 `m5a-epsilon-adf10ad9` 冷启动（含 Git 副本）`activationDurationMs`
  `12706`；副本已就绪后再次唤醒 `7190`，少 `5516 ms`。
- 在休眠时预先准备目标 `m5a-alpha-adf10ad9`，切换时不再出现 preparing 阶段，
  `activationDurationMs` `10771`。
- 修复后冷启动 `m5a-gamma-adf10ad9` 在 `state=starting`、Git 仍 preparing 的
  0.65–6.36 秒内持续显示 `phase=preparing`，随后才进入 `starting`，总耗时
  `9702 ms`。
- 两个在线实例的 panel 都显示各自 `source:github` 仓库和 `Bouyer12` 账号；
  对目标 `m5a-epsilon-adf10ad9` 新建执行任务，会话和 `task_links.repository_id`
  都落在目标仓库。

上面的 before/after 截图仍来自初次提交的真实应用对照（布局未变）；截图场景是
`starting` 与 `preparing` 分开显示的静态行，新的优先级由单元测试和上面的真实
阶段采样覆盖。

**第 2 项仍未完整交付**：本次没有把在线实例原地改派给另一仓库，仍沿用每仓库
独立实例和「预准备目标副本 → 切换工作台目标」的路径。后续拆分见
[bouyer-sutrasky/MoYu#91](https://github.com/bouyer-sutrasky/MoYu/issues/91)。
