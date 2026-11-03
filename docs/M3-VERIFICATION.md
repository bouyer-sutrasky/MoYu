# M3「单仓库消息闭环」验证记录

日期：2026-11-03（第三轮复审修订）。范围：`docs/DEVELOPMENT-GUIDE.md` 第 3 阶段与 Issue #9 的 M3 验收。只记录实际执行过的命令与结果；未执行项单列。

## 验证环境

| 项 | 值 |
| --- | --- |
| 宿主 | Ubuntu 24.04.2 LTS，4 vCPU / 16 GB，隔离实例与平台同机 |
| 构建运行时 | Node 22.23.3（宿主已有；CI 按 `.node-version` 24.22.2），pnpm 11.7.0（corepack） |
| PostgreSQL | 16.15，系统实例 `127.0.0.1:5432`；每次验收创建临时库并在结束时删除 |
| 平台 | 构建产物 `apps/api/dist/server.js` + `apps/dispatcher/dist/main.js`，隔离端口 4301 |
| 被测 runtime | 独立 `DSH_HOME=/root/.dsh-m3`、profile `m3`、state `/root/.dsh-m3/state/m3`、Web 3192、Bridge 3191；上游固定 commit `6337fc823ce20251c8de8085948165c81aaa701e` + 三个有序补丁 |
| 测试仓库 | 私有 `Bouyer12/m3-loop-r3-68fa5d90`，基线 commit `bad7eac5174a3090078cbf687e76c41af1dc1b98` |
| bootstrap | 3082 未重启、未改配置、未替换 runtime；4300 线上实例未改动 |
| 浏览器 | Playwright 1.56.1 Chromium，1440×900 / 390×844，浅色 |

E2E 浏览器登录使用隔离测试库预置的会话 Cookie，只用于验证 M3 消息闭环；Passkey 的真实浏览器流程由 M2 验收覆盖。本次没有使用硬件密钥。

## 上游补丁与构建

```bash
integrations/superagent/build-patched.sh /root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2 /root/src/m3-upstream-work/out
# exit 0
```

- 四个补丁按序 `git apply --check` / `git apply`：`0001-workspace-source.patch`、`0002-machine-bridge.patch`、`0003-ticket-freeze.patch`、`0004-bridge-duplicate-first-result.patch`；补丁失败即停止，不做模糊套用。
- 在干净环境用固定 Node/pnpm 运行：`pnpm typecheck` exit 0、`pnpm build` exit 0，产物包含 `lib/workspace-watch.js` 与 `lib/index.js`。
- 复审补丁的定向测试 20 个 Bridge 测试通过；完整套件 1231 通过 / 1 失败，唯一失败是 M0 已记录的 Feishu `sources.spec.ts` 可选测试（在 pristine 上同样失败），与 M3 路径无关。
- 证据与命令见 [`integrations/superagent/evidence/m3-upstream-build.md`](../integrations/superagent/evidence/m3-upstream-build.md)。

## 平台检查

```bash
corepack pnpm@11.7.0 -r typecheck
# exit 0，7 个 workspace 包

corepack pnpm@11.7.0 -r --if-present test
# exit 0：contracts 13、api 14、dispatcher 3、runtime-client 5

corepack pnpm@11.7.0 -r build
# exit 0：web / api / dispatcher

corepack pnpm@11.7.0 exec eslint .
corepack pnpm@11.7.0 exec prettier --check "**/*.{ts,tsx,mjs,cjs,json,yml,yaml,css,html}"
# 均 exit 0

TEST_DATABASE_ADMIN_URL=postgres://moyu:moyu_test@127.0.0.1:5432/postgres \
  corepack pnpm@11.7.0 --filter @moyu/db --filter @moyu/api --filter @moyu/dispatcher test:integration
# exit 0：db 10、api 18、dispatcher 4，全部在真实 PostgreSQL 上
```

