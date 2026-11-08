# M6-A 验证记录（附件与审阅面板）

日期：2026-11-08。基线：`main@1001c2544c68b8f4d906e330566f6fdb6ff0c795`（rebase 后的 PR base；
原始基线 `d02f07f` 已被 main 前进覆盖）。被测代码：**`d4d5801358b9f0c814cf25ae7491aadb90f14f09`**，
每份证据第 3 行是产出该证据时 `git rev-parse HEAD` 的原始输出。最终 PR head 比它多一个只含
`docs/` 的提交，PR 描述里记录了最终 head 与「两者之间非 docs 差异为空」的核对输出。

本文件只记录实际执行过的命令、原始输出与判定；未验证项单列，不表述为通过。

复现：`scripts/m6a/evidence.sh`（需 `TEST_DATABASE_ADMIN_URL`、可选的 PR 号），它在本 checkout 上
构建、起隔离 API/supervisor/录制用 Bridge、建真实 ticket worktree，并把 A1–A8 重新写进
`docs/evidence/m6a/`。它只动隔离 PostgreSQL、`/tmp/m6a-run` 与回环端口 4620/4621/4690/4699。

## 1. 现场与隔离

| 项 | 实测 |
| --- | --- |
| 宿主 | Ubuntu 24.04、隔离 PostgreSQL 16（`127.0.0.1:55432`）、Node 24.22.2（`/opt/moyu-node24`）+ pnpm 11.7.0 |
| 被测 API | 本分支构建，`127.0.0.1:4620`，DB `moyu_m6a_evidence`，附件存储 `/tmp/m6a-run/artifacts` |
| 对照 API（before） | `main@1001c25` 构建，`127.0.0.1:4621`，同一 DB 与存储 |
| 宿主 supervisor | 本分支构建，`127.0.0.1:4690`，`WORKTREE_ROOT=/tmp/m6a-run/worktrees`，profile `probe1` |
| 任务 worktree | `/tmp/m6a-run/worktrees/probe1/m6a-review-t_m6a_d4d580`，真实 git 仓库，含修改/删除/重命名/未跟踪 |
| 未触碰 | 生产 `moyu.service`（4300）、bootstrap 3082、`/root/src/upstream/*`、其它仓库 |

任务行、会话与 PR 号是隔离 fixture（`scripts/m6a/seed-fixture.mjs`，含第二个所有者用于跨所有者
用例）；**diff、检查结果、提交与 PR 状态不是 fixture**：它们分别由真实 worktree 上的 `git` 命令、
真实 `pnpm check` 运行和 `gh pr view` 产生。

## 2. 逐项结果

### A1 上传主链路 — 通过

`evidence/m6a/A1-upload.txt`：真实 multipart 上传 PNG（HTTP 201）与文本文件（201），下载
`sha256` 与上传逐字节一致（`cmp` 通过）；HTML 上传后下载响应为
`content-type: application/octet-stream`、`content-disposition: attachment`、
`CSP sandbox`、`nosniff`，不内联执行；附 `artifacts` 表原始行与存储文件（0600）。

### A2 上传拒绝面 — 通过（含磁盘取证）

`evidence/m6a/A2-rejections.txt`：超限（10 MiB + 1 KiB）→ 413 `payload_too_large`；非法类型
`application/x-msdownload` → 422；未登录 → 401；另一个所有者向本会话上传 → 404；另一个所有者
读本会话 `attachmentId` → 404；空文件 → 422。每次拒绝前后同时记录数据库行数与存储目录
（`files=`、`bytes=` 来自 `find`/`du -sb`），**两次都是 `rows=3 files=12 bytes=636`**，即不落库
也不落盘；每条都附原始响应体。

### A3 附件与投递 — 未传，已明确记录

`evidence/m6a/A3-attachment-delivery.txt`：带两个附件的消息返回 202，附件与消息同一事务绑定
（`artifacts.message_id`）。真实 dispatcher 发出的 Bridge Trigger 原始 JSON 只有 `text`，
**没有 `attachments` 字段**：共享契约 `bridgeTriggerInputSchema` 是 `.strict()` 且上游 Source
的 Trigger 没有附件字段。本单不把附件内容塞进 `text`，也不声称附件已投递到 runtime；附件保存
在平台并随消息展示/下载。投递到 runtime 需要上游 Bridge 补丁与能力协商，归后续单。

### A4 diff 面板 — 通过

`evidence/m6a/A4-diff.txt`：面板数据来自 supervisor 在真实 worktree 上执行
`git status --porcelain=v1`、`git diff --numstat HEAD`、`git diff HEAD` 与
`git diff --no-index /dev/null <untracked>`；本次为 4 个文件（删除 LICENSE、修改 README、重命名
GLOSSARY、未跟踪 fixture），合计 `+5 -21`；LICENSE 的面板 patch 与 `git diff HEAD -- LICENSE`
**逐字节一致**（`cmp` identical）；未跟踪文件的增行数取自真实 patch；无改动任务返回
`available` + 空文件列表；worktree 已删除的任务返回 `cleaned` 与原因。

### A5 检查面板 — 通过

`evidence/m6a/A5-checks.txt`：同一任务、同一 worktree 三次真实运行 `pnpm check`：

