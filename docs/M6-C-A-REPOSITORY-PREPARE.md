# M6-C A：仓库接入时准备 Git 副本，并解释失败与进度

更新时间：2026-11-17。范围只包含 Issue #79 的 A 段；B/C/D 不在本单。

## 1. 问题与基线复现

任务工作区原先由 Executor 的 prepare 命令在每次启动时执行一次完整远端
`git clone`，再 checkout 冻结提交。仓库接入 API 只调用 supervisor 的
`prepare/wake`，它准备的是 profile、端口、凭据和工作目录，不准备仓库对象。

基线复现（`scripts/m6c/repo-prepare-repro.mjs`，本地 bare 仓库，无网络）：

- 两个任务各自完整克隆一次：均为 `in-pack: 1240`、`45 056` 字节；
- 在 checkout 途中硬杀第三次克隆，留下非空工作区（1 个文件）；
- 该工作区不是可用的 Git checkout，但旧 `prepareDirectory` 只删除**空**目录，
  下次启动会把任何已存在目录当作“已准备好”，从而把半成品交给 worker。

原始结果：`docs/evidence/m6c-a/baseline-repro.json`。

真实 GitHub 仓库准备与首任务证据（私有测试仓
`Bouyer12/m6c-a-repo-cache-20261117`）：

- 仓库副本准备：5.4 s，`git clone --mirror`，HEAD
  `c8ff4ec28d47f5e4d73bb42488026b5df97fb005`，副本 41 508 字节；
- 首任务工作区：27 ms，`GIT_SSH_COMMAND=false`（任何远端访问都会失败），
  仍成功检出同一 SHA，`origin` 恢复为 GitHub SSH URL，分支
  `agent/evidence-task`，提交身份为 `Bouyer12`，工作区干净，无
  `.preparing-*` 残留。

原始结果：`docs/evidence/m6c-a/real-github-preparation.json`。

## 2. 实现

### 2.1 仓库级 Git 副本

- supervisor 在 `WORKTREE_ROOT/<profile>/.repository.git` 维护一个 bare mirror；
- 首次接入时 `git clone --mirror --progress`，后续刷新用
  `git fetch --prune --progress origin`，不再为每个任务完整克隆；
- 先写 `<cache>.partial-<pid>-<time>`，bare/默认分支 HEAD 校验通过后才原子
  rename 为正式副本；失败或超时会删除临时副本，绝不把半成品标记为 ready；
- 进度来自 Git 自己的 `--progress`：`connecting / receiving / resolving /
  finalizing / verifying / ready`；Git 没给百分比时 `progress` 为 null，不估算；
- 仓库级超时 `REPO_PREPARE_TIMEOUT_MS`（默认 900 s）只约束一次仓库准备，不靠
  延长任务超时；超时会杀掉 Git 进程组并给出中文原因；
- 同一仓库的并发 prepare 在进程内合并，重复点击不会启动第二次克隆；
- supervisor 重启时，仍为 `preparing` 的行改为 `failed` 并提示重试，清理残留
  `.partial-*`，不留下永久“准备中”；
- 副本位于该仓库的 profile 目录下，配置了 runtime uid/gid 时整棵树 chown 给
  运行身份；其它仓库的 profile 目录保持 0700，互相不可读。

### 2.2 任务工作区与冻结提交

prepare 命令改为：从本地副本 `git clone --no-tags --local` 到
`$DSH_SUPERAGENT_DIR.preparing-$$`，恢复 `origin` 为 GitHub SSH URL，检出
`DSH_SUPERAGENT_WORKSPACE_BASE_COMMIT`，设置提交身份，创建
`agent/$DSH_SUPERAGENT_NAME`，最后 `mv` 到正式目录。

- 冻结提交已在副本中时完全不访问远端；
- 副本落后于分支时只 fetch 缺失的提交（先按 base branch，再按精确 SHA）；
- 目标目录已存在时以 74 失败，绝不覆盖已有现场；
- 中断只会留下 `.preparing-*`，正式目录不存在，下一次启动会重新准备。

### 2.3 状态、准入与恢复入口

