# M4-UX 验证记录

日期：2026-11-04。范围：Issue #23 与 [`M4-UX.md`](M4-UX.md)。只记录实际执行过的命令与结果；
未执行项单列在 §未验证项。

## 验证环境

| 项 | 值 |
| --- | --- |
| 基线 | `origin/main` = `40e857a9081b281fb3a93ebaea6986e0101f005d` |
| 分支 | `agent/history-drafts-ux-fbd94c1fbe39` |
| 宿主 | Ubuntu 24.04.2 LTS，4 vCPU / 16 GB |
| 构建运行时 | Node 24.22.2（`/opt/moyu-node24/bin`，与 CI `.node-version` 一致）；宿主默认 22.23.3，pnpm 11.7.0（corepack） |
| PostgreSQL | 16.15；所有集成测试与浏览器验收使用 `127.0.0.1:55432` 的一次性库；生产库 `moyu` 未连接、未迁移 |
| 浏览器 | Playwright 1.56.1 Chromium headless，1440×900 / 390×844，浅色与深色 |
| 平台 | 本分支构建产物 `apps/api/dist/server.js` 与 `apps/web/dist`，隔离端口 4400 |
| Before | 独立 detached worktree `/root/src/m4ux-before` 构建的基线 `40e857a`，隔离端口 4401 |
| 上游 | 固定 `6337fc823ce20251c8de8085948165c81aaa701e`，补丁 `0001`–`0021` |

## 自动化检查

```bash
corepack pnpm@11.7.0 exec eslint .                       # exit 0
corepack pnpm@11.7.0 exec prettier --check "**/*.{ts,tsx,mjs,cjs,json,yml,yaml,css,html}"  # exit 0
corepack pnpm@11.7.0 -r --if-present typecheck            # exit 0
corepack pnpm@11.7.0 -r --if-present test                 # exit 0
node --test scripts/m3/guard.test.mjs integrations/superagent/tests/verify-lock.test.mjs  # 15/15 pass
corepack pnpm@11.7.0 -r --if-present build                # exit 0
```

单元测试：API 3 文件 20 通过（含 6 个游标测试）、dispatcher 3 通过、runtime-client 通过。

真实 PostgreSQL 集成测试（`TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres`）：

| 包 | 结果 |
| --- | --- |
| `@moyu/db` | 8 文件、34 测试通过（含 0009 rollback → reapply） |
| `@moyu/api` | 10 文件、60 测试通过（含历史/任务分页、偏好、合并别名发送路径、单条消息投递刷新） |
| `@moyu/dispatcher` | 2 文件、27 测试通过（M4 停止/继续、投递/read、GitHub 导入回归） |

并发合并回归：`conversation-merge.integration.test.ts` 的「相同 clientMessageId 并发重试」连续 15 次
单独运行全部通过（修复前 CI 曾出现 202/409 的假冲突；现会话与任务改为单条 join 读取，避免并发合并
删除源任务时读到“已合并但无任务”的中间态）。

### 返修轮 P1 回归（2026-11-04）

针对 Issue #23 审查意见一次补齐，先建立可失败用例再修复：

| 审查项 | 修复 | 回归证据 |
| --- | --- | --- |
| 已加载消息的 delivered/read 不随 SSE 刷新 | `message.delivery_changed` 按 event.messageId 调用单条消息接口并原地替换；新消息仍走 `after` 追赶 | 真实 dispatcher（stored→delivered→read）+ 真实 SSE + 浏览器，页面不刷新 |
| 初次消息加载期间 SSE 被丢弃 | 记 dirty 与待刷新 id，首屏落地后按返回的 `newerCursor` 补查；切会话清空/隔离 | 拦截首屏 GET（服务端查询已执行）→ POST 消息并确认 SSE → 释放旧响应 → 最终 1 条且无重复 |
| 合并跳转使较新草稿滞留在隐藏源会话 | 合并回执把较新源草稿迁移到 target；target 已有草稿时拼接并提升版本，不覆盖任一段；迟到回执只在当前会话匹配时改输入 | 合并+编辑、目标已有草稿、合并+切会话、双会话同时发送+旧响应晚到 |
| 0021 未在真实 runtime 验收 | 独立 `/root/.dsh-m4ux` profile 加载固定 `/root/src/upstream/m4ux-final-verify`，真实 Bearer 与目标仓库分支；平台 API 保存/拒绝失效分支 | [`evidence/m4ux/runtime-evidence.json`](evidence/m4ux/runtime-evidence.json) |

分页测试覆盖：250 条消息中 3 条共享同一时间戳、逐页 limit=7 全量遍历、`before`/`after` 双向、
微秒精度时间戳、非法/跨会话/跨仓库游标 422、105 个会话分页与仓库隔离、乱序/迟到页由前端 token
丢弃（浏览器用例）。偏好测试覆盖：GET 默认值与 saved/effective、PUT 保存与刷新恢复、跨仓库隔离、
失效分支/模型 422 且不落库、分支能力缺失时 `unsupported`、运行时不可达 503、DELETE 重置、
旧任务冻结字段不变、创建时失效选择 422 / 运行时不可达仍可创建。

