# M6-A 验证记录（附件与审阅面板）

日期：2026-11-08。基线：`main@d02f07f1483e0c85a13c1dfe24d03d855a72d0a1`（PR #32 merge）。
被测代码：本分支实现提交（最终 head 在 PR 固定评论中记录）。本文只记录实际执行过的命令、
原始输出与判定；未验证项单列，不表述为通过。

证据文件在 [`evidence/m6a/`](evidence/m6a/)：A1–A7 是逐项命令与原始输出，`ui-checks.json`
与 `records.json` 是浏览器截图与 DOM 断言，截图是 before/after 对照。

## 1. 现场与隔离

| 项 | 实测 |
| --- | --- |
| 宿主 | Ubuntu 24.04、PostgreSQL 16（隔离实例 `127.0.0.1:55432`）、Node 24.22.2（`/opt/moyu-node24`）+ pnpm 11.7.0 |
| 被测 API | 本分支构建，`127.0.0.1:4620`，DB `moyu_m6a`，附件存储 `/tmp/m6a/artifacts` |
| 对照 API（before） | `main@d02f07f` 构建，`127.0.0.1:4621`，同一 DB 与存储 |
| 宿主 supervisor | 本分支构建，`127.0.0.1:4690`，`WORKTREE_ROOT=/tmp/m6a/worktrees`，profile `probe1` |
| 任务 worktree | `/tmp/m6a/worktrees/probe1/m6a-review-t_m6a_4bd4aa`，真实 git 仓库，含修改/删除/重命名/未跟踪 |
| 未触碰 | 生产 `moyu.service`（4300）、bootstrap 3082、`/root/src/upstream/*`、其它仓库 |

任务行、会话与 PR 号是隔离 fixture（`scripts/m6a/seed-fixture.mjs`）；**diff、检查结果、提交与
PR 状态不是 fixture**：它们分别由真实 worktree 上的 `git` 命令、真实 `pnpm check` 运行和
`gh pr view` 产生。

## 2. 逐项结果

### A1 上传主链路 — 通过

`evidence/m6a/A1-upload.txt`：真实 multipart 上传 PNG（HTTP 201）与文本文件（201），下载
`sha256` 与上传逐字节一致（`cmp` 通过）；HTML 上传后下载响应为
`content-type: application/octet-stream`、`content-disposition: attachment`、
`CSP sandbox`、`nosniff`，不内联执行；附 `artifacts` 表原始行与存储目录（服务端生成键、0600）。

### A2 上传拒绝面 — 通过

`evidence/m6a/A2-rejections.txt`：超限（10 MiB + 1 KiB）→ 413 `payload_too_large`，前后
`attachments` 行数均为 3；非法类型 `application/x-msdownload` → 422，行数不变；未登录 → 401；
另一个所有者向本会话上传 → 404；另一个所有者读本会话 `attachmentId` → 404；本所有者向另一个
所有者的会话上传 → 404；空文件 → 422。每条都附原始响应体。

### A3 附件与投递 — 未传，已明确记录

`evidence/m6a/A3-attachment-delivery.txt`：带两个附件的消息返回 202，附件与消息同一事务绑定
（`artifacts.message_id`）。真实 dispatcher 发出的 Bridge Trigger 原始 JSON 只有 `text`，
**没有 `attachments` 字段**：共享契约 `bridgeTriggerInputSchema` 是 `.strict()` 且上游 Source
的 Trigger 没有附件字段。本单不把附件内容塞进 `text`，也不声称附件已投递到 runtime；附件保存
在平台并随消息展示/下载。投递到 runtime 需要上游 Bridge 补丁与能力协商，归后续单。

### A4 diff 面板 — 通过

`evidence/m6a/A4-diff.txt`：面板数据来自 supervisor 在真实 worktree 上执行
`git status --porcelain=v1`、`git diff --numstat HEAD`、`git diff HEAD` 与
`git diff --no-index /dev/null <untracked>`；面板里 LICENSE 的 patch 与
`git diff HEAD -- LICENSE` **逐字节一致**（`cmp` identical）；未跟踪文件按真实 patch 计增行；
无改动任务返回 `available` + 空文件列表（面板显示「无改动」）；worktree 已删除的任务返回
`cleaned` 与原因。

### A5 检查面板 — 通过

`evidence/m6a/A5-checks.txt`：同一任务、同一 worktree 三次真实运行 `pnpm check`：

