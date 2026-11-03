# M3「单仓库消息闭环」验证记录

日期：2026-11-03。范围：`docs/DEVELOPMENT-GUIDE.md` 第 3 阶段与 Issue #9 的 M3 验收。只记录实际执行过的命令与结果；未执行项单列。

## 验证环境

| 项 | 值 |
| --- | --- |
| 宿主 | Ubuntu 24.04.2 LTS，4 vCPU / 16 GB，隔离实例与平台同机 |
| 构建运行时 | Node 22.23.3（宿主已有；CI 按 `.node-version` 24.22.2），pnpm 11.7.0（corepack） |
| PostgreSQL | 16.15，系统实例 `127.0.0.1:5432`；每次验收创建临时库并在结束时删除 |
| 平台 | 构建产物 `apps/api/dist/server.js` + `apps/dispatcher/dist/main.js`，隔离端口 4301 |
| 被测 runtime | 独立 `DSH_HOME=/root/.dsh-m3`、profile `m3`、state `/root/.dsh-m3/state/m3`、Web 3192、Bridge 3191；上游固定 commit `6337fc823ce20251c8de8085948165c81aaa701e` + 三个有序补丁 |
| 测试仓库 | 私有 `Bouyer12/m3-loop-final-68fa5d90`，基线 commit `7d1fa6924dae34319a9fe83491e8f277b7959851` |
| bootstrap | 3082 未重启、未改配置、未替换 runtime；4300 线上实例未改动 |
| 浏览器 | Playwright 1.56.1 Chromium，1440×900 / 390×844，浅色 |

E2E 浏览器登录使用隔离测试库预置的会话 Cookie，只用于验证 M3 消息闭环；Passkey 的真实浏览器流程由 M2 验收覆盖。本次没有使用硬件密钥。

## 上游补丁与构建

```bash
integrations/superagent/build-patched.sh /root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2 /root/src/m3-upstream-work/out
# exit 0
```