## 上游补丁 0021

新增 `integrations/superagent/patches/0021-bridge-branches.patch`（3 文件，+186/−2）：

- `capabilities.branches = true`；
- 只读 `GET /bridge/v1/branches`：100 条/页、最多 10 页、按名称排序、`hasMore`；
- CLI 失败 503、响应畸变 502、Bearer 鉴权与既有 Bridge 一致；
- 新测试 `tests/bridge-branches.spec.ts` 覆盖分页、上限、失败、鉴权与仓库限定路径。

```bash
# 干净 scratch tree：pristine + 0001–0020，再应用 0021
git apply --check 0021-bridge-branches.patch     # pass
# 定向测试（含 docs.spec）
vitest run tests/bridge-branches.spec.ts tests/bridge-control.spec.ts tests/bridge.spec.ts tests/docs.spec.ts
# 4 files, 58 passed

integrations/superagent/build-patched.sh \
  /root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2 \
  /root/src/upstream/m4ux-final-verify
# 21 patches applied, typecheck + build pass
```

最终上游制品：

| 文件 | sha256 |
| --- | --- |
| `lib/index.js` | `7655a8809e3d1ddf064da82bd80fab566adaa3a54a0b88efaa661b903b1debdc` |
| `package.json` | `d428e669805ea1dfb6a4900bddbffe3cafb8f06a0b1eb139266c2b2f6b94b021` |
| `cordis.patch.yml` | `c91fab94d3a27c7068b5f5391907fb4d69342112ad50f987fdfed9985c2c7905` |

## 独立 runtime 的 0021 验收

固定制品 `/root/src/upstream/m4ux-final-verify`（pristine + 0001–0021）在全新独立 DSH profile
`/root/.dsh-m4ux-fresh4`、独立端口 3399（Bridge）/3400（Web）、独立状态目录与一次性 PostgreSQL 中
启动；未重启、未改动生产 3082 实例与生产数据库。

```bash
M4UX_DSH_HOME=/root/.dsh-m4ux-fresh4 M4UX_RUNTIME_BRIDGE_PORT=3399 \
M4UX_RUNTIME_WEB_PORT=3400 M4UX_PLATFORM_PORT=4407 \
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  node scripts/m4ux/runtime-evidence.mjs
# 脚本创建 profile、安装固定制品、启动 runtime、通过管理 API 配置 GitHub Source，
# 再用一次性平台库验收分支与偏好；--reuse-runtime 可复用已启动的隔离实例
```

实测：

- 无 Bearer → 401；`capabilities.branches = true`；`upstream.commit =
  6337fc823ce20251c8de8085948165c81aaa701e`。
- `GET /bridge/v1/branches` 返回真实目标仓库分支（`main` 与
  `agent/add-human-probe-line-ce16cfe5cc44`，2 条，`hasMore:false`）。
- 平台 API 指向该 Bridge 后：分支目录 `status:'ready'`；保存 `main`/execute 成功并刷新恢复；
  选择不存在的分支返回 422，消息为 `The base branch no longer exists: …`，不落库。
- 制品 sha256 与请求/响应摘要见 [`evidence/m4ux/runtime-evidence.json`](evidence/m4ux/runtime-evidence.json)。

## 真实浏览器验收

