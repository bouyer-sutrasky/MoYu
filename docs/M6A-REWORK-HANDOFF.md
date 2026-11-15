# M6-A 返修交接（#56 → 新会话）

写给接手 #56 的新会话。分支 `agent/attachments-review-panel-4bd4aae33eac`、PR **#44**（不新开 PR）。
基线：分支 head `dfd5db935079c62248ab768adb87774db5486ad9`（本文件是其后的一个 docs-only 提交）、
`main = 1001c2544c68b8f4d906e330566f6fdb6ff0c795`。

原始判据不要照本文件转述执行，直接读：

- 复审报告：`M6A-PR44-ACCEPTANCE-DFD5DB9.md`（所有者本地 `E:\workplace\superagent-workspace-design\evidence\`）
- 计划原文：`REMAINING-PLAN-2026-11-04.md` 第 110–119 行（P2 M6-A 六条）
- 本仓库已完成部分的验收记录：`docs/M6-A-VERIFICATION.md`、`docs/evidence/m6a/`

本会话（旧会话）**在 #56 返修上没有任何代码改动**；唯一产出是这份交接文档。

## 1. 已完成（分支上真实存在的提交与已验证结论）

提交（当前 SHA，rebase 后；一句话说明）：

| 提交 | 内容 |
| --- | --- |
| `69446ac` | 迁移 0015：`artifacts.message_id` + 回滚脚本 + 回滚测试 |
| `47d74b7` | 附件上传/下载、消息绑定、supervisor review、API review 路由、Web 详情面板 |
| `00ec0dd` `5441193` `711daee` | 验收脚本格式化、Node 全局导入、PR 状态字段修正（`state/mergedAt`） |
| `e04e2c0` `0f8186c` | 0014 回滚测试适配 0015（先 0015 后 0014）与迁移计数 15 → 16；0014 守卫留给 #37 |
| `211afd5` | 删掉未使用的契约常量、记录草稿附件列表路由 |
| `b5c9fed` | 首轮验收证据与验证记录 |
| `9576e64` `942b1f0` `d4d5801` | 证据脚本可复现化（`scripts/m6a/evidence.sh`）、清理态不给 worktree、baseline worktree 重建 |
| `dfd5db9` | rebase 后重跑 A1–A8 的证据与验证记录（每份日志头是 raw `git rev-parse HEAD`） |

已验证并写在 `docs/M6-A-VERIFICATION.md`：上传/下载逐字节一致、HTML 不内联；拒绝面 413/422/401/404
且库行与磁盘不变；真实 worktree diff 与 `git diff HEAD -- <file>` 逐字节一致；检查 0 → 2 → 0；
真实 PR open/closed 状态与完整 commit SHA；API 重启后附件/diff/检查仍在；`pnpm check` 与
`pnpm test:integration` before/after 均 exit 0。

PR #44 在 `dfd5db9` 上两项必需 CI success、`MERGEABLE`/`CLEAN`。**这只说明没坏，不代表 #56 的
返修项已做**；合并由所有者决定。

## 2. 未完成（#56 全部项，含卡点位置）

### 2.1 P1-A 审阅越过宿主隔离（未开始，0 行代码）

四个可复现缺陷都在 `apps/supervisor/src/review.ts`：

- **外部 diff helper 会被执行**：`git()`（`:92`）把所有 git 调用交给 `runCommand`（`:53`），而
  `runCommand` 在 `:59-63` 用 `env: process.env` 且没有 `-c diff.external=`、没有 `--no-textconv`。
  任务仓库的 `diff.external`、`.gitattributes` 的 `textconv` 以及 supervisor 继承来的
  `GIT_EXTERNAL_DIFF`/`GIT_CONFIG_*` 都能生效。`collectChanges` 在 `:216`。
- **目录定位接受越界符号链接**：`locateTicketWorktree`（`:101`）只是 `readdirSync` +
  `statSync`（跟随符号链接）+ `existsSync(join(candidate, '.git'))`，没有 `realpath`，也没有
  「必须在 `worktreeRoot/<profile>` 内」的真实路径校验。
- **检查子进程继承 supervisor 环境**：`runChecks`（`:364`）同样走 `runCommand`，`:59` 直接
  `env: process.env`，所以只注入测试父进程的哨兵变量对子进程可见；也没有切换低权身份。
- **超时只杀 shell 直接子进程**：`:66-71` 只 `child.kill('SIGKILL')`，没有按进程组/后代回收，
  实测遗留子进程仍占管道约 2 秒。
- **并发门控有竞态**：模块级 `checkRuns` Map 在 `:407`，`createReviewService.checks` 先
  `await resolve(...)` 再 `checkRuns.set(...)`，两个同仓请求可同时通过。
- **触发面**：浏览器首次打开未采集任务的详情会自动采集（`apps/web/src/shell/WorkspaceShell.tsx`
  的 review effect，`:971-1005`，`api.taskReview` 之后在 `:999` 调 `loadReview({collect:true})`），所以
  打开面板即可命中上面三条。

### 2.2 P1-B 附件跨会话串号（未开始）

`apps/web/src/shell/Composer.tsx:65` 的 `files` 是组件级状态；`WorkspaceShell.tsx:1289` 只挂载
一次 `<Composer>`（没有 `key`、没有按会话作用域），切会话只恢复文本草稿，已选文件仍在；
发送时 `Composer.tsx:396` 用「当前」`conversationIdRef.current` 上传。→ 在 A 选文件、切到 B、发送，
会用 B 的会话 id 上传 A 的文件。需要把附件状态、上传 id、错误、待确认重试绑定
owner/repo/conversation/send-version，并覆盖切会话、删除、编辑、重试、迟到响应。

### 2.3 P1-B' 双入口合并带附件 422（未开始）

合并事务把消息插到目标会话（`apps/api/src/routes/conversations.ts:1114` 调
`attachToMessage(transaction, target.id, …)`），但别名源会话里附件行的 `conversation_id` 仍是
源会话，`attachToMessage`（`apps/api/src/domain/attachments.ts:177`）按目标会话校验 → 422
「attachmentIds 必须是本会话尚未发送的附件」。需要在同一事务内验证源归属并移动附件与消息引用，
覆盖重试、回滚、历史合并、跨所有者拒绝。

### 2.4 P1-C `evidence.sh` 会杀别人的进程（未开始）

`scripts/m6a/evidence.sh`：`:80-86` 的 EXIT trap 按端口杀监听者；`:322` 按命令行模式杀所有
dispatcher。需要记录本次启动的 PID/进程组/工作目录，只清理自己创建的；启动前校验归属；补「构造
一个同名外部进程、脚本不得动它」的红测。

### 2.5 计划 L113：附件贯通 Bridge 与执行器（未开始）

现状：`packages/contracts/src/runtime.ts` 的 `bridgeTriggerInputSchema`（约 L99–132）以
`.strict()` 结尾且没有 attachments 字段；dispatcher 只发 text（证据
`docs/evidence/m6a/A3-attachment-delivery.txt`）。要加：契约字段、`integrations/superagent/patches/`
新补丁（0023 之后）、能力协商、执行器把图片交给模型/文本按需读取，并用真实截图任务证明图像读取。
上游构建走 `integrations/superagent/build-patched.sh`（不要改 `/root/src/upstream/*` 源码）。

### 2.6 计划 L116：消息安全 Markdown（未开始）

`apps/web/src/shell/ConversationPane.tsx:96` 仍是 `<p>{message.body}</p>`。需要安全 Markdown、
代码块复制、可点击链接、长日志折叠；不执行原始 HTML/危险链接；手机无横向溢出、折叠保留内容、
复制准确，并有对应测试。

### 2.7 计划 L117：「基于此任务新建」（未开始）

未实现。涉及 `apps/web/src/shell/NewTaskPanel.tsx` 与 `POST /api/v1/conversations`（沿用既有
创建接口即可，不新开执行身份）；需覆盖目录已清理、PR 已合并/关闭、重复点击、跨仓库选择。

### 2.8 0015 回滚守卫（未开始）

`packages/db/migrations/rollback/0015_late_gateway.down.sql:5-14` 只核对自身账本行数量，没有
「存在后续迁移必须拒绝」的校验。照 0009 的 `latest` 校验实现（0014 的同名守卫是 #37 的范围），
补红测。

### 2.9 ⑤ 四项（未开始）

1. A7 的 `cleaned` 证据取自另一个未采集任务；现有任务缓存为 `available` 时，目录清理后普通打开
   仍可能显示旧结果 → 需真实 available → cleaned 转换。
2. MIME 只看声明/扩展名（`apps/api/src/routes/attachments.ts`），需内容嗅探 +「`.exe` 改名
   `.png` 必须拒」红测。
3. 附件选择只有文件名/大小，需预览与手机端真实证据。
4. 下载范围：仅拥有者可下载、会话撤销后失效，需红测。

## 3. 失败原因（上下文耗尽的具体表现）

- 三轮完整证据（每轮含构建、三次 `pnpm check`、截图、before/after 两套 check+integration）之后，
  已经无法在脑中同时保持 supervisor + API + Web 三处改动面；为 #56 做 P1-A 需要一次协调改
  review.ts 的采集/定位/检查三条路径，这一步只产出了计划，没有落地编辑。
- 具体丢状态点：写 `packages/db/test/integration/rollback-0014.integration.test.ts` 与
  `docs/M6-A-VERIFICATION.md` 时都出现过「写工具报 file changed since it was read」而必须重读；
  最后回答所有者二选一时，我是凭对文件的记忆而非重读代码作答，这正是我停下来交接的原因。
- 没有留下半成品：工作树干净，所有已提交内容都有 CI 与证据；本轮没有未提交的编辑。

## 4. 新会话的最小下一步（只做这一件）

**P1-A 的第一条：`collectChanges` 不得执行任务仓库配置的外部 diff helper。**

1. 先写红测（`apps/supervisor/test/review.test.ts`，用真实临时 git 仓库）：
   - `git config diff.external '<脚本>'`，脚本往 `$RUN/diff-helper-ran` 写哨兵；
   - 另一条用 `.gitattributes` + `git config diff.m6a.textconv '<脚本>'`；
   - 调 `collectChanges({directory, maxBytes, maxFiles})` 后断言哨兵不存在 —— 当前会红（helper 被执行）。
2. 转绿（`apps/supervisor/src/review.ts`）：
   - 给 `runCommand`（`:53`）加 env 选项；`git()`（`:92`）传最小环境：只保留 `PATH`、临时 `HOME`、
     `TMPDIR`、`LANG=C`，并删除继承的 `GIT_EXTERNAL_DIFF`/`GIT_CONFIG_*`/`GIT_DIR`/`GIT_WORK_TREE`；
   - `collectChanges`（`:216`）的每个 `git diff` 加 `--no-textconv` 与
     `-c diff.external=`、`-c core.attributesFile=/dev/null`（未跟踪文件走 `git diff --no-index` 时同样加）；
   - 把实际 argv 与 env 写进证据（原始命令输出），证明 helper 没有被调用。
3. 判定：红段与绿段两段原始输出进 `docs/evidence/m6a/`，头部写 raw `git rev-parse HEAD`；一条一提交。

做完这一条再按 #56 顺序推进其余项，不要跳步。

## 5. 关键路径与判据

- 分支 `agent/attachments-review-panel-4bd4aae33eac`；PR #44；基线 head `dfd5db9`；`main` `1001c254`。
- 隔离现场：PostgreSQL `127.0.0.1:55432`（admin URL 用 `postgres://moyu@127.0.0.1:55432/postgres`）、
  回环端口 4620（after API）/4621（before API）/4690（supervisor）/4699（录制用 Bridge）、
  暂存目录 `/tmp/m6a-run`（`scripts/m6a/evidence.sh` 会重建）。
- 命令必须用 `/opt/moyu-node24/bin`（Node 24.22.2 + pnpm 11.7.0），否则 `pnpm check` 报 engines 错。
- 已踩过的坑：
  1. rebase 会改所有提交 SHA；推送用 `git push --force-with-lease`，证据头写新 head。
  2. ticket 目录名后缀 = ticket id 前 12 字符；`cleaned` 任务必须**没有**目录（有 clone 就会变成
     `available` 空 diff）。
  3. 迁移计数在 `rollback-0005/0006/0009/0014` 测试里是 16；0014 回滚顺序是 0015 → 0014。
  4. 消息发送会调 `requestWake`，supervisor 会把实例投影翻成 `fault`（`prepare_failed`）；review
     只读 profile，仍能工作，不要据此判断失败。
  5. 手机截图要先点「打开导航」再点会话，面板入口是会话头的「详情」按钮；桌面是「展开右侧详情」。
  6. 面板首次打开会自动采集（`WorkspaceShell.tsx` 的 effect），这正是 P1-A 的危险面，修完前不要
     在含不可信仓库的场合随便打开面板做演示。
- 判据与边界（所有者口径，逐条照做）：每条先红后绿、守卫落生产路径、证据头 raw HEAD、不改
  `/root/src/upstream/*`、不重启 3082、隔离用暂存 `DSH_HOME`、证据脚本只清理自己启动的进程、
  不混入 M6-B / M6-C、合并由所有者决定。

## 6. 不要重做的东西

- `docs/evidence/m6a/A1-upload.txt`：上传/下载逐字节一致、HTML 不内联 —— 已成立。
- `A2-rejections.txt`：413/422/401/404 与库行、磁盘占用前后一致 —— 已成立（但 MIME 嗅探是 ⑤.2 的新要求）。
- `A3-attachment-delivery.txt`：附件与消息同事务绑定、Trigger 无 attachments 的原始记录 —— 已成立；
  注意「未传」本身正是 L113 要补的范围，不要把这份证据当成已完成。
- `A4-diff.txt`：普通文件 patch 与 `git diff HEAD -- <file>` 逐字节一致、无改动与已清理状态 —— 成立；
  重命名/特殊文件名计数与 available → cleaned 转换是 ⑤.1 的新要求。
- `A5-checks.txt`：0 → 2 → 0 的真实运行与失败截图 —— 成立（指纹失效与门控竞态是 A3 的新要求）。
- `A6-delivery.txt`：真实 open/closed PR 与完整 SHA、GitHub 不可用时的原因 —— 成立。
- `A7-restart.txt`：重启前后投影 digest 相同、附件仍可下载 —— 成立；`cleaned` 这一段证据不成立，按 ⑤.1 重做。
- `A8-regression.txt`：before/after 套件条数 —— 成立，可作为新会话的回归基线。
- 工具与文档：`scripts/m6a/evidence.sh`、`seed-fixture.mjs`、`screenshots.mjs`、`failure-shot.mjs`、
  `stub-bridge.mjs`、`docs/M6-A-VERIFICATION.md`、`docs/evidence/m6a/README.md` —— 直接复用，
  不要再从零搭环境。

## 建议加载的技能

- `dsh-superagent-github`：读 #56、PR #44、CI 与评论。
- `tdd`：先红后绿的顺序与测试写法（本单硬性要求）。
- `diagnosing-bugs`：git 外部 helper / textconv 行为或子进程回收不好复现时。
- `code-review`：推送前自审（本单守卫必须落在生产路径）。