集成测试覆盖：迁移与 M3 唯一索引、消息+delivery 同事务、同一 `clientMessageId` 并发（8 路，1×202 + 7×200、1 条消息/1 条 delivery）、不同 payload 409、会话 `clientRequestId` 幂等/409、Channel 回调 `source_event_id` 幂等与首条回调补 Ticket 关联、跨 Ticket 409、dispatcher 503 重试使用同一 trigger id、Bridge 事件投影/游标/重复同步，以及 SSE 在只有较晚事件唤醒时按序补读且真实 `Last-Event-ID` 重连不重复。

## 真实链路（隔离实例 + 私有测试仓库）

运行目录：[`docs/evidence/m3/run-2026-11-03T15-18-10-024Z`](evidence/m3/run-2026-11-03T15-18-10-024Z)；结果文件 `e2e-result.json` **24/24 通过**。命令：

```bash
set -a; . /root/.dsh-m3/env; set +a
export E2E_BRIDGE_TOKEN="$MOYU_BRIDGE_TOKEN" E2E_CALLBACK_TOKEN="$MOYU_PLATFORM_TOKEN"
export E2E_REPOSITORY=Bouyer12/m3-loop-r3-68fa5d90
export E2E_BASELINE_WEB_DIST=/root/src/m3-before/apps/web/dist
export TEST_DATABASE_ADMIN_URL=postgres://moyu:moyu_test@127.0.0.1:5432/postgres
node scripts/m3/e2e.mjs
# exit 0；E2E completed
```

链路：

