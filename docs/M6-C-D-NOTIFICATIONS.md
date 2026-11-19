# M6-C D：手机浏览器通知调查与页面运行时兼容投递

> 状态：**代码修复与浏览器模拟验收完成；真实手机未验，D 段真机矩阵保留待验。**
> 基线 `main`：`01896badaf64da1ae5a1f77bbf26b422b3933e16`（#84 合并）。
>
> 本文件记录 #85 的 D 段：先定位故障点，再在现有「页面仍打开」范围内实现兼容投递，
> 并给出真机待验项。没有真实手机，也没有把桌面无头浏览器或模拟器当作真机证据。

## 1. 结论

1. **故障点在通知创建，不在 SSE、权限或点击导航。** 页面通过 SSE 收到真实事件后，
   调用页面级 `new Notification(...)`。MDN 明确说明：该构造器在几乎所有移动浏览器
   中抛出 `TypeError`，移动端应注册 Service Worker 并使用
   [`ServiceWorkerRegistration.showNotification()`](https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification)。
   修复前代码只在页面级构造器上尝试一次，异常被记为 `error`，所以 Android Chrome
   等移动浏览器上「活动中心有事件、但系统通知不出现」。
2. **已实现页面仍运行时的兼容投递路径。** 页面注册 `apps/web/public/sw.js`；页面级
   构造器失败后改用 `registration.showNotification(...)`。通知点击由 Service Worker
   聚焦已有窗口并 `postMessage` 回页面，页面按仓库 + 会话原地路由；没有窗口时直接用
   可寻址 URL 打开新窗口。目标会话已失效时，沿用现有的 403/404 校验、回退和中文提示。
3. **拒绝授权或不支持系统通知时，站内能力不受影响。** 未读徽标、活动中心和会话
   刷新仍由同一持久事件驱动；浏览器模拟中三种结果都验证了未读 +1 和活动中心可见。
4. **页面关闭、系统回收或挂起后仍不会收到通知。** 当前没有服务端 Web Push：
   没有 `push` 订阅、没有 VAPID、没有 dispatcher 发送通道。Service Worker 本身不改变
   这一点；关闭页面后事件只写入持久活动记录，重新打开后可补看。需要关闭页面推送时
   应另行立项，不要把 Web Push 混入本段。
5. **真机矩阵未执行。** 本机没有可用的 Android 手机或 iPhone；因此 Android Chrome、
   iOS Safari、普通标签页与安装态的真实表现仍待所有者设备确认。

## 2. 故障定位与复现

### 2.1 环境

| 项 | 值 |
| --- | --- |
| 应用 | 本仓库分支 `agent/mobile-notifications-8fa6de58a343`；Before 为 `01896ba` 的独立 worktree |
| 数据库 | 隔离 PostgreSQL 16 `moyu_m6c_c_real`（`127.0.0.1:55432`），非生产库 |
| 会话/仓库 | 真实任务会话 `178ee9e7-2edb-494f-ae5c-beb1a8a7dadc`；仓库 `cccccccc-cccc-4ccc-8ccc-cccccccccccc` |
| 服务 | 隔离 API：After `127.0.0.1:3102`，Before `127.0.0.1:3103`；同一隔离数据库 |
| 浏览器 | Playwright 1.56.1 + Chromium 141，headed，Xvfb `:99`；390×844、Android 14 / Pixel 8 UA |
| 事件 | 通过真实 runtime callback `POST /api/internal/v1/runtime-events` 写入 `channel.message`，由 API 生成持久 `task.question` 事件并走 SSE，不是伪造前端 SSE 帧 |

### 2.2 移动浏览器行为模拟

测试在页面加载前替换 `Notification` 构造器：构造时按移动浏览器的实际行为抛出
`TypeError: Illegal constructor`，同时保留 `Notification.permission` 与
`requestPermission()`。这是**能力模拟**，不是真机证据；它用于在桌面 Chromium 中
复现「页面级构造器失败」这一已由 MDN 确认的移动端行为。

### 2.3 Before（`01896ba`）

| 观察项 | 结果 |
| --- | --- |
| Service Worker 注册 | 无（`getRegistrations()` 为空） |
| SSE 事件到达 | 是；活动中心出现该提醒，未读 `0 → 1` |
| 通知尝试 | `new Notification` 抛异常，`__moyuNotifyDebug.attempts` 记录 `error` |
| 系统通知 | 无（`getNotifications()` 为空，`showNotification` 调用 0 次） |
| 点击 | 无通知可点 |