- 迁移 `0020` 在 `repository_instances` 增加 `git_state/git_phase/git_progress/
  git_detail/git_started_at/git_finished_at/git_attempts/git_head`；
- `GET /api/v1/repositories/:id/runtime` 与新 `GET /api/v1/repositories` 的
  `runtime.preparation` 暴露这些事实；`actions` 增加 `prepare`；
- `POST /api/v1/repositories/:id/prepare` 是仓库层重试/刷新入口；
- 新执行准入：`POST /conversations`（execute）、讨论转执行、失败重试在
  supervisor 已配置时要求 `preparation.state='ready'`；preparing/failed 返回
  409 和可读中文原因，不创建任务；
- 既有仓库（`git_state='none'`）第一次请求执行时会自动发起补准备并返回 409，
  无需重新添加仓库；
- Web 侧栏显示准备阶段、Git 百分比、失败原因和“重试准备仓库副本”按钮；准备中
  每 2 s 轮询真实 runtime，准备结束后停止。

### 2.4 Bridge 执行阶段

上游补丁 `0027-prepare-phases.patch`：

- Executor 在 checkout 开始、成功、失败/超时、暂停中止、worker 启动时追加
  `task.progress`；
- 失败文案包含阶段（检出/核对）和「worker 未启动」，超时包含秒数；
- 文案为中文，键按 Assignment 区分，重试不会因去重看不到第二次进度；
- 复用既有 `task.progress` 事件，不新增事件类型；平台无需额外字段即可在会话
  进度列表展示。

## 3. 迁移与回滚

- 正向：`pnpm --filter @moyu/db db:migrate`（0020）。
- 回滚：`packages/db/migrations/rollback/0020_*.down.sql` 删除新增列；不删除
  已准备好的 `.repository.git` 副本。回滚后旧代码忽略这些列，任务回到每次
  完整克隆；再次升级会重新准备或报告失败。
- 副本本身可直接删除；下一次仓库 prepare 会重新创建。删除前应先确认没有
  正在运行的任务使用该副本（任务工作区是独立 hardlink 克隆，副本删除不影响
  已存在工作区）。

## 4. 验证

