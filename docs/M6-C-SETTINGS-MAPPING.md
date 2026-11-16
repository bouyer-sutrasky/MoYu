# M6-C 设置字段与调用链映射

本表按 2026-11-16 的代码和候选现场编写。所有浏览器请求都先经过
`/api/v1/repositories/<id>/superagent/*`；浏览器不接触 runtime 端口、路径、
token 或 profile。`expectedInstanceId` 由 supervisor 的 prepared-instance
identity 生成，写入时必须回传，否则返回 409 `instance_changed`。

## 公共传输

| 层 | 位置 | 行为 |
| --- | --- | --- |
| 浏览器 caller | `apps/web/src/superagent/client/api.ts` | 捕获 `repositoryId`，生成 `/api/v1/repositories/<id>/superagent/...`；不再使用模块级可写 scope |
| Web transport | `apps/web/src/superagent/transport.ts` | 固定路径映射（`policy/history` → `policy-history`），拒绝没有 repository 的调用 |
| API 鉴权 | `apps/api/src/routes/superagent-settings.ts` | session owner + `findOwnedRepository`；block/query/body 使用 zod 固定 schema |
| supervisor 实例解析 | `apps/supervisor/src/server.ts` | 从 `repository_instances` 取 profile/port/createdAt，形成 `instanceIdentity`；写路径校验 identity |
| runtime panel | `apps/supervisor/src/panel-proxy.ts` + `server.ts` | 只允许固定 panel 路径，`panelCall` 使用 loopback port，20s 默认超时（检查/暂停 60s） |
| 上游设置存储 | DSH runtime 自身 | `profile/cordis.patch.yml` 的 `dsh-superagent` config；Deployment 三个上限直接写该 profile patch |

错误统一保留：HTTP status、`error.code`、`error.message`、`issues[]`、
`values`、`setup`、`requestId`、`runtime`（仅公开字段）。409 保留草稿并回读；
422 显示字段路径；503 表示 runtime 暂不可达。

## Source

| 控件/字段 | 浏览器请求 | 平台路由 | 上游操作 | 存储/生效 |
| --- | --- | --- | --- | --- |
| 当前 Source 健康、过滤 Trigger、dropped replies | `GET state`, `GET sources`, `GET settings` | `/superagent/state`, `/sources`, `/settings` | runtime `/orchestrator/api/{state,sources,settings}` | 运行时内存 + profile patch；只读投影 |
| workspace repository | `PUT settings/source:workspace` | `/superagent/settings/source%3Aworkspace` | `PUT /settings/source:workspace` | `source.workspace.config.repository`；服务端强制等于仓库 fullName |
| workspace enabled | 同上 | 同上 | 同上 | 平台 Web 入口要求 true；服务端拒绝 false |
| GitHub repository | `PUT settings/source:github` | `/superagent/settings/source%3Agithub` | `PUT /settings/source:github` | 服务端强制等于仓库 fullName |
| GitHub CLI | 同上 | 同上 | 同上 | 服务端强制等于 `GITHUB_CLI`；拒绝改路径 |
| GitHub polling/observe/开关 | 同上 | 同上 | 同上 | 首次 seed 默认；之后保留 owner 的显式 boolean，包括 false |
| 标签刷新 | `POST sources/:id/labels` | `/superagent/sources/:id/labels` | `POST /sources/:id/labels` | 先读 `/settings` 确认 source 已安装；未知 source 422 |
| 来源策略同步 | `POST policy-sync/:id` | `/superagent/policy-sync/:id` | `POST /policy-sync/:id` | 先确认已安装 source；成功后回读 settings |

## Eval / Policy

| 控件/字段 | 浏览器请求 | 平台路由 | 上游操作 | 存储/生效 |
| --- | --- | --- | --- | --- |
| Eval mode、timeout、model | `PUT settings/eval` | `/superagent/settings/eval` | `PUT /settings/eval` | runtime `eval` block；首次 seed，之后只保留 owner 值 |
| Policy rules/sources/admission | `PUT settings/policy` | `/superagent/settings/policy` | `PUT /settings/policy` | runtime `policy` block；workspace owner 与 GitHub allowed 用户是平台必需身份，服务端拒绝缺失 |
| policy history / diff | `GET policy/history` | `/superagent/policy-history` | `GET /policy/history` | 运行时 revision 历史；只读 |
| decisions 列表 | `GET decisions?limit&kind&window` | `/superagent/decisions` | `GET /decisions?...` | 只读分页；服务端只转发白名单 query |

## Execution