### 2.4 After（本分支）

| 观察项 | 结果 |
| --- | --- |
| Service Worker 注册 | `http://127.0.0.1:3102/`，已激活 |
| SSE 事件到达 | 是；活动中心出现该提醒，未读 `0 → 1` |
| 通知尝试 | 页面级构造器只尝试 1 次并失败；随后 `delivered` 经 `service-worker` |
| 系统通知 | `getNotifications()` 返回 1 条，title/body/tag 正确，`data` 带仓库与会话 id |
| 点击定位 | 聚焦页面后原地路由到 `?repo=…&conversation=…`，面包屑显示正确仓库与会话 |
| 目标失效 | 会话不存在时地址规范化为只剩仓库，显示「要恢复的会话不存在或没有访问权限，已回到当前仓库。」 |
| 重复事件 | 刷新重放同一事件时记录 `duplicate`，不产生第二条通知 |
| 重连 | 断网再恢复后 SSE 重连，不重放已领取事件，不产生第二条通知 |

## 3. 修复

### 3.1 Service Worker（`apps/web/public/sw.js`）

- `install` 立即 `skipWaiting()`，`activate` 用 `clients.claim()` 接管；不缓存应用外壳，
  不注册 `fetch`。
- `notificationclick`：优先聚焦已有同源窗口并 `postMessage`
  `{ type: 'moyu:notification-open', repositoryId, conversationId }`；没有窗口时用
  `?repo=…&conversation=…` 打开新窗口。
- 数据只来自页面写入的通知 `data`；不读取 Cookie、Token 或其他凭据。

### 3.2 页面投递（`apps/web/src/lib/notifications.ts`）

- 启动时 `ensureNotificationServiceWorker()` 预注册并等待激活；失败不缓存，下一事件重试。
- `deliverWebNotification`：仍先尝试页面级构造器（桌面路径不变）；构造失败后改走
  `registration.showNotification(...)`。两条路径都失败时才记录 `error`。
- 若两条路径都失败，释放事件去重 claim，避免一次瞬时失败把同一持久事件压 7 天。
- `window.__moyuNotifyDebug` 现在由页面初始化为有界记录（最多 100 条），包含尝试结果
  和实际投递路径（`window` / `service-worker`），供真机排查使用；只保存在内存。

### 3.3 页面路由（`apps/web/src/shell/WorkspaceShell.tsx`）

- 监听 `navigator.serviceWorker` 的 `message`，收到点击消息后关闭设置、活动与历史面板，
  按仓库 + 会话原地路由。
- 通知点击不再直接把会话 id 塞进选中态；统一交给地址恢复 effect 先做
  `GET /api/v1/conversations/:id` 校验。这样失效目标不会被误打开，而是走既有的
  403/404 回退和中文提示。该缺陷是 D 段复测中实际发现并修复的。

### 3.4 测试

- `apps/web/src/lib/serviceWorker.test.mjs`：在 Node VM 中加载真实 `sw.js`，覆盖安装/
  激活、聚焦窗口、回退打开 URL、缺失 id 和 focus 失败。
- `apps/web/src/lib/notifications.test.mjs`：覆盖 unsupported、no-category、disabled、
  background-only、no-permission、页面级投递与点击、移动端构造器失败后的 Service
  Worker 投递、投递失败后的 claim 释放与重试。
- `pnpm --filter @moyu/web test`：16 个测试通过。

## 4. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @moyu/web test` | 通过，16 tests（`web-test.txt`） |
| `pnpm check` | 通过（lint/format/typecheck/unit tests，`check.txt`） |
| `pnpm build` | 通过，Web 产物包含 `/sw.js`（`build.txt`） |
| `TEST_DATABASE_ADMIN_URL=postgres://moyu:x@127.0.0.1:55432/postgres pnpm test:integration` | 通过：db 17 files/54，api 18/133，dispatcher 19/100（1 skipped），supervisor 1/4（`integration.txt`） |
| 浏览器 Before 场景 | `before-mobile-result.json`，`ok: true`，结果 `error` |
| 浏览器 After 场景 | `after-mobile-result.json`，`ok: true`，结果 `delivered` + Service Worker |
| 拒绝授权 | `denied-denied-result.json`，`ok: true`，结果 `no-permission` |
| 不支持通知 | `unsupported-unsupported-result.json`，`ok: true`，结果 `unsupported` |
| 页面关闭 | `closed-page.json`：事件进入活动中心，`getNotifications()` 为空 |

