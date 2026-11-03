# Passkey 与浏览器接口核查

核查日期为 2026-11-03。以下根据公开文档核对，未安装包或执行浏览器集成测试。

## SimpleWebAuthn

服务端安装文档支持 Node LTS 22.x 及以上，覆盖 Node 24 LTS。平台建仓时应锁定服务端与浏览器包的版本，并用实际安装版本的 TypeScript 声明确认接口。 [服务端官方文档](https://simplewebauthn.dev/docs/packages/server)

| 阶段 | 服务端调用 | 浏览器与持久化 |
| --- | --- | --- |
| 注册选项 | `generateRegistrationOptions` 接收 RP 名称、RP ID、用户名及注册策略，返回 `PublicKeyCredentialCreationOptionsJSON`。 | 保存生成的 challenge，浏览器用 `startRegistration({ optionsJSON })` 并回传结果。 |
| 注册校验 | `verifyRegistrationResponse` 接收 `response`、`expectedChallenge`、`expectedOrigin`、`expectedRPID`。 | `verified` 为真才保存 `registrationInfo.credential`，包括 ID、公钥、签名计数，另可保存 transports。 |
| 登录选项 | `generateAuthenticationOptions` 接收 RP ID，可用 `allowCredentials` 限定已登记凭据，返回 `PublicKeyCredentialRequestOptionsJSON`。 | 保存生成的 challenge，浏览器用 `startAuthentication({ optionsJSON })` 并回传结果。 |
| 登录校验 | `verifyAuthenticationResponse` 接收注册校验所用的四类参数，外加从数据库读取的 `credential`。 | 通过返回的凭据 ID 查所属凭据，`verified` 为真后保存 `authenticationInfo.newCounter`。 |

RP ID 是域名，origin 包含协议及适用的端口。配置应与用户实际打开的工作台地址一致。challenge 的过期、用途绑定、并发消费与会话创建属于平台责任。 [服务端官方文档](https://simplewebauthn.dev/docs/packages/server) · [浏览器官方文档](https://simplewebauthn.dev/docs/packages/browser)

## Cookie、通知与 SSE

- 会话 Cookie 可使用 `__Host-` 前缀，配合 `Secure; HttpOnly; Path=/`，省略 `Domain`，并显式配置 `SameSite`。`HttpOnly` 阻止脚本读取 Cookie，浏览器仍可在符合条件的请求中发送它。对写请求另做服务端来源校验。 [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
- Notifications API 需要安全上下文与用户授权。用用户手势触发权限请求，分别处理 `default`、`denied`、`granted`。持久通知可通过 Service Worker 的 `showNotification()` 展示。页面关闭后的远程投递需要另有消息来源，例如 Push API。 [MDN Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API) · [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- SSE 是从服务器到客户端的单向流，响应使用 `text/event-stream`，消息以空行分隔。`EventSource` 自动重连，服务端可用 `id` 提供续传游标，用注释行保活。平台仍需实现持久化事件回放与去重，并验证代理配置下事件能及时送达。HTTP/1.x 对同域连接数有较低限制，适合共享流而非为每个任务开流。 [MDN Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