| 控件/字段 | 浏览器请求 | 平台路由 | 上游操作 | 存储/生效 |
| --- | --- | --- | --- | --- |
| 执行状态/队列 | `GET settings`, `GET tickets?state&limit` | `/superagent/settings`, `/tickets` | `GET /settings`, `/tickets?...` | 只读投影 |
| worker model | `PUT settings/executor` | `/superagent/settings/executor` | `PUT /settings/executor` | runtime `executor.model`；owner 可改 |
| maxWorkers | 同上 | 同上 | 同上 | 平台固定为 1；服务端 422 |
| directory | 同上 | 同上 | 同上 | 平台按 profile 计算；服务端 422 |
| prepare | 同上 | 同上 | 同上 | 平台固定 `git clone ...` 命令；服务端 422 |
| blockedCommands | 同上 | 同上 | 同上 | owner 可改 |
| executor pause/resume | `POST executor/pause` | `/superagent/executor/pause` | `POST /executor/pause` | runtime 暂停控制；平台任务暂停/租约仍由 MoYu task control 维护，不能把运行时暂停当成任务停止证明 |
| ticket retry/stop | `POST tickets/:id/retry|stop` | `/superagent/tickets/:id/retry|stop` | `POST /tickets/:id/retry|stop` | 固定 ticket id 校验；60s 超时；结果写入 runtime 操作 |

## Prompts

| 控件/字段 | 浏览器请求 | 平台路由 | 上游操作 | 存储/生效 |
| --- | --- | --- | --- | --- |
| prompt 当前值/默认值/sections | `GET prompts` | `/superagent/prompts` | `GET /prompts` | runtime prompt revision |
| 历史版本/offset | `GET prompts?revision&offset` | `/superagent/prompts?...` | `GET /prompts?revision=&offset=` | 服务端 zod 校验非负整数并透传；负值/非法字符串 422 |
| 预览 | `POST prompts/preview` | `/superagent/prompts/preview` | `POST /prompts/preview` | 不写持久 prompts revision |
| 保存 prompts | `PUT prompts` | `/superagent/prompts` | `PUT /prompts` | body 带 config/baseRevision/expectedInstanceId；成功后按 runtime revision 回读 |
| 会话 pending 提示 | `GET prompts` 返回 `notificationPending` | — | — | 只读 |

## Deployment

| 控件/字段 | 浏览器请求 | 平台路由 | 上游操作 | 存储/生效 |
| --- | --- | --- | --- | --- |
| promptMaxChars | `GET/PUT deployment` | `/superagent/deployment` | supervisor 直接读/写 profile patch | `dsh-superagent.config.promptMaxChars`；范围 1000–1000000 |
| admissionContextMaxPages | 同上 | 同上 | 同上 | 范围 1–100 |
| admissionContextTimeoutMs | 同上 | 同上 | 同上 | 范围 1–90000 |
| stateDir | 只读显示 | 同上 | 无写操作 | 平台受管，PUT 422 |
| revision | GET 返回 opaque content hash | — | — | 前端只做相等比较，绝不 `revision + 1` |
| 保存/回读 | PUT body `{ops,revision,expectedInstanceId}` | API/supervisor | read-check-write-rename + manager restart | 唯一临时文件 0600 + fsync + rename + 实例锁；成功返回 `{saved,revision,snapshot,restarting,restartRequired,restartRefused}` |
| 重启待生效 | 响应 `restartRequired` / 页面状态 | — | manager tick 在 task/command/lease 清空后重试 | 有活动工作时保存成功但不杀任务；tick 再次检查 gate |

## 受管字段拒绝示例

`PUT /api/v1/repositories/<id>/superagent/settings/executor` 发送
`{"value":{"maxWorkers":2,"directory":"/tmp/other","prepare":"rm -rf /"},
"revision":1,"expectedInstanceId":"..."}` 返回 422：

```json
{
  "error": { "code": "managed_field", "message": "..." },
  "issues": [
    { "path": "maxWorkers", "message": "..." },
    { "path": "directory", "message": "..." },
    { "path": "prepare", "message": "..." }
  ]
}
```

UI 将 `maxWorkers`、`directory`、`prepare` 显示为只读并标注“平台受管”；
workspace/GitHub 的 repository 和 CLI 字段同样只读。

## 必测入口

- `apps/supervisor/test/integration/settings-boundary.integration.test.ts`：
  identity 缺失/陈旧 409、受管字段 422、Deployment 同 revision 并发只允许
  一个 200。
- `apps/api/test/integration/pending-conversations.integration.test.ts`：
  首页 pending 过滤、优先级、跨仓隔离与 cursor 无重复。
- `scripts/m6c/browser-scenarios.mjs`：桌面/手机、浅/深色、五组设置导航、
  A→B 切仓请求目标、键盘焦点、横向溢出。