原始日志在 `docs/evidence/m6c-a/`。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm check` | 0 | lint/format/typecheck/unit 全通过；supervisor 120、API 20、dispatcher 7、contracts 26、runtime-client 13 |
| `pnpm test:integration`（`TEST_DATABASE_ADMIN_URL` 指向独立 PostgreSQL） | 0 | db 53、API 131、dispatcher 87（1 skipped）、supervisor 4 |
| `pnpm build` | 0 | web/API/dispatcher/supervisor 均产出 |
| `integrations/superagent/build-patched.sh`（0001–0027） | 0 | typecheck + build 通过；`lib/index.js` sha256 `d406608264508db2a4f5ad225c654a3af4c538a949f9276c818f2ac6d2e33f59` |
| `node scripts/m6c/repo-prepare-repro.mjs` | 0 | 基线红：两次完整克隆、半成品目录被当作已准备 |
| supervisor `git-cache` 单测 | 0 | 真实 Git 副本、并发合并、失败清理、重启恢复、超时、后续更新、只 fetch 缺失提交、远端禁用时首任务成功 |
| `scripts/m6c/repo-cache-evidence.mts`（真实私有 GitHub 仓） | 0 | 5.4 s 准备；首任务 27 ms、`GIT_SSH_COMMAND=false` 下检出同一 SHA |
| Playwright 截图 | — | 桌面 1440×900 浅色、手机 390×844 深色，Before/After 各一组；另有失败态截图 |

上游 `0027` 目标测试（`tests/prepare-progress.spec.ts`、`tests/docs.spec.ts`）
在本机干净环境中通过；上游全量测试中 Feishu/环境用例的外部依赖失败不属于
本补丁（详见 `integrations/superagent/README.md` 的既有说明）。

截图对应同一仓库 `Bouyer12/m6c-a-repo-cache-20261117` 与同一侧栏状态：
Before 是 9b9bff9（没有仓库副本概念），After 是分支 HEAD（显示准备阶段和重试
入口）。图片在 `docs/evidence/m6c-a/`。

## 4.1 返修：真正并发的 prepare 去重

`RepositoryGitCache.begin()` 现在在第一个 `await` 之前写入 reservation：

- `active` 保存 `{ started, job }`；第二个并发调用直接等待同一个 `started`，
  不会再次 `updateInstance`，也不会启动第二次 clone/fetch；
- 初始化失败时 reject `started` 并删除 reservation，后续可重试；
- 后续准备失败仍由 `prepareOnce` 写入 `failed`，异常路径不留下 reservation。

回归测试 `test/git-cache.test.ts` 的
`joins two concurrent preparations instead of starting a second clone`：

```ts
const [first, second] = await Promise.all([cache.begin(id), cache.begin(id)]);
await waitForRow(row, 'ready');
expect(row.gitAttempts).toBe(1);
expect(cloneStarts).toBe(1);
```

`cloneStarts` 由注入的 `spawn` 计数，只统计实际 `clone`/`fetch` 子进程。
12/12 通过（`docs/evidence/m6c-a/real-run-20261117/concurrency-test.log`）。

## 4.2 返修：正式 supervisor 服务身份下的真实运行

运行环境：主机 `lavm-flnape7bgu`，服务身份 `moyu-m6c`（uid 988），
systemd 临时/正式 unit（`User=moyu-m6c`、`Delegate=yes`、
`DelegateSubgroup=supervisor`、`NoNewPrivileges=yes`），隔离 release
`/opt/moyu-a/releases/c1a03401d285f530754361713fc24c0c91f88ca9`、隔离数据库
`moyu_a_repair`、隔离状态 `/var/lib/moyu-a`，未触碰正式 4310/4491 栈与
`moyu_m6c` 库。

- 真实仓库：`Bouyer12/m6c-a-repo-cache-20261117`（私有测试仓）；
  repository id `87b05f90-4f4f-4f1c-83fa-5aac305c51b1`。
- 仓库准备：`moyu-m6c` 运行 `git clone --mirror`，09:31:53 完成，
  head `c8ff4ec28d47f5e4d73bb42488026b5df97fb005`；日志
  `supervisor.log` 的 `supervisor.git_prepare_ready`。
- 首任务失败：删除 `.repository.git` 后交付消息，任务
  `6895b931-bdbf-4f2e-a9b7-0dfec4581ce6` 在 09:36 变为 `failed`；Bridge
  `task.progress` 记录「阶段：检出工作区；worker 未启动」。
- 仓库恢复：`POST /api/v1/repositories/:id/prepare` 重新准备，attempt 2 ready。
- 原 task ID 重试：09:36:47 同任务 `retry`，worker 启动，09:37:42
  `awaiting_review`，产出 PR
  `https://github.com/Bouyer12/m6c-a-repo-cache-20261117/pull/1`。
- 副作用：1 条 delivery、1 个 ticket、1 个 assignment、1 个 worktree、
  1 个 DSH 运行进程、1 个 PR；仓库 clone 总共 2 次（初始 + 恢复），任务
  工作区只从本地副本 clone。
- `0027` 进度到达 Web：Bridge `events.jsonl` 6 条 `task.progress`，页面
  截图 `real-run-failed-progress.png`、`real-run-retry-progress.png`、
  `real-run-final.png`，页面文本同目录。
- 真实超时：注入慢 SSH（`sleep 60`）并把 `REPO_PREPARE_TIMEOUT_MS` 设为
  10 s，仓库准备在 10 s 后 `failed`，detail 为
  「仓库副本准备超时（阶段 connecting）…」；移除注入后重试恢复 ready。
  证据在 `real-run-20261117/timeout/`。

## 5. 未验证项

- 真实运行在正式服务身份/unit 语义下完成，但使用隔离 release、数据库与状态
  目录；未替换线上 4310/4491 栈，也未触碰正式库。
- 未验证两个 supervisor 进程同时对同一仓库 prepare 的跨进程互斥；当前部署为
  单 supervisor，进程内已合并重复请求。
- 手机截图由 Playwright 视口模拟，不是真机；未由所有者做真机视觉签收。
- 生产发布、3082 引导实例、正式库与 `.env` 未改动，由所有者按现有流程执行。