- 三个补丁按序 `git apply --check` / `git apply`：`0001-workspace-source.patch`、`0002-machine-bridge.patch`、`0003-ticket-freeze.patch`；补丁失败即停止，不做模糊套用。
- 在干净环境用固定 Node/pnpm 运行：`pnpm typecheck` exit 0、`pnpm build` exit 0，产物包含 `lib/workspace-watch.js` 与 `lib/index.js`。
- 上游新增/受影响测试 246 通过；完整套件 1229 通过 / 1 失败，唯一失败是 M0 已记录的 Feishu `sources.spec.ts` 可选测试（在 pristine 上同样失败），与 M3 路径无关。
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
# exit 0：db 10、api 17、dispatcher 2，全部在真实 PostgreSQL 上
```

集成测试覆盖：迁移与 M3 唯一索引、消息+delivery 同事务、同一 `clientMessageId` 并发（8 路，1×202 + 7×200、1 条消息/1 条 delivery）、不同 payload 409、会话 `clientRequestId` 幂等/409、Channel 回调 `source_event_id` 幂等与首条回调补 Ticket 关联、跨 Ticket 409、dispatcher 503 重试使用同一 trigger id、Bridge 事件投影/游标/重复同步。

## 真实链路（隔离实例 + 私有测试仓库）

运行目录：[`docs/evidence/m3/run-2026-11-03T13-21-09-826Z`](evidence/m3/run-2026-11-03T13-21-09-826Z)；结果文件 `e2e-result.json` **19/19 通过**。命令：

```bash
set -a; . /root/.dsh-m3/env; set +a
export E2E_BRIDGE_TOKEN="$MOYU_BRIDGE_TOKEN" E2E_CALLBACK_TOKEN="$MOYU_PLATFORM_TOKEN"
export E2E_REPOSITORY=Bouyer12/m3-loop-final-68fa5d90
export E2E_BASELINE_WEB_DIST=/root/src/m3-before/apps/web/dist
export TEST_DATABASE_ADMIN_URL=postgres://moyu:moyu_test@127.0.0.1:5432/postgres
node scripts/m3/e2e.mjs
# exit 0；E2E completed
```

链路：

1. Playwright 在网页新建 Work 会话并发送任务（会话 `fd749c36-aa65-474f-86bd-1021886fb7e1`）。仓库、`main` 起点与模型由会话冻结。
2. 平台在**同一事务**写入 message + delivery；dispatcher 以 `workspace:<messageId>` 投递到 Bridge；Bridge 将 Trigger 入库，Superagent 接单。
3. 上游 Ticket `95faa6d62098ea25897debd3b62254fe`，冻结 `Bouyer12/m3-loop-final-68fa5d90@main@7d1fa69…` 与 `commandcode/deepseek/deepseek-v4.1-flash`（high）；worker 使用该模型。
4. Agent 通过平台提问 `README.md 第 5 行的 “teh” 要改成 “the” 还是 “this”？`，网页显示问题并回复 `用 'the'，只改 README，不用改 CHANGELOG。`。
5. worker 只修改 `README.md`，运行 `npm test`（`README.md copy check passed`），推送 `agent/fix-readme-typo-95faa6d62098` 并创建
   [测试 PR #1](https://github.com/Bouyer12/m3-loop-final-68fa5d90/pull/1)；平台显示 `awaiting_review` 与 PR 链接。
6. 上游 Ticket 的三个 trigger input 都记录了 `readAt`（运行后只读快照见 [`upstream-state-snapshot.json`](evidence/m3/upstream-state-snapshot.json)）；平台消息状态按证据推进：`stored` → `delivered`（Bridge `receive` 返回 `stored`）→ `read`（session `user/message` + `Ticket.inputs[].readAt`）。

## 截图

Before 为 `main` @ `b08f36d` 的真实 M2 构建，经同一个隔离 API/数据库、同一 Playwright、视口与主题采集；After 为本分支构建。证据说明见 [`docs/evidence/m3/README.md`](evidence/m3/README.md)。

- `before-desktop-light.png` / `after-desktop-light.png`（1440×900）
- `before-mobile-light.png` / `after-mobile-light.png`（390×844）
- `after-question-light.png`（等待回复）
- `after-review-light.png`（PR 交付）

## 幂等、重试、重启与 SSE

| 检查 | 结果 |
| --- | --- |
| 同一 `clientMessageId` 并发 5 次 | 5 个成功响应；数据库 1 条 message、1 条 delivery；上游 1 个 Trigger；无新 Ticket |
| 同一 `clientRequestId` 相同/不同 payload | 相同返回原会话；不同 409（API 集成测试） |
| 投递回执丢失 | 人为把已送达 delivery 改回 pending 并清空证据；dispatcher 用同一 trigger id 重投；Bridge duplicate；Trigger 仍 1、Ticket 不增加 |
| API 重启 | 停止 dispatcher → 接受消息 → 重启 API → 消息仍在 → 启动 dispatcher → 恰好投递一次（trigger count 1） |
| Bridge 重启 | 停止隔离实例 → 接受消息（delivery pending）→ 重启实例 → 恰好投递一次（trigger count 1） |
| SSE 断线重连 | 首连回放 19 个持久事件；带 `Last-Event-ID: 19` 重连补发 20、21；无重复、无缺口 |
| 幂等的数据库兜底 | `messages(conversation_id, client_message_id)`、`conversations(owner_id, client_request_id)`、`messages(conversation_id, source_event_id)`、`events(source, source_event_id)` 均为唯一索引；上游 Trigger 主键与 Bridge 事件 id 去重 |

## 验收对照（Issue #9）

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 固定版本源码实现 Workspace Source 与私有机器 Bridge | 完成 | 三个有序补丁；loopback Bridge、Bearer、capabilities/models/triggers/events/tickets；证据文档 |
| Work 会话创建、消息与待投递同事务写入 | 完成 | API 集成测试；`e2e-result.json` |
| Bridge 投递、Trigger 接收、Ticket 关联 | 完成 | 真实链路 + Ticket `95faa6d6…` |
| Channel 回复 | 完成 | ack、问题、回复均经 `POST /api/internal/v1/runtime-events` 落库；重复回调幂等 |
| SSE 持久事件流与断线补齐 | 完成 | 19 个回放事件 + `Last-Event-ID` 补齐 20、21 |
| 冻结仓库、分支起点与所选模型 | 完成 | 会话/Ticket 冻结 `7d1fa69…` 与指定模型；worker 使用同一模型；不可用模型 422 不回退 |
| 模型从 Harness 已配置项选择 | 完成 | `GET /api/v1/repositories/:id/models` 经 Bridge 读取 `modelCatalog()`；无密钥 |
| 消息状态区分平台收件/执行器接收/实际读取 | 完成 | `stored`/`delivered`/`read` 映射与证据；HTTP 202、Bridge 200 不推进到 read |
| 真实链路：网页提交任务→接单→Agent 提问→网页回复→执行验证→交付 PR | 完成 | `e2e-result.json` 前 6 项；测试 PR #1 |
| 重发同一 `clientMessageId` 不重复接单 | 完成 | 并发 5 次 + 唯一索引；上游 Trigger 1、Ticket 1 |
| 投递/回执丢失后的重试 | 完成 | 503 重试与强制 pending 重投；同一 trigger id、上游去重 |
| API 与 Bridge 各自重启后消息不丢失、不重复投递 | 完成 | 两项运行检查均通过 |
| 运行验证使用隔离实例和测试仓库，计入同机资源预算 | 完成（资源测量除外） | 独立 DSH_HOME/profile/state/端口 3192/3191、私有测试仓库；未做 M5 的 6/8 GB 压力测量 |
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

- 新增迁移：`packages/db/migrations/0002_wild_prima.sql`。新增 `runtime_cursors` 表；`messages` 增加 `kind`、`source_event_id`；`deliveries` 增加 `upstream_trigger_id`、`delivered_at`、`handed_to_worker_at`、`read_at`、`last_attempt_at`、`evidence`；`conversations` 增加 `title`、`client_request_id`、`request_fingerprint`、`model_reasoning_effort`；`task_links` 增加 `question`、`question_message_id`、`pr_url`、`pr_number`、`last_event_seq`、`model_reasoning_effort`；`repositories` 增加 `bridge_url`、`bridge_credential_ref`；新增唯一索引 `conversations_owner_client_request_uq`、`messages_conversation_source_event_uq`。
- 回滚：先停止 API/dispatcher，`DROP TABLE runtime_cursors`、删除新增列与两个唯一索引（或从备份恢复）；旧版本代码忽略新增列。上游补丁回滚：停止隔离实例，删除三个 patch 与 `integrations/superagent/build`，重新构建 pristine bundle；不原地替换已部署目录。
- 部署配置：`BRIDGE_REPOSITORY`、`BRIDGE_URL`、`BRIDGE_TOKEN`、`BRIDGE_CALLBACK_TOKEN`；实例 env `MOYU_PLATFORM_URL`、`MOYU_PLATFORM_TOKEN`、`MOYU_BRIDGE_TOKEN`、`MOYU_BRIDGE_PORT`。令牌不写入仓库/数据库。

## 复核入口

- [`docs/M3-BRIDGE-PROTOCOL.md`](M3-BRIDGE-PROTOCOL.md)：机器协议与状态映射
- [`integrations/superagent/patches/`](../integrations/superagent/patches/) 与 [`build-patched.sh`](../integrations/superagent/build-patched.sh)
- [`docs/evidence/m3/`](evidence/m3/)：截图、日志、`e2e-result.json`
- [`scripts/m3/e2e.mjs`](../scripts/m3/e2e.mjs)：可复现的隔离 E2E
