# M4「执行控制与 GitHub 汇总」验证记录

日期：2026-11-04。范围：`docs/DEVELOPMENT-GUIDE.md` 第 4 阶段与 Issue #21。只记录实际执行过的命令与结果；未执行项单列。

## 验证环境

| 项 | 值 |
| --- | --- |
| 基线 | `origin/main` = `96da992fc395c8657e3970bb90f7636c0535910e`（PR 记录实际基线） |
| 宿主 | Ubuntu 24.04.2 LTS，4 vCPU / 16 GB |
| 构建运行时 | Node 22.23.3（宿主；CI 按 `.node-version` 24.22.2），pnpm 11.7.0（corepack） |
| PostgreSQL | 16.15；平台集成测试使用 `127.0.0.1:55432` 的一次性库；线上 `moyu` 库未连接、未迁移 |
| 被测 runtime | 独立 `DSH_HOME=/root/.dsh-m4`、profile `m4`、state `/root/.dsh-m4/state/m4`、Web 3292、Bridge 3291；M4 补丁构建产物 |
| 测试仓库 | 私有 `Bouyer12/m3-loop-r3-68fa5d90`，基线 commit `bad7eac5174a3090078cbf687e76c41af1dc1b98` |
| 平台 | 构建产物 `apps/api/dist/server.js` + `apps/dispatcher/dist/main.js`，隔离端口 4302 |
| bootstrap | 3082 profile/state/service 未修改、未重启；4300 线上实例未改动 |
| 浏览器 | Playwright 1.56.1 Chromium，1440×900 / 390×844，浅色与深色 |

## 上游补丁与构建

```bash
integrations/superagent/build-patched.sh \
  /root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2 \
  /root/src/upstream/m4-live-build
# exit 0
```

- 有序补丁 `0001`–`0010` 全部通过 `git apply --check` / `git apply`；
- `pnpm typecheck` exit 0，`pnpm build` exit 0，产物含 `lib/index.js` 与 `lib/workspace-watch.js`；
- 构建只发布到新目录，未安装/未替换任何现场运行制品。

| 补丁 | 行数 | 作用 |
| --- | ---: | --- |
| `0005-discussion-mode.patch` | 509 | 讨论态接受、只读工具/权限、`discussing` 投影 |
| `0006-recoverable-pause.patch` | 946 | 可恢复暂停、停止证据、resume admission、start |
| `0007-bridge-execution-control.patch` | 1094 | pause/resume/start/retry、operation 日志、`targetTicketId` |
| `0008-github-import.patch` | 298 | `ticket.imported` 投影 |
| `0009-discussion-ready-stays-open.patch` | 61 | 讨论 ready 不结束 Ticket，owner 仍可 start |
| `0010-projection-current-assignment.patch` | 54 | 新 Assignment 后不再用旧 ready report 挡住运行态 |
| `0011-resume-does-not-reopen-closed-pr.patch` | 19 | resume/start 指示不重开已关闭未合并的 PR |

上游测试（干净环境，`corepack pnpm@11.7.0`）：

- 定向：`discussion`、`pause`、`bridge-control`、`bridge`、`ticket-freeze`、`runtime` 共 164 通过；加入 0009/0010 后定向回归 69 通过。
- 完整（含 0005–0011）：**1280 通过 / 1 失败（1281）**。唯一失败是 M0 已记录的 Feishu `tests/sources.spec.ts` 可选测试，与 M4 路径无关，未隐藏。

## 平台检查

```bash
corepack pnpm@11.7.0 -r --if-present typecheck     # exit 0
corepack pnpm@11.7.0 -r --if-present test          # exit 0
corepack pnpm@11.7.0 -r build                      # exit 0
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  corepack pnpm@11.7.0 test:integration             # exit 0
```

集成测试在真实 PostgreSQL 上覆盖：

- 迁移 `0005`：`prevId = a4604b87-e7fd-4935-bf5d-1e22bee9a36d`、`idx: 5`、时间戳单调；0005 回滚脚本（正确 hash 回滚并重放、错误/缺失 hash 拒绝）。
- 讨论会话创建、start 的 planRevision/baseCommit、命令幂等、版本冲突、停止/继续/重试状态校验、结束会话拒绝新消息。
- pause operation 只有在 `stoppedAt + agentStatus idle/absent + jobsAfter []` 后变 `stopped`；无证据时 `blocked`，不误报。
- resume 先取得 `runtime_leases` active 租约并核验快照中的保留工作目录；租约被其他任务持有时保持 queued。
- 平台重启核对：快照暂停 → stopped；快照不可确认 → blocked；已 stopped 不自动重启。
- GitHub import：同一 `externalId` 重复事件只建一条 conversation/task；`closed` 映射 `closed_unmerged` 并保留消息为 stored。
- ready report 一次性写入会话结果消息（讨论方案/执行结果）。