复现命令（需要隔离 API、测试会话 cookie、runtime callback token 和 Xvfb；token 不写进仓库）：

```bash
DISPLAY=:99 M6C_RUNTIME_CALLBACK_TOKEN=... \
  node scripts/m6c/notifications-browser.mjs \
  --base-url http://127.0.0.1:3102 \
  --storage-state /tmp/storage.json \
  --repository <repository-uuid> --conversation <conversation-uuid> \
  --label after --mode mobile --expect delivered --out /tmp/evidence
```

Before 使用 `01896ba` 的独立 worktree 构建产物和 `--expect error`；拒绝授权/不支持分别用
`--mode denied --expect no-permission` 与 `--mode unsupported --expect unsupported`。

## 5. 真机矩阵（未执行）

本机没有可用真机，以下行全部为待验；不得用桌面 Chromium、移动 UA 或能力模拟替代。

| 设备 / 系统 | 浏览器 / 安装态 | 权限 | 页面前台/后台 | 事件到达 | 系统通知 | 点击定位 | 站内回退 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Android 手机（待定，Android 14+） | Chrome 普通标签页 | granted | 前台 / 切后台 | 待验 | 待验 | 待验 | 待验 | 缺设备 |
| 同上 | Chrome 添加到主屏幕（安装态） | granted | 前台 / 切后台 | 待验 | 待验 | 待验 | 待验 | 缺设备 |
| iPhone（待定，iOS 16.4+） | Safari 普通标签页 | 不适用/未授权 | 前台 / 切后台 | 待验 | 待验 | 待验 | 待验 | 缺设备 |
| 同上 | Safari 添加到主屏幕（PWA） | granted | 前台 / 切后台 | 待验 | 待验 | 待验 | 待验 | 缺设备 |

真机复测步骤：

1. 用真实任务事件（提问、审阅、完成、失败任一类）；记录事件 id、到达时间、活动中心
   是否出现、未读徽标变化，以及 `window.__moyuNotifyDebug.attempts/delivered`。
2. 分别记录普通标签页和安装态；记录系统与浏览器版本、权限状态、前台/切后台方式
   （仅切标签、锁屏、切到其他 App、停留数分钟后返回、完全关闭页面）。
3. 点击通知，确认回到正确仓库和会话；再构造一个已删除/无权限会话，确认回退提示。
4. 覆盖重复事件、SSE 断线重连、后台切回；确认不重复弹通知、未读不重复累计。
5. 页面完全关闭后重复步骤 1，确认是否收到通知；若期望收到，转第 6 节立项。

缺少的验收条件：Android 手机（Chrome）、iPhone（iOS 16.4+ Safari/PWA）、真实系统
通知中心、真实权限弹窗与真实点击。

## 6. 页面关闭后的能力缺口

当前 Service Worker 只负责「页面仍打开时」的显示与点击，没有 `push` 事件处理、没有
`PushManager.subscribe`、没有服务端发送。页面关闭、被系统回收或长时间挂起后 SSE 不再
存在，因此不可能产生通知；事件仍持久化在活动表，重新打开后可补看。

若产品要求关闭页面后推送，需要单独立项：VAPID 密钥、按 owner/设备的订阅持久化、
dispatcher 在写入持久事件时发送、410/404 失效订阅处理、重试与限流、iOS 主屏幕 PWA
要求（16.4+）以及「仅后台/总是」设置语义的重新定义。不要在本段静默扩大范围。

## 7. 未验与限制

- 没有真实 Android/iOS 设备，真机矩阵整体待验。
- 浏览器证据来自 headed Chromium + Xvfb，没有真实系统通知中心；通知存在性通过
  `ServiceWorkerRegistration.getNotifications()` 和页面调试记录验证，未截取系统通知
  弹窗（Xvfb 无通知守护进程）。
- 未验证 PWA 安装态、iOS 主屏幕 PWA、系统省电/后台冻结、真实移动网络和 HTTPS 域名。
- 未做生产发布、生产数据库或生产服务验证；未触碰 3082/bootstrap 实例。
- 真机结果出来前，D 段保持待验，不把桌面模拟结果表述为手机已验证。
