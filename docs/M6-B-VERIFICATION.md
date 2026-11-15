# M6-B 验证记录：通知与历史清理

本文件记录 M6-B「通知与历史清理」的实现范围、验收证据、未验证项与迁移回滚。原始命令、
输出、exit code 与截图索引在 [`evidence/m6b/`](evidence/m6b/)；证据日志首部记录了产出时的
`git rev-parse HEAD`，基线固定为 `main@68c01e50d69a075183a0a175c57611fa77e1163a`（M6-A
合并提交）。

## 1. 范围

- **B1 页面打开时的系统通知**：由持久 SSE 事件驱动 Web Notification，配套活动中心未读记录；
  权限提示、拒绝不阻塞、重复请求不骚扰；同一事件在重连、刷新、多标签页下只提醒一次；点击定位会话。
- **B2 历史搜索**：按仓库、任务状态、文本关键词检索历史任务/会话；稳定游标分页；空结果、超长
  关键词、特殊字符不报错；只返回当前所有者数据。
- **B3 清理设置**：仅清理「已合并且无未保存修改」的 worktree，默认保留 7 天；执行前干跑预览
  路径、原因、大小并显式确认；幂等、可恢复、有审计；`realpath` 边界校验，不越界。
- **B4 端到端证据**：真实 PostgreSQL、真实 API、真实 Chromium；每项红→绿原始输出与截图。

M6-A 已交付的附件、diff/测试/PR 面板未在本单重做。HTTPS 端到端部署、备份恢复与整机回滚手册
属于 M6-C，不在本单。

## 2. B1 通知

### 实现

- 浏览器通知只消费 `GET /api/v1/events` 的 `workspaceEvent`，不轮询、不伪造事件；通知正文来自
  固定类别摘要，不展示凭据或完整附件。
- 类别映射：`task.question` / `waiting_input` → 需要回复；`awaiting_review` → 待审阅；
  `completed` → 已完成；`failed` / `blocked` / `closed_unmerged` → 失败/受阻。`task.progress`
  与普通消息不弹系统通知。
- 去重键是持久事件 `id`（SSE 的稳定事件 id）。浏览器把 id 写入 `localStorage`（7 天 / 1000 条
  上限），跨标签页用 Web Locks 串行化「检查并占用」；`tag: moyu:<eventId>` 作为操作系统层第二道
  去重。刷新后重放的近期事件仍会经过同一 claim，因此不会再次弹窗。
- 权限只在设置页由所有者显式点击申请；`default` 时提供「允许通知」，`denied` 时给出站点设置
  提示且不重复请求；`unsupported` 时说明不可用。权限拒绝只影响系统弹窗，活动中心与主流程照常。
- 活动中心调用 `GET /api/v1/activity` 读取持久提醒（含分类计数、已读状态与运行中任务），
  点击任意一条切换到对应仓库并选中会话；`onclick` 同样定位会话。
- 未读状态保存在本机（按所有者分键），不新增服务端已读表；活动记录本身来自持久事件，网页关闭
  后重新打开仍可补看。第一版不实现 Service Worker / Web Push。

### 证据

- `evidence/m6b/B1-red.txt`：基线 `main@68c01e5` 的 `/api/v1/activity` 为 404，活动中心仍是
  「活动中心与通知在 M6 接入」占位，设置页没有通知权限区。
- `evidence/m6b/B1-green.txt`：两个共享同一浏览器上下文的真实 Chromium 标签页分别通过 SSE 收到
  同一事件（记录每页 `sseReceived`），系统通知合计只出现一次；记录通知 `tag` 与事件 id 去重键。
  刷新第一个标签页后 SSE 重放相同事件，通知列表保持 0；点击通知后 `aria-current` 会话与预期
  conversation id 一致；`task.progress` 不产生通知。
- 同一文件记录 `Notification.permission='denied'` 时页面显示可操作提示、自动权限请求为 0、
  主流程可用；`permission='default'` 时页面加载请求为 0，显式点击「允许通知」后请求恰好 1 次。
- 截图：`before-activity-*` / `after-activity-*` 对比同一视口与主题下的旧占位与新活动中心。

### 未验证 / 限制