| 次 | exit code | 结果 | 耗时 |
| --- | --- | --- | --- |
| 1 | 0 | 通过 | 57.2 s |
| 2（故意把 `const broken: number = '…'` 写进 `apps/api/src/m6a-broken.ts`） | 2 | 失败（`Type 'string' is not assignable to type 'number'`） | 29.3 s |
| 3（删除该文件后） | 0 | 通过 | 46.6 s |

面板记录命令、exit code、起止时间、耗时与输出末尾；失败状态在**失败运行期间**截图
（`after-desktop-light-checks-failed.png`，DOM 断言其文本含「失败 / exit 2」），通过状态见
`after-desktop-light-review-panel.png`。

### A6 提交与 PR 关联 — 通过

`evidence/m6a/A6-delivery.txt`：完整 40 位 commit SHA 来自 worktree 的 `git rev-parse HEAD`
（`d4d5801358b9f0c814cf25ae7491aadb90f14f09`）与提交说明；PR 号与状态来自 `gh pr view`——本单
[#44](https://github.com/bouyer-sutrasky/MoYu/pull/44) 为 `open`（head 与 worktree HEAD 一致）；
真实关闭未合并的 [#45](https://github.com/bouyer-sutrasky/MoYu/pull/45) 为 `closed`，不显示
merged；把仓库名临时改成不存在的仓库时返回 `state: unknown` 与 GitHub 原因，不推断。

### A7 重启与已清理边界 — 通过

`evidence/m6a/A7-restart.txt`：重启 API 进程前后，同一任务返回的 review 投影 SHA-256 相同
（`8587d6d7…`；4 个文件、检查 exit 0、PR open），`identical to the pre-restart projection: true`；
数据库 `artifacts` 里 diff/check_report/attachment 行仍在；重启后附件下载逐字节一致。已清理
worktree 的任务返回 `cleaned` + 原因，面板显示「工作目录已清理」。

### A8 回归 — 通过

`evidence/m6a/A8-regression.txt`：

- `pnpm check`：before `exit 0`、after `exit 0`；单元条数 contracts 13 / runtime-client 13 /
  dispatcher 5 / api 20 两边一致，supervisor 38 → 47（+9 条 review 测试），guard/verify-lock 15 不变。
- `pnpm test:integration`：before `exit 0`（db 11 文件 38、api 11 文件 66、dispatcher 16 文件
  80 + 1 skipped）、after `exit 0`（db 12 文件 40、api 13 文件 82、dispatcher 不变）。
- 既有「附件下载」「任务详情」「会话」测试未删除或跳过；差异仅来自新增测试与 0015 迁移计数。

## 3. 0014 回滚脚本的归属（复审第 4 件）

`evidence/m6a/0014-scope.txt`：本 PR **没有改** 0014 脚本
（`git diff --stat origin/main...HEAD -- …/0014_execution_reservations.down.sql` 为空）。main 上
已有的 0014 守卫（事务 + ledger 行唯一）保持原样；「0014 必须是最后一条已应用迁移」的脚本级
守卫属于 **#37**，本单不实现。

本单只做 0015 带来的必要适配：回滚测试改为 **先 0015、后 0014**，迁移计数 15 → 16。反例已在
独立数据库上复现：在 0015 仍在时直接回滚 0014，`migrateDatabase` 不会重放 0014
（`execution_reservations present = false`），未适配的 `rollback-0014` 测试会在
`expected { table_present: true } received { table_present: false }` 处变红；按支持顺序回滚后
两表/列都能重建。

## 4. 浏览器 before/after

同一隔离数据库、同一 supervisor 产物，两个真实 API 实例（before = `main@1001c25` 构建，
after = 本分支构建）。桌面 1440×900、手机 390×844，浅色与深色各一组；另附失败检查与已清理
两个 after-only 状态。DOM 断言在 `ui-checks.json`，全部为 true：before 详情显示「在 M6 接入」
占位，after 显示变更/检查/提交/PR、失败检查与已清理。

## 5. 迁移与回滚

- 新增迁移 `0015_late_gateway.sql`：`artifacts.message_id` + 外键 + 索引。
- 回滚：`packages/db/migrations/rollback/0015_late_gateway.down.sql`（校验 ledger 行，
  重复执行会被拒绝），真实 PostgreSQL 回滚测试 `rollback-0015` 通过。
- 0014 脚本未改；其测试按 0015 → 0014 的支持顺序执行（见 §3）。
- 代码回滚：revert 本 PR；已写入的 attachment/`diff`/`check_report` 产物行在回滚后不再被读取。

## 6. 未验证项

1. **附件未投递到 runtime**（见 A3）：上游 Source 与共享 Bridge 契约都没有附件字段，需要上游
   Bridge 补丁与能力协商，属于后续单。
2. **未在生产部署上验收**：证据来自隔离 API + 隔离 PostgreSQL + 真实 supervisor + 真实 git
   worktree；生产 `moyu.service`（4300）运行的是 M2 时代的制品，本单不改部署，也未在 3082
   上做任何变更。
3. **未在真实 DSH runtime 实例上跑模型执行**：被验收任务由隔离 fixture 建立，worktree 与
   检查命令是真实的，但不是「模型执行一个真实工单」的产物。
4. **手机端未做附件选择的真实交互截图**：手机截图覆盖面板布局；附件选择在桌面浏览器验证。
