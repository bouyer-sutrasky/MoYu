# M6-C D 证据：手机通知兼容投递

基线：`01896badaf64da1ae5a1f77bbf26b422b3933e16`（#84 合并后的 `main`）。
实现与结论见 [`docs/M6-C-D-NOTIFICATIONS.md`](../../M6-C-D-NOTIFICATIONS.md)。

## 环境

- 本机 Linux；Playwright 1.56.1 + Chromium 141，headed，Xvfb `:99`。
- 隔离 PostgreSQL 16 `moyu_m6c_c_real`（`127.0.0.1:55432`），不是生产库。
- 隔离 API：Before `127.0.0.1:3103`（`01896ba` 的独立 worktree 构建），
  After `127.0.0.1:3102`（本分支构建）；同一测试库、同一真实任务会话
  `178ee9e7-2edb-494f-ae5c-beb1a8a7dadc`。
- 事件通过真实 runtime callback `POST /api/internal/v1/runtime-events` 写入，
  由 API 生成持久 `task.question` 事件并走 SSE；不是伪造前端 SSE 帧。
- 浏览器视口 390×844、Android 14 / Pixel 8 UA；页面级 `Notification` 构造器按移动
  浏览器行为替换为抛 `TypeError`。这是能力模拟，**不是真机证据**。

## 结果文件

| 文件 | 场景 | 结果 |
| --- | --- | --- |
| `before-mobile-result.json` | `01896ba`，页面级构造器失败 | `error`，无通知，活动中心与未读正常 |
| `after-mobile-result.json` | 本分支，同一失败 | `delivered via service-worker`，点击定位正确，重复/重连不重复 |
| `denied-denied-result.json` | 权限拒绝 | `no-permission`，无通知，活动中心与未读正常 |
| `unsupported-unsupported-result.json` | 浏览器无 `Notification` | `unsupported`，无通知，活动中心与未读正常 |
| `closed-page.json` | 页面关闭后写入事件 | 活动中心有事件，`getNotifications()` 为空 |
| `expired-session-result.json` | 同源工作台点击 + 会话过期登录页点击 + Passkey 登录 | 工作台确认消费且页面不重载；登录页 URL 带目标；登录后进入目标会话 |

原始命令输出：`web-test.txt`、`check.txt`、`build.txt`、`integration.txt`。

截图均为真实应用截图，同一移动视口与浅色主题：

- Before：`before-home-mobile.png`、`before-activity-mobile.png`、`before-settings-mobile.png`
- After：`after-home-mobile.png`、`after-activity-mobile.png`、
  `after-click-route-mobile.png`、`after-click-invalid-target-mobile.png`、
  `after-duplicate-after-reload-mobile.png`、`after-reconnect-mobile.png`、
  `after-settings-mobile.png`
- 拒绝授权 / 不支持：`denied-*.png`、`unsupported-*.png`
- 返修回归：`click-in-place-before.png`、`click-in-place-after.png`、
  `expired-login-before-click.png`、`expired-login-after-navigate.png`、
  `expired-after-login-target.png`

页面布局没有变化；Before/After 的差异在通知投递路径和点击回退。系统通知本身通过
`ServiceWorkerRegistration.getNotifications()` 与 `__moyuNotifyDebug` 验证，未截取
系统通知弹窗：Xvfb 没有通知守护进程，headed Chromium 能创建通知但桌面上不渲染。

## 命令

```bash
# 单元测试
pnpm --filter @moyu/web test

# Before / After / denied / unsupported（示例）
DISPLAY=:99 M6C_RUNTIME_CALLBACK_TOKEN=... \
  node scripts/m6c/notifications-browser.mjs \
  --base-url http://127.0.0.1:3102 \
  --storage-state /tmp/storage.json \
  --repository cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  --conversation 178ee9e7-2edb-494f-ae5c-beb1a8a7dadc \
  --label after --mode mobile --expect delivered --out /tmp/evidence
```

`--label before --expect error` 用于基线；`--mode denied --expect no-permission`、
`--mode unsupported --expect unsupported` 用于站内回退。token 只通过环境变量传入，
不写入仓库或结果文件。

会话过期回归使用隔离 `localhost` API、虚拟 Passkey 和同一个测试库：

```bash
# 一次性恢复码（仅操作者终端可见），再用 scripts/m6c/bootstrap-owner.mjs
# 在 localhost 上登记虚拟 Passkey 并保存 credential JSON。
DISPLAY=:99 M6C_RUNTIME_CALLBACK_TOKEN=... \
  M6C_TEST_DATABASE_URL=postgres://moyu:x@127.0.0.1:55432/moyu_m6c_c_real \
  node scripts/m6c/notifications-expired-session.mjs \
  --base-url http://localhost:3104 \
  --storage-state /tmp/storage.json \
  --credentials /tmp/credentials.json \
  --repository cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  --conversation 178ee9e7-2edb-494f-ae5c-beb1a8a7dadc \
  --out /tmp/evidence
```

脚本会先恢复上一次撤销的 fixture 会话、把虚拟认证器的服务端 counter 归零，再执行
“工作台确认消费 → 写通知 → 撤销会话 → 刷新登录页 → Worker 点击 → 登录页 URL 带目标 →
Passkey 登录进入目标会话”。虚拟认证器只作自动化证据，不代表真机。

## 真机待验

没有真实 Android/iPhone。真机矩阵（普通标签页与安装态、权限、前后台、点击、关闭页面）
全部待验，矩阵和复测步骤见
[`docs/M6-C-D-NOTIFICATIONS.md`](../../M6-C-D-NOTIFICATIONS.md) 第 5 节。