| 次 | exit code | 结果 | 时间 |
| --- | --- | --- | --- |
| 1 | 0 | 通过 | 52.5 s |
| 2（故意把 `const broken: number = '…'` 写进 `apps/api/src/m6a-broken.ts`） | 2 | 失败（`Type 'string' is not assignable to type 'number'`） | 29.2 s |
| 3（删除该文件后） | 0 | 通过 | 46.4 s |

面板记录命令、exit code、起止时间、耗时与输出末尾；失败在
`after-desktop-light-checks-failed.png` 可见，通过状态见 `after-desktop-light-review-panel.png`。
第一次运行还把本分支新增脚本的两处真实问题（未格式化、未定义 Node 全局）暴露为失败，修复后
才通过，说明失败不是摆拍。

### A6 提交与 PR 关联 — 通过

`evidence/m6a/A6-delivery.txt`：完整 40 位 commit SHA 来自 worktree 的 `git rev-parse HEAD`
（面板显示 `71c677a545dc45863cf243ad15f6aee7c8e1530e` 与提交说明）；PR 号与状态来自
`gh pr view`——本单 [#44](https://github.com/bouyer-sutrasky/MoYu/pull/44) 为 `open`；
真实关闭未合并的 [#45](https://github.com/bouyer-sutrasky/MoYu/pull/45) 为 `closed`，不显示
merged；把仓库名临时改成不存在的仓库时返回 `state: unknown` 与 GitHub 原因，不推断。

### A7 重启与已清理边界 — 通过

`evidence/m6a/A7-restart.txt`：重启 API 进程（pid 2672233 → 2683894）前后，同一任务返回的
review 投影 SHA-256 相同（diff 5 个文件、检查 exit 0、两个附件 sha256 一致）；数据库
`artifacts` 里 diff/check_report/attachment 行仍在；重启后附件下载逐字节一致。已清理 worktree
的任务返回 `cleaned` + 原因，面板显示「工作目录已清理」。

### A8 回归 — 见 `evidence/m6a/A8-regression.txt`

`pnpm check`（Node 24.22.2 / pnpm 11.7.0）在最终 head 上全绿；新增测试：附件集成 11 条、
review 集成 5 条、supervisor review 9 条、迁移回滚 2 条。既有附件下载、任务详情、会话相关
测试未删除或跳过（前后条数对照见 A8 记录）。

## 3. 浏览器 before/after

同一隔离数据库、同一 supervisor 产物，两个真实 API 实例（before = `main@d02f07f` 构建，
after = 本分支构建）。桌面 1440×900、手机 390×844，浅色与深色各一组；另附失败检查与已清理
两个 after-only 状态。DOM 断言写在 `ui-checks.json`：before 详情仍显示「在 M6 接入」占位，
after 显示变更/检查/提交/PR/已清理。

## 4. 迁移与回滚

- 新增迁移 `0015_late_gateway.sql`：`artifacts.message_id` + 外键 + 索引。
- 回滚：`packages/db/migrations/rollback/0015_late_gateway.down.sql`（校验 ledger 行，
  重复执行会被拒绝），真实 PostgreSQL 回滚测试 `rollback-0015` 通过。
- 代码回滚：revert 本 PR；已写入的 attachment/`diff`/`check_report` 产物在回滚后不再被读取，
  但不会被迁移回滚删除（列删除后行仍在）。

## 5. 未验证项

1. **附件未投递到 runtime**（见 A3）：上游 Source 与共享 Bridge 契约都没有附件字段，需要上游
   Bridge 补丁与能力协商，属于后续单。
2. **未在生产部署上验收**：证据来自隔离 API + 隔离 PostgreSQL + 真实 supervisor + 真实 git
   worktree；生产 `moyu.service`（4300）运行的是 M2 时代的制品，本单不改部署，也未在 3082
   上做任何变更。
3. **未在真实 DSH runtime 实例上跑模型执行**：被验收任务由隔离 fixture 建立，worktree 与
   检查命令是真实的，但不是「模型执行一个真实工单」的产物。diff/检查/提交/PR 的数据来源与
   生产路径相同（supervisor 读取 worktree、真实命令、GitHub），但整条「真实工单 → 模型执行
   → 面板」链路未在本单验证。
4. **未做手机端上传文件的真实交互截图**：手机截图覆盖面板布局，附件选择在桌面浏览器验证；
   文件选择器在手机浏览器上的行为未单独取证。