## 隔离实例真实链路

运行目录：[`docs/evidence/m4`](evidence/m4)。以下为实际结果，未执行项在 §未验证项 单列。

1. **讨论只读**：平台讨论会话 `b37501b0-eb9d-4ff1-a27f-b413ffbeecd3`，runtime Ticket `8dd09b7269fb5e6e276fb039b26357a5`，冻结基线 `bad7eac…`。
   - 会话事件显示 worker Session 从 `workspace-write` 切到 **`permission/preset: read-only` / `sandbox/mode: read-only`**；`/root/m4-run/readme-typo-recheck-8dd09b7269fb` 在讨论结束后 `git status --porcelain` 为空，提交仍为 `bad7eac`；
   - 讨论 worker 输出方案，平台 `awaiting_review`，方案作为 `result` 消息写入会话；
   - Ticket 未被 ready report 结束（0009），start 可用。
2. **讨论转执行**：`POST /tasks/:id/start` 记录 planRevision=1，runtime Ticket `mode: execute`、`planRevision: 1`；同一 Ticket/目录/会话，没有新任务。
3. **人工暂停**：执行 Assignment 创建后立即 `POST /tasks/:id/stop`，平台 `stopping → stopped`；停止证据（实际值见 [`live-pause-evidence.json`](evidence/m4/live-pause-evidence.json)）：
   `harnessPid: 3239225`、`cgroup: /system.slice/dsh-superagent.service`、`sessionId: worker-8dd09…`、`agentStatus: idle`、`jobsBefore: []`、`jobsAfter: []`、`subagentsAfter: 0`、`cancelledTurn: true`；
   Ticket 快照 `paused.stoppedAt` 存在、`ended: null`，工作目录保留。
