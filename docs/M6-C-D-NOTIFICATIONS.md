# M6-C D：手机浏览器通知调查

> 状态：代码路径已复核；**真实手机未验**。本机没有可用的真实手机，D 段的
> 真机矩阵（系统、浏览器、安装态、权限、切后台方式、点击结果）本轮无法采证。
> 下面区分「代码可确认的事实」与「必须在真机确认的假设」，不以桌面无头浏览器
> 代替手机证据。

## 1. 结论

1. **页面打开时**，通知由页面里的 `EventSource` 驱动，再调用浏览器
   `new Notification(...)`。桌面 Chromium 的构造器可用；页面关闭、被系统回收或
   长时间切后台后，SSE 与页面代码都不再运行，**不会产生通知**。
2. 当前 Web 端**没有 Service Worker、没有 Web Push 订阅、没有服务端推送通道**
   （`apps/web/public` 只有主题初始化脚本，`apps/web/src` 没有
   `serviceWorker` / `showNotification` / `PushManager` 调用）。因此「关闭页面
   后仍要推送」不是现有范围内的缺陷，而是明确的能力缺口。
3. 手机浏览器常见的失败点与代码路径可直接对应：Android Chrome 上页面级
   `new Notification()` 不是可依赖的构造方式（移动端通常要求
   `ServiceWorkerRegistration.showNotification`），而当前实现没有 Service Worker
   回退；iOS Safari 的 Web Push 还要求安装到主屏幕的 PWA。两项都需要真机确认
   后才能判定为本次用户遇到的根因。
4. 权限、通知设置、可见性、去重任一条件不满足都会静默不显示；当前实现把原因
   记录在 `window.__moyuNotifyDebug`，但没有展示给用户。真机复测时应先区分
   「事件没到」和「到了但通知没建」。

## 2. 当前代码路径

| 步骤 | 位置 | 行为 |
| --- | --- | --- |
| 页面建立 SSE | `apps/web/src/shell/WorkspaceShell.tsx` 的 `EventSource('/api/v1/events')` | 只在已登录页面挂载期间存在；断开后按浏览器重连策略重连。 |
| 事件进入通知 | `handleWorkspaceEvent` → `deliverWebNotification` | 同一个持久事件既更新未读徽标，也尝试浏览器通知。 |
| 类别与设置 | `apps/web/src/lib/activity.ts` 的 `categoryForEvent`、`summaryForEvent`、`loadNotificationSettings` | 任务提问/等待回复、待审阅、完成、失败四类；设置可关闭或只在后台时通知。 |
| 通知创建 | `apps/web/src/lib/notifications.ts` 的 `deliverWebNotification` | 依序检查类别、设置、`Notification` 是否存在、是否 `background` 且页面可见、权限、跨标签去重，然后 `new Notification(title, { body, tag, data })`。 |
| 点击 | `notification.onclick` | `window.focus()` 后按 `conversationId` + `repositoryId` 调用 `openConversationTarget`，再由地址路由恢复目标；目标失效时回退并提示。 |
| 权限申请 | `NotificationSettingsSection` → `requestNotificationPermission` | 只在用户显式操作时申请；浏览器已拒绝后不再重复弹窗。 |

去重使用 `localStorage` + Web Locks，键为事件 id，TTL 7 天。它避免多标签重复
通知，但也意味着同一事件在另一台设备上不会被这条浏览器去重逻辑影响（各设备
独立存储）。

## 3. 失败分类与判据

| 现象 | 判据 | 当前结论 |
| --- | --- | --- |
| 事件未到 | 页面内「活动中心」/未读徽标也没有该事件；SSE 连接状态为断开或后端没有写入事件 | 页面关闭/被回收时必然如此；页面打开时先查 SSE 与服务端游标。 |
| 浏览器能力缺失 | `typeof Notification === 'undefined'`；或移动端 `new Notification` 抛错/不显示 | 当前没有 Service Worker 回退；Android Chrome 与 iOS 需真机确认。 |
| 通知创建失败 | 事件已在活动中心，但 `__moyuNotifyDebug.attempts` 记录 `no-permission` / `disabled` / `background-only` / `duplicate` / `error` | 权限、设置、可见性、去重、构造异常均可解释；需在真机读取该调试对象。 |
| 点击定位错误 | 通知出现，点击后停留在原页/打开错误仓库或会话 | 点击回调携带事件里的 `conversationId` 与 `repositoryId`；目标被合并、删除或无权限时由地址路由回退并显示提示。需真机确认浏览器是否把 `onclick` 交给页面。 |

## 4. 页面仍打开时的支持范围

- 桌面浏览器：页面保持打开且权限为 `granted` 时，当前 `new Notification` 路径
  可用；本轮在无头 Chromium 中确认构造器存在且不抛错，但没有真实桌面通知中心
  的展示证据，也没有真实 SSE 事件触发。
- 手机浏览器：页面保持打开、标签在前台或未被系统冻结时，**如果**该浏览器支持
  页面级 `new Notification`，当前路径可用；Android Chrome 通常要求 Service
  Worker 的 `showNotification`，当前实现没有该分支，因此很可能不显示。
- 页面关闭后：SSE 不存在，当前实现不可能送达。这不是可以通过重试或调整权限
  解决的缺陷，需要新增推送通道。

## 5. 关闭页面后的能力缺口与方案

若产品要求「关闭页面也收到手机通知」，需要独立的推送链路，至少包括：

1. **Service Worker**：注册站点 Service Worker，处理 `push` 与
   `notificationclick`；点击时聚焦已有窗口或打开目标地址。
2. **Web Push 订阅**：生成 VAPID 密钥，页面在用户显式操作后
   `PushManager.subscribe`，把 endpoint、p256dh、auth 持久化到数据库（按 owner
   和设备）。
3. **服务端发送**：dispatcher 在写入持久事件时，按订阅发送 Web Push；需要处理
   410/404 失效订阅、重试、限流、去重与密钥轮换。
4. **安装态与平台限制**：iOS 需要 16.4+ 且安装到主屏幕；Android 需要浏览器
   支持 Web Push；两者都需要 HTTPS（现有域名满足）。
5. **权限与设置**：继续复用现有通知类别与后台/始终模式；关闭页面后「只在后台」
   的语义需要重新定义。

上述属于新能力，**不应在本次 C/D 范围内静默扩大**。建议先由所有者确认是否
必须关闭页面推送；若只需要页面打开时的通知，则补 Service Worker 回退并在真机
回归即可。

## 6. 真机复测清单（未执行）

对每台设备记录：

- 系统与版本；浏览器与版本；普通标签页 / 添加到主屏幕的 PWA / 安装态。
- `Notification.permission`；是否出现过权限弹窗；设置页通知模式与类别。
- SSE 连接状态；事件是否出现在活动中心；`__moyuNotifyDebug` 的 attempts 与
  delivered。
- 切后台方式：仅切标签、锁屏、切到其他 App、停留数分钟后返回、完全关闭页面。
- 点击结果：是否回到正确仓库/会话；目标已失效时的回退提示。
- 页面关闭后是否仍期望收到通知；若期望，按第 5 节单独立项。

## 7. 未验范围

- 没有真实手机、真实通知权限弹窗、真实系统通知中心或真实点击。
- 没有在 Android Chrome / iOS Safari 上确认 `new Notification` 的实际行为。
- 没有真实事件从服务端到手机的端到端记录；桌面无头浏览器只验证了构造器存在。
- 没有验证 PWA 安装态、系统省电策略、后台标签冻结和通知分组。