命令：

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  node scripts/m4ux/e2e.mjs --skip-build
```

结果：**17/17 通过**，JSON 在 [`evidence/m4ux/m4ux-e2e.json`](evidence/m4ux/m4ux-e2e.json)。脚本使用一次性
PostgreSQL、真实 API 进程、真实 Chromium 与基线/分支两份真实构建；Before 由 `/root/src/m4ux-before`
的 `40e857a` 构建产生，After 为本分支构建，两者同一数据库、同一视口、主题与场景。

| 用例 | 断言 |
| --- | --- |
| 消息历史分页 | 首屏 100；逐页加载到 250；页数终止；250 个消息 id 唯一；滚动前后锚点行位置差 ≤2px |
| 迟到旧页 | 切换会话后释放上一会话的 `before` 请求，新列表仍为 100 条，无污染 |
| SSE 合并 | 已加载 250 条后 SSE 追加 1 条，得到 251 条且无重复，前 50 条历史仍在 |
| 投递/read 就地刷新 | 打开仓库 B 的 stored 消息，真实 dispatcher 推进 delivered/read，SSE 到达后同一行改为“执行器已接收/已读取”，无刷新 |
| 初次加载窗口 SSE | 首屏查询完成后 hold 响应，POST 新消息并收到 SSE，再释放旧响应；新消息最终可见且只 1 条 |
| 合并草稿迁移 | 新 Web 会话首条发送 GitHub 需求 URL 期间继续编辑，跳转 target 后草稿仍在；刷新仍恢复 |
| 合并保留目标草稿 | target 已有草稿时，合并后的 target 同时包含两段文本，没有覆盖 |
| 合并+切会话 | 合并请求在途时切到历史并输入，迟到回执不改当前输入；目标草稿仍可恢复 |
| 双会话并发+晚到响应 | 普通会话与合并会话同时发送，先释放合并、后释放普通；target 草稿保持，普通消息只入库 1 条 |
| 任务列表分页 | 50 → 100 → 124，120 个历史任务全部可达；切仓库只剩该仓库任务；切回恢复 50 条与游标 |
| 草稿隔离/恢复/清除 | 会话 B 草稿刷新恢复；会话 A 为空；仓库 B 为空；切回各自恢复；“清除草稿”后刷新为空 |
| 发送中继续编辑 | 成功响应后保留新编辑文本，刷新仍在新草稿；原文只入库 1 条 |
| 发送中切会话 | 晚到响应不清空新会话输入；请求落在原会话；新会话无该消息 |
| 响应丢失重试 | 首次 202 后人为丢弃响应，重试复用同一 `clientMessageId`，库中只有 1 条 |
| 偏好 | 默认值展示；保存 release/模型/high/先讨论；刷新恢复；仓库 B 隔离；删除 release 后提示“已不存在”并禁用创建；模型移除后提示不可用并禁用；分支能力缺失时保存仍可用；旧任务冻结分支仍为 main |
| M4 回归与文案 | 已停止任务仍可“继续”并显示 PID 40127 停止证据；GitHub 任务显示 `GitHub 汇入 · github:42`；`已读取` 投递证据仍渲染；无“M4 接入”旧文案，添加仓库按钮说明 M5 且禁用 |

截图（Before/After 成对，基线标识见下）：

| 场景 | Before | After |
| --- | --- | --- |
| 桌面浅色 · 历史分页 | `m4ux-before-desktop-light-history.png` | `m4ux-after-desktop-light-history.png` |
| 桌面浅色 · 本次实际配置 | `m4ux-before-desktop-light-new-task.png` | `m4ux-after-desktop-light-new-task.png` |
| 桌面浅色 · 刷新后草稿 | `m4ux-before-desktop-light-draft.png` | `m4ux-after-desktop-light-draft.png` |
| 桌面深色 · 新建任务 | `m4ux-before-desktop-dark-new-task.png` | `m4ux-after-desktop-dark-new-task.png` |
| 手机浅色 390×844 · 历史 | `m4ux-before-mobile-light-history.png` | `m4ux-after-mobile-light-history.png` |

Before 为 `origin/main` @ `40e857a` 的真实构建，After 为 `docs/evidence/m4ux/m4ux-e2e.json` 记录的
本分支构建。Before 历史页无“加载更早消息”，新任务页无“本次创建实际配置/保存为默认”，刷新后草稿为空。

平台构建制品（本分支）：

| 文件 | sha256 |
| --- | --- |
| `apps/api/dist/server.js` | `3774fec8537a82513c5f4706f4f78ab4dc47fc2dea4a532f03aba059d6080c4a` |
| `apps/web/dist/index.html` | `24b256d19a6b00ff3849cbfc498bf0383f972a8a32e2fda3ca04f6dba31f6fac` |
| `apps/web/dist/assets/index-CBlITEPY.js` | `5c4bb4a70681481540c3d6e75d0914713fd6dbf2d6a526c21f8ed390f4f53134` |

## 迁移与回滚

- 最新迁移：`packages/db/migrations/0009_far_typhoid_mary.sql`，`idx: 9`，`prevId` 为 0008；
  新增 `repository_preferences` 表与 `messages_conversation_created_id_idx` 索引。
- 回滚：`packages/db/migrations/rollback/0009_far_typhoid_mary.down.sql`，要求传入 0009 文件的
  sha256 `d6c25e128e03bf6286eaa8eb701dd572a063a75a4ebcceea40b2648dfaa8e29f`，且 0009 必须是最后一条
  已应用迁移。真实 PostgreSQL 测试验证：回滚删除表/索引与恰好一条 ledger，reapply 恢复；错误/缺失/
  非最新 hash 均拒绝且状态不变。
- 0005/0006/0008 既有回滚测试已按新最新迁移调整（0008 从只应用到 0008 的库开始），全部通过。
- 生产库 `moyu` 未连接、未迁移；上线由所有者另审。

## 未验证项

- 上游完整测试套件未在 0021 之后重跑；只跑了 `bridge-branches`、`bridge-control`、`bridge`、
  `docs` 共 58 个用例。M4 记录的既有 Feishu 可选失败仍是上游已知项。
- 浏览器为 Playwright Chromium headless 的桌面/手机视口，不是物理手机或真实设备；截图是真实
  页面产物，不是静态 mock。
- 未新增真实执行链路（任务投递→worker→PR）验证；M4 执行的 UI 回归来自种子数据，投递/read
  由真实 dispatcher 与 SSE 驱动，停止/继续、GitHub 导入的链路回归由 dispatcher/API 集成测试覆盖。
- 独立 runtime 只验证分支/偏好路径，不接收真实执行任务；未在物理手机/平板上验收。
- 预览/资源预算、网页添加仓库、实例调度与 M5 范围未实现；界面只如实说明。