1. Playwright 在网页新建 Work 会话并发送任务（会话 `61632ee0-eb4d-46df-a330-317f1eae189e`）。仓库、`main` 起点与模型由会话冻结。
2. 平台在**同一事务**写入 message + delivery；dispatcher 以 `workspace:<messageId>` 投递到 Bridge；Bridge 将 Trigger 入库，Superagent 接单。
3. 上游 Ticket `c46147d8c102515393b66a45e0145c4c`，冻结 `Bouyer12/m3-loop-r3-68fa5d90@main@bad7eac…` 与 `commandcode/deepseek/deepseek-v4.1-flash`（high）；worker 使用该模型。
4. Agent 通过平台提问 `README.md 第 5 行里的 “teh” 应改成 “the” 还是 “this”？…`，网页显示问题并回复 `用 'the'，只改 README，不用改 CHANGELOG。`。
5. worker 只修改 `README.md`，运行 `npm test`（`README.md copy check passed`），推送 `agent/fix-readme-typo-c46147d8c102` 并创建
   [测试 PR #1](https://github.com/Bouyer12/m3-loop-r3-68fa5d90/pull/1)；平台显示 `awaiting_review` 与 PR 链接。
6. 回复消息的 delivery 由 worker session 证据推进到 `read`（`readAt 2026-11-03T15:20:39.163Z`）；上游 Ticket 的三个 trigger input 都记录了 `readAt`（运行后只读快照见 [`upstream-state-snapshot.json`](evidence/m3/upstream-state-snapshot.json)）；平台消息状态按证据推进：`stored` → `delivered`（Bridge `receive` 返回 `stored`）→ `read`（session `user/message` + `Ticket.inputs[].readAt`）。

## 第三轮复审修复（基于 `7431dee` 复审意见）

- **filtered Trigger 重放**：上游 `0004` 在任何模型/分支校验前读取已持久化 Trigger；Store 有 filtered disposition 时返回 `filtered`（不是 `duplicate`）。上游回归与 dispatcher 回归（delivery `failed`、无 `delivered_at`/`read_at`、无 Ticket）均通过。
- **env 配置不可覆盖**：E2E 只解析一次 env 文件，拒绝白名单外的键（尤其 `DSH_HOME`/`DSH_PROFILE`），校验 `MOYU_PLATFORM_URL` 必须指向隔离 API、Bridge 端口一致且空闲，并拒绝与进程环境冲突的配置；启动环境只由校验后的 home 与 env 构造。测试证明 bootstrap home / 4300 会在创建 run 目录、清理、启动、重配之前退出。
- **符号链接越界**：guard 对 home、state/sessions 父目录、profile 做 `realpath` 校验，profile 只能是单一路径组件；临时目录构造 `state` 指向另一实例时 guard 拒绝且目标 `keep.txt` 保留。
- **早到 task.progress**：新增 `deferred_bridge_events` 表；未关联事件先持久化，`ticket.linked` 投影后在同一事务按序补投影并删除。dispatcher 回归覆盖“progress 先于 linked”，最终只投影一次，重放同一页不重复。
- **首次回执丢失整链路**：E2E 用 loopback 故障代理在 Bridge 已持久化后丢弃首个 trigger HTTP 响应，dispatcher 同 ID 重试；断言 1 个 Trigger、1 个 Ticket，平台与 Ticket 的冻结 SHA 一致。
- **记录修正**：验收表已改为本轮 Ticket/基线/SSE 游标；迁移回滚按 `hash` 用 down SQL 在临时库实测。

## 复审修复（基于 `a6d8004` 复审意见）

- **SSE 跳过事件**：`apps/api/src/routes/events.ts` 的 bus 只唤醒 `flush()`，不再直接写通知事件；`flush()` 从 events 表按 seq 读取，advisory lock 保证提交顺序。新增真实 PostgreSQL 回归
  `apps/api/test/integration/sse.integration.test.ts`：客户端停在第一行，数据库随后写入第二、三行，仅第三行触发通知；断言依次且仅一次收到第二、三行，并用真实 `Last-Event-ID` 重连只收到第三行。
- **重复 Trigger 返回首次结果**：新增有序补丁 `0004-bridge-duplicate-first-result.patch`；`POST /bridge/v1/triggers` 在模型/分支校验前读取 Store 中已持久化的 Trigger，返回首次 `baseCommit` 与 Ticket。回归测试覆盖“回执丢失后分支前进 + 原模型不可用”，断言仍只有一个 Trigger/Ticket、base 仍为首次值；E2E 强制 pending 重投也断言平台 base 不变。
- **隔离护栏**：`scripts/m3/guard.mjs` 在任何删除/重配前校验 DSH home/profile/端口/构建 marker/env 0600，启动后复核 panel `stateDir`；`node --test scripts/m3/guard.test.mjs` 用临时目录与占用端口验证拒绝路径。`build-patched.sh` 校验固定上游源清单，拒绝已存在输出目录；实测 existing output/patched source 均 exit 2。
- **断言收紧**：API/Bridge 重启后 Trigger 数均为 1；Bridge 停机期间从平台库断言 delivery 仍 pending 且 `delivered_at` 为空；SSE 断言顺序/完整性/重复；网页问题与 PR 链接改为硬等待；新增回复 `read` 证据检查。
- **迁移说明**：实际迁移为 `packages/db/migrations/0002_brief_war_machine.sql`；回滚步骤按 Drizzle `__drizzle_migrations` 记录删除迁移记录后重部署。
- **深色截图**：Before/After 的桌面/手机、浅色/深色，以及问题/PR 状态的深色图，均在最终运行目录。

## 截图

Before 为 `main` @ `b08f36d` 的真实 M2 构建，经同一个隔离 API/数据库、同一 Playwright、视口与主题采集；After 为本分支构建。证据说明见 [`docs/evidence/m3/README.md`](evidence/m3/README.md)。

- `before-desktop-light/dark.png` / `after-desktop-light/dark.png`（1440×900）
- `before-mobile-light/dark.png` / `after-mobile-light/dark.png`（390×844）
- `after-question-light/dark.png`（等待回复）
- `after-review-light/dark.png`（PR 交付）

## 幂等、重试、重启与 SSE

| 检查 | 结果 |
| --- | --- |
| 同一 `clientMessageId` 并发 5 次 | 5 个成功响应；数据库 1 条 message、1 条 delivery；上游 1 个 Trigger；无新 Ticket |
| 同一 Trigger 重投（回执丢失 + 分支前进 + 原模型移除） | 上游返回首次冻结 `baseCommit`/Ticket；仍 1 个 Trigger、1 个 Ticket；平台会话 base 不变；回归测试覆盖 |
| 同一 `clientRequestId` 相同/不同 payload | 相同返回原会话；不同 409（API 集成测试） |
| 投递回执丢失 | 人为把已送达 delivery 改回 pending 并清空证据；dispatcher 用同一 trigger id 重投；Bridge duplicate；Trigger 仍 1、Ticket 不增加 |
| API 重启 | 停止 dispatcher → 接受消息 → 重启 API → 消息仍在 → 启动 dispatcher → 恰好投递一次（断言 trigger count === 1） |
| Bridge 重启 | 停止隔离实例 → 接受消息（数据库断言 delivery 仍为 pending、delivered_at 为空）→ 重启实例 → 恰好投递一次（trigger count 1） |
| SSE 断线重连 | 首连回放 1–17（严格递增、不重复）；带 `Last-Event-ID: 17` 重连按序补发 18、19；无重复、无缺口，并包含本次消息事件 |
| 幂等的数据库兜底 | `messages(conversation_id, client_message_id)`、`conversations(owner_id, client_request_id)`、`messages(conversation_id, source_event_id)`、`events(source, source_event_id)` 均为唯一索引；上游 Trigger 主键与 Bridge 事件 id 去重 |

## 验收对照（Issue #9）

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 固定版本源码实现 Workspace Source 与私有机器 Bridge | 完成 | 三个有序补丁；loopback Bridge、Bearer、capabilities/models/triggers/events/tickets；证据文档 |
| Work 会话创建、消息与待投递同事务写入 | 完成 | API 集成测试；`e2e-result.json` |
| Bridge 投递、Trigger 接收、Ticket 关联 | 完成 | 真实链路 + Ticket `c46147d8…` |
| Channel 回复 | 完成 | ack、问题、回复均经 `POST /api/internal/v1/runtime-events` 落库；重复回调幂等 |
| SSE 持久事件流与断线补齐 | 完成 | 回放 1–17（严格递增、不重复）+ `Last-Event-ID: 17` 按序补齐 18、19 |
| 冻结仓库、分支起点与所选模型 | 完成 | 会话/Ticket 冻结 `bad7eac…` 与指定模型；worker 使用同一模型；不可用模型 422 不回退 |
| 模型从 Harness 已配置项选择 | 完成 | `GET /api/v1/repositories/:id/models` 经 Bridge 读取 `modelCatalog()`；无密钥 |
| 消息状态区分平台收件/执行器接收/实际读取 | 完成 | `stored`/`delivered`/`read` 映射与证据；HTTP 202、Bridge 200 不推进到 read |
| 真实链路：网页提交任务→接单→Agent 提问→网页回复→执行验证→交付 PR | 完成 | `e2e-result.json` 前 7 项（含 read 证据）；测试 PR #1 |
| 重发同一 `clientMessageId` 不重复接单 | 完成 | 并发 5 次 + 唯一索引；上游 Trigger 1、Ticket 1 |
| 投递/回执丢失后的重试 | 完成 | 503 重试与强制 pending 重投；同一 trigger id、上游去重；重复 Trigger 返回首次冻结 SHA |
| API 与 Bridge 各自重启后消息不丢失、不重复投递 | 完成 | 两项运行检查均通过 |
| 运行验证使用隔离实例和测试仓库，计入同机资源预算 | 完成（资源测量除外） | 独立 DSH_HOME/profile/state/端口 3192/3191、私有测试仓库；E2E 启动前校验目录/端口/profile 身份，build 只发布到新目录；未做 M5 的 6/8 GB 压力测量 |
| PR 附真实 Ticket、脱敏日志或测试 PR 等可核对证据 | 完成 | 本文件、`docs/evidence/m3/`、测试 PR #1 |
| 只完成 M3，不自行合并 | 完成 | 本 PR 未合并；未启用 auto-merge |

## 未验证项与已知限制

1. **真实设备 Passkey**：E2E 使用预置会话；M2 已覆盖虚拟认证器下的 Passkey 流程，真机绑定仍由所有者完成。
2. **长时与压力**：未做数小时消息流、Bridge 事件日志增长/压缩、模型限流长跑；`events.jsonl` 无压缩（M3 规模可接受）。
3. **资源预算**：未测量常态 4GB/6GB/8GB 与宿主 OOM；属于 M5。
4. **多仓库/多实例**：M3 只绑定一个仓库与一个 Bridge；同仓库租约、多实例隔离属于 M5。
5. **暂停/继续与讨论**：`pause/resume/retry` 返回 501，`discuss` 创建返回 422；属于 M4。
6. **附件、diff/检查面板、系统通知、GitHub 入口**：属于 M4/M6。
7. **供应商瞬时错误**：本次运行出现模型供应商 `TRANSPORT` 重试（DSH 自动恢复）；不是平台重试逻辑的证据。
8. **平台机器令牌**：由部署环境注入，未写入仓库/数据库；仓库只保存引用名。隔离实例的令牌只存在于 `/root/.dsh-m3/env`（0600），不在本 PR。
9. **E2E 脚本**：只在本机隔离端口与私有仓库运行，未加入共享 CI（依赖隔离 DSH 实例与测试仓库）。
10. **测试仓库**：私有，审阅者可能无权打开；PR #1 URL 与脱敏日志为持久证据。

## 迁移与回滚

- 新增迁移：`packages/db/migrations/0002_brief_war_machine.sql` 与 `0003_robust_the_renegades.sql`（`deferred_bridge_events`，保存先于 Ticket 关联到达的 Bridge 事件）。新增 `runtime_cursors` 表；`messages` 增加 `kind`、`source_event_id`；`deliveries` 增加 `upstream_trigger_id`、`delivered_at`、`handed_to_worker_at`、`read_at`、`last_attempt_at`、`evidence`；`conversations` 增加 `title`、`client_request_id`、`request_fingerprint`、`model_reasoning_effort`；`task_links` 增加 `question`、`question_message_id`、`pr_url`、`pr_number`、`last_event_seq`、`model_reasoning_effort`；`repositories` 增加 `bridge_url`、`bridge_credential_ref`；新增唯一索引 `conversations_owner_client_request_uq`、`messages_conversation_source_event_uq`。
- 回滚（已在临时库实测）：先停止 API/dispatcher，按 SHA-256 与 Drizzle 记录核对迁移：

  ```bash
  psql "$DATABASE_URL" -c "select id, hash, created_at from drizzle.__drizzle_migrations order by created_at"
  sha256sum packages/db/migrations/0003_robust_the_renegades.sql \
            packages/db/migrations/0002_brief_war_machine.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -v hash="$(sha256sum packages/db/migrations/0003_robust_the_renegades.sql | cut -d' ' -f1)" \
    -f packages/db/migrations/rollback/0003_robust_the_renegades.down.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -v hash="$(sha256sum packages/db/migrations/0002_brief_war_machine.sql | cut -d' ' -f1)" \
    -f packages/db/migrations/rollback/0002_brief_war_machine.down.sql
  ```

  实测结果：回滚后 `runtime_cursors`/`deferred_bridge_events` 不存在、M3 列已删除、迁移记录回到 2 条；重新执行 `db:migrate` 成功、表与记录恢复。没有可用备份时按上述 SQL 回滚；有备份时按备份恢复。旧版本代码忽略新增列。上游补丁回滚：停止隔离实例，删除四个 patch 与 `integrations/superagent/build`，重新构建 pristine bundle；不原地替换已部署目录。
- 部署配置：`BRIDGE_REPOSITORY`、`BRIDGE_URL`、`BRIDGE_TOKEN`、`BRIDGE_CALLBACK_TOKEN`；实例 env `MOYU_PLATFORM_URL`、`MOYU_PLATFORM_TOKEN`、`MOYU_BRIDGE_TOKEN`、`MOYU_BRIDGE_PORT`。令牌不写入仓库/数据库。

## 复核入口

- [`docs/M3-BRIDGE-PROTOCOL.md`](M3-BRIDGE-PROTOCOL.md)：机器协议与状态映射
- [`integrations/superagent/patches/`](../integrations/superagent/patches/) 与 [`build-patched.sh`](../integrations/superagent/build-patched.sh)
- [`docs/evidence/m3/`](evidence/m3/)：截图、日志、`e2e-result.json`
- [`scripts/m3/e2e.mjs`](../scripts/m3/e2e.mjs)：可复现的隔离 E2E