4. **继续**：平台先取得 `runtime_leases`（fencing token 1），再调用 Bridge resume；Ticket `paused` 清除，`admission {leaseId, fencingToken}` 落库；同一 Ticket 新建 Assignment、同一工作目录、同一 session，`mode: execute`，worker Session 出现 `bash` 工具调用，证明写工具已恢复。
5. **执行结果与 PR**：另建直接执行任务 `579aece0-461b-46fc-8dcd-554fe0b55afa` / Ticket `6e046baece28ee32590332b931ab55bc`；worker 修改 README、运行 `npm test`、推送 `agent/readme-probe-line-6e046baece28` 并创建
   [PR #3](https://github.com/Bouyer12/m3-loop-r3-68fa5d90/pull/3)。平台 `awaiting_review`，`prUrl`/`prNumber` 已绑定；ready report 作为 `result` 消息写入会话（重复 report 同一摘要只写一次）。
6. **PR 关闭未合并**：关闭 PR #3（未合并）后，runtime 投影 `closed`，平台 `closed_unmerged`；PR 保持 `CLOSED`、`mergedAt: null`，未自动重开；工作目录与分支保留；对该会话发消息返回 `409`。
7. **暂停后继续到原 PR**：任务 `75b459cb-409b-430b-a12c-aad3e3589e9f` / Ticket `b60ed17e4687ba5620386d49ee8d3651` 完成并绑定 PR #4；`stop` 后 `stopped`（证据 `harnessPid: 3239225`、`agentStatus: idle`、`jobsAfter: []`），`resume` 后重新取得租约并回到
   `awaiting_review`，**`prUrl` 仍是同一个 PR #4**（`samePr: true`，version 10）。日志见 [`live-resume-pr.log`](evidence/m4/live-resume-pr.log)。
8. **PR 关闭未合并（PR #3）**：关闭 PR #3（未合并）后，runtime 投影 `closed`，平台 `closed_unmerged`；PR 保持 `CLOSED`、`mergedAt: null`，未自动重开；工作目录与分支保留；对该会话发消息返回 `409`。
   日志见 [`live-execute-pr-closed.log`](evidence/m4/live-execute-pr-closed.log)。

> 说明：隔离实例的 GitHub Source 已启用，但测试仓库没有可用的 `sutrasky` 人类账号事件；平台自身评论会被上游 `sameName` 过滤，M4 不修改该判据。因此 GitHub 汇入的**真实** @ 事件未在本轮取得，改为平台集成测试 + 上游桥接测试覆盖。

## 截图证据

Before 为 `origin/main` @ `96da992` 的真实构建，经同一隔离 API、同一数据库、同一 Playwright、视口与主题采集；After 为本分支构建。Before 的讨论页没有“按此方案开始执行”，停止详情没有“停止证据/继续”，GitHub 汇入没有来源标记。

| 场景 | Before | After |
| --- | --- | --- |
| 桌面浅色 · 讨论待审阅 | `docs/evidence/m4-before-desktop-light-discuss.png` | `docs/evidence/m4-after-desktop-light-discuss.png` |
| 桌面浅色 · 已停止 + 详情 | `docs/evidence/m4-before-desktop-light-stopped-details.png` | `docs/evidence/m4-after-desktop-light-stopped-details.png` |
| 桌面深色 · GitHub 汇入 | `docs/evidence/m4-before-desktop-dark-github.png` | `docs/evidence/m4-after-desktop-dark-github.png` |
| 手机浅色 · 执行中 | `docs/evidence/m4-before-mobile-light-running.png` | `docs/evidence/m4-after-mobile-light-running.png` |

DOM 断言（Playwright）：After 讨论页有 1 个“按此方案开始执行”按钮；After 停止详情含
“停止证据”“PID 40127”“剩余后台作业 0”与“继续”；After GitHub 页含“GitHub 汇入 · github:42”；
标题/阶段/操作按钮在 1440×900 与 390×844 均无横向溢出；Before 上述 M4 控件均不存在。

## 迁移与回滚

- 下一次迁移：`packages/db/migrations/0005_colossal_brood.sql`；快照 `prevId = a4604b87-e7fd-4935-bf5d-1e22bee9a36d`，`idx: 5`。
- 回滚：`packages/db/migrations/rollback/0005_colossal_brood.down.sql`，需要 `-v hash=<sha256 of 0005_colossal_brood.sql>`；只在 0005 是最后一条迁移时执行，删除 M4 表/列/枚举并保留 conversation/task/message 行。集成测试已实测。
- 生产库 `moyu` 未连接、未迁移；0004/0005 上线由所有者另行审阅。

## 未验证项

- PR #4 的关闭未被 runtime 在 3 分钟内投影；同一账号关闭 PR #3 时已正确投影。该差异未定位，未声称已解决。
- 0011 的「不重开已关闭 PR」指示未在 live 实例重跑（实例运行 0009 构建）；上游定向测试通过。
- 平台对 `closed_unmerged`、消息拒绝与不自动重开的集成测试已通过。
- GitHub @ 入口的真实人类事件未取得（测试身份限制），`ticket.imported` 的真实 Bridge→平台链路未跑；上游桥接测试与平台集成测试覆盖。
- 上游唯一失败仍是既有 Feishu 可选测试。
- 本机 Node 22.23.3 与 `.node-version` 24.22.2 不同；CI 的 Node 24 检查由 PR 触发，未在本机复现。


## 暂停/继续的异常与修复

- 首轮 resume 在 `stopped` 刚出现时返回 `409 Another task command is still being processed`。原因是 Bridge 的
  `ticket.paused` 投影与平台 operation 轮询分别落库：任务已显示 stopped，而 pause operation 仍是 running。
  已修复（`apps/dispatcher/src/sync.ts`）：收到带 `stoppedAt` 的 `ticket.paused` 时，同事务把该任务的 active pause
  operation 置为 succeeded；集成测试覆盖，重试 resume 成功。
- 续跑 PR #4 时，resume 的 worker 在发现 PR 被关闭后执行了 `gh pr reopen`。平台自身不会自动重开，但 worker 的
  自主行为违反了「不自动重开」的意图。新增补丁 `0011` 在 resume/start 指示中明确禁止重开已关闭未合并的 PR；
  该补丁未在本轮 live 重跑（当前实例仍是 0009 构建），列为未验证项。
- PR #4 随后由同一 agent 账号关闭，但 3 分钟内 runtime 未投影 `closed`，平台保持 `awaiting_review`；同一账号关闭
  PR #3 时曾正确投影 `closed_unmerged`。差异未在剩余时间内定位，不声称已解决；上游 `sameName` 过滤与 PR 读取路径
  需要下一次真实人工关闭事件复核。