- 操作系统实际弹窗外观与勿扰模式由浏览器/OS 决定；自动化证据通过替换 Web Notification
  构造器记录真实调用参数、权限状态与去重结果，不声称验证了特定桌面的通知横幅样式。
- 网页关闭后的送达不实现（产品决策）；重新打开后依靠持久活动记录补看。
- 未读标记是本机状态，不跨设备同步；切换浏览器会重新显示未读。

## 3. B2 历史搜索

### 实现

- `GET /api/v1/history/search` 先以 `conversations.owner_id` 限定所有者，再按 `repositoryId`、
  任务状态（含 `none`）与文本关键词过滤；仓库过滤还校验仓库属于同一所有者。
- 关键词最长 2000，参与检索的前 200 字；`%`、`_`、`\` 按字面转义后使用 `ILIKE`。空关键词返回
  最近任务而不报错；超长关键词截断后正常返回；特殊字符不会变成通配符。
- 标题与消息正文都可命中；结果带 `matched`（`title`/`message`/`recent`）与截断到 240 字的
  `snippet`。排序 `(updated_at,id)` 倒序，游标复用现有 conversation keyset 编码，scope 包含
  所有者、仓库、状态与关键词哈希，跨查询复用返回 422，同一游标不重不漏。
- 网页「历史搜索」弹窗支持关键词、仓库、状态筛选与加载更多；点击结果定位会话。

### 证据

- `evidence/m6b/B2-red.txt`：基线 `/api/v1/history/search` 为 404。
- `evidence/m6b/B2-green.txt`：真实 API 上 `q=星河&limit=1` 第一页与游标第二页无重复；
  跨所有者关键词返回空；`100%_safe` 命中特殊字符；1500 字关键词返回 200 与空结果；空关键词
  返回最近任务；把关键词 A 的游标用于关键词 B 返回 422。
- 截图：`after-history-desktop-light.png`。

### 未验证 / 限制

- 搜索是 `ILIKE` 子串匹配，不做分词、相关度排序或模糊纠错；中文无需分词即可子串命中。
- 关键词超过 200 字的部分不参与检索，界面提示上限。

## 4. B3 清理

### 实现与安全不变量

| 规则 | 实现 |
| --- | --- |
| 只清理已合并 | 任务 `state=completed`，且执行时用真实 `gh` 读取 PR 状态必须为 `merged`；open / closed / 读取失败一律跳过 |
| 7 天保留期（年龄锚点） | 从持久完成事件 `task.state_changed` 且 `payload.task.state='completed'` 的 `occurred_at` 起算；**不是 PR `mergedAt`，也不是文件 mtime**。无该事件时回退 `task_links.updated_at`。小于保留期不进入候选；预览与执行都重新核对。预览 reason 与界面文案使用同一口径（「已完成 N 天」/「保留 7 天（自任务完成）」） |
| 无未保存修改 | supervisor 在真实 worktree 运行 `git status --porcelain=v1 -z`，有未提交/未跟踪改动即拒绝 |
| 未推送也跳过 | 读取 upstream 的 ahead 数；无 upstream 时用 `git branch -r --contains HEAD` 证明已推送，不能证明则拒绝 |
| 被工作占用跳过 | supervisor 扫描 `/proc/*/cwd`，有进程工作目录在目标内即拒绝；`git index.lock` 存在也拒绝 |
| 不越界 | `realpath` 解析 `WORKTREE_ROOT`、profile 目录、ticket 目录与隔离区，逐段用 `isStrictlyInside` 校验；必须是 git 顶层；拒绝 symlink 越界 |
| 只删工作区 | 仅接受 supervisor 自己解析出的 ticket 目录；API 与浏览器都不传路径；不删会话、报告、PR、附件或远端分支 |
| 干跑与显式确认 | 预览生成审计 `runId` 与逐项路径/原因/大小；执行只接受 15 分钟内的同一所有者预览 `runId` |
| 幂等 | 同一预览第二次执行返回原结果（`duplicate:true`）；并发执行由唯一索引选出一个执行者，另一个返回同一结果 |
| 可恢复 | 先把目录原子重命名到 `.cleanup-trash/<profile>-<ticket>-<uuid>`，再递归删除；删除失败只留下隔离目录，下次执行先清理隔离区，原 worktree 路径已一次性消失，不会半删 |
| 日志可追 | `cleanup_runs` / `cleanup_items` 持久记录预览与执行、每个候选的路径/原因/大小/状态与错误；`GET /api/v1/cleanup/runs` 返回 |

平台流程：`POST /api/v1/cleanup/preview` → 前端展示清单 → 用户点「删除预览中的 N 个目录…」
→ 二次确认面板 → `POST /api/v1/cleanup/execute {runId}`。执行时重新读取 PR 状态与 supervisor
真实目录，任何一项不再满足即转为 `skipped`，不会沿用预览结论。

### 证据

- `evidence/m6b/B3-red.txt`：基线 `/api/v1/cleanup/*` 为 404。
- `evidence/m6b/B3-green.txt`：真实 supervisor + 真实 worktree 的预览清单包含路径、原因、大小；
  干净的已合并目录 `eligible=true`，有未提交改动、被存活进程占用、PR 未合并、symlink 越界四类
  均为 `skipped` 并给出真实原因。执行后仅干净目录消失，dirty / occupied / outside / unmerged
  目录仍在；重试同一预览返回 `duplicate:true` 且不再删除；跨所有者执行返回 404；审计记录可读。
- 截图：`after-cleanup-confirm-desktop-light.png` 显示预览清单与二次确认面板。
- supervisor 单测 `apps/supervisor/test/cleanup.test.ts` 注入一次删除失败：原 worktree 路径在删除前已
  原子消失，失败只留下 `.cleanup-trash/` 隔离目录，验证不会出现"半删的原目录"。

### 未验证 / 限制

- 7 天从平台持久完成事件起算，不以 GitHub `mergedAt` 或文件 mtime 起算；本单在验证记录中明确
  该口径。若运行时的完成事件缺失，回退到任务行 `updated_at`。
- 若执行进程在某一项删除中途崩溃，`cleanup_runs` 会停留在 `running`；已移入隔离区的目录不会
  回到原路径，操作者可用同一条审计线索重新预览/重试。未自动做超时回收，避免误删。
- 未对其它文件系统（跨设备 rename）做专门处理；当前部署的 worktree 与隔离区在同一 `WORKTREE_ROOT`
  下，rename 为同文件系统原子操作。

## 4.1 B4 端到端覆盖判断

B4 要求真实 PostgreSQL + 真实 API + 真实 Chromium，每项红→绿各一份原始输出。**本单认为
B1/B2/B3 三份证据已经覆盖 B4**：

- B1 从真实 API 的 `GET /api/v1/events`（`text/event-stream`）接收真实持久事件，在真实 Chromium
  中触发/去重/点击通知；`B1-green.txt` 同时记录每页 SSE 原始计数。
- B2 直接请求真实 API 的搜索路由，验证分页、越权、特殊字符与超长词；真实 PostgreSQL 数据。
- B3 直接请求真实 API 的预览/执行路由，由真实宿主 supervisor 操作真实 worktree 并真实删除。
- 三份证据都有 `main@68c01e5` 基线的红侧和本单 head 的绿侧。

「新建任务 → 提问/回答 → PR」这条完整链路属于 M3/M6-A 的验收范围，M6-B 从该链路产生的持久
事件开始消费；在本单重跑它只会重复 M3/M6-A 的检查，不能增加 M6-B 代码的覆盖。因此未另造一条
合成旅程。HTTPS 端到端与部署属 M6-C，不在本单。

## 5. 代码与数据变更

- 契约：`packages/contracts/src/{activity,history,cleanup}.ts` 与导出。
- DB：`cleanup_runs`、`cleanup_items` 与枚举（迁移 `0017_workable_cardiac.sql`）；回滚脚本
  `rollback/0017_workable_cardiac.down.sql`。
- API：`routes/{activity,history,cleanup}.ts`；`domain/cleanup.ts`；配置
  `CLEANUP_RETENTION_DAYS` / `CLEANUP_PREVIEW_TTL_MINUTES` / `CLEANUP_MAX_CANDIDATES`。
- supervisor：`cleanup/{inspect,delete,trash}` 控制路由与 `src/cleanup.ts`；真实路径、git 状态、
  `/proc` 占用检查、原子隔离删除。
- Web：通知/活动库、活动中心、历史搜索弹窗、通知与清理设置区、顶栏与侧栏未读徽标、通知点击定位。

## 6. Before / After 视觉证据

同一隔离数据库、同一会话、同一视口与主题：

| 场景 | Before（main@68c01e5） | After（本单） |
| --- | --- | --- |
| 活动中心 · 桌面浅色 1440×900 | `before-activity-desktop-light.png` | `after-activity-desktop-light.png` |
| 活动中心 · 手机深色 390×844 | `before-activity-mobile-dark.png` | `after-activity-mobile-dark.png` |
| 设置 · 桌面浅色 1440×900 | `before-settings-desktop-light.png` | `after-settings-desktop-light.png` |
| 设置 · 手机深色 390×844 | `before-settings-mobile-dark.png` | `after-settings-mobile-dark.png` |
| 历史搜索 · 桌面浅色 | 基线无此入口 | `after-history-desktop-light.png` |
| 清理预览/确认 · 桌面浅色 | 基线无此入口 | `after-cleanup-confirm-desktop-light.png` |

Before 由 `main@68c01e5` 的独立构建（端口 4626）拍摄，After 由本单构建（端口 4625）拍摄；
`records.json` / `ui-records.json` 记录每张图的 base、theme、viewport。

## 6.1 证据头与 PR head 的对应关系

证据日志头部的 `git rev-parse HEAD` 是**产出证据的代码提交**（具体值见 `docs/evidence/m6b/run.json` 与每份日志第 2 行）。该提交之后只有一个仅含 `docs/evidence/m6b/` 的证据提交（PR head）；代码没有再变化。
可用以下命令核对：

```bash
# <evidence-head> = 证据日志头部记录的提交；<pr-head> = PR 当前 head
git diff --name-status <evidence-head>..<pr-head>
# 输出只应列出 docs/ 下的证据与验证记录文件，不应出现代码、迁移或配置
```

本次交付的 PR 描述中也贴出了该命令在最终 head 上的原始输出；证据文件本身记录了产出时的
`git rev-parse HEAD`，不把证据提交误写成代码提交。

## 7. 实际命令与结果

```text
# 全量静态检查与单元测试
pnpm check                         # 通过（lint / format / typecheck / unit tests）

# 真实 PostgreSQL 集成测试
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres pnpm test:integration
# 含 apps/api/test/integration/m6b.integration.test.ts 8 项与
# packages/db/test/integration/rollback-0017.integration.test.ts 2 项

# 端到端证据（真实 PG + 真实 API + 真实 Chromium；隔离端口 4625/4626/4696）
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres node scripts/m6b/evidence.mjs
```

端到端证据脚本只使用隔离数据库、`/tmp/m6b-run` 与回环端口 4625/4626/4696；未重启 3082 或
生产 API 4300，未改动 `/root/src/upstream/*`。

## 8. 未在真实生产环境验证

- 所有者正式设备上的浏览器通知外观与权限 UI；本单使用真实 Chromium 与真实浏览器通知 API，
  但自动化环境没有桌面通知中心。
- 生产 systemd/supervisor 部署下的清理；本单使用同版本 supervisor 进程与真实文件系统，
  非生产服务重启不在本单。
- HTTPS 端到端、备份恢复与回滚演练属于 M6-C。

## 9. 迁移与回滚

- 迁移 `0017_workable_cardiac.sql` 为向前迁移：新增两个枚举、`cleanup_runs`、`cleanup_items`
  与索引；不修改已有业务表。
- 回滚脚本 `packages/db/migrations/rollback/0017_workable_cardiac.down.sql` 校验对应 ledger
  行与"没有更晚迁移"，然后删除索引、两表与枚举；真实 PostgreSQL 上的 rollback-0017 集成测试
  覆盖"回滚成功、二次回滚拒绝、重新迁移成功、更晚迁移存在时拒绝"。
- 生产迁移前仍按 M6-C 要求备份；本单不声称替代备份恢复演练。
