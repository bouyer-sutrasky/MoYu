# 真实任务中文回执（隔离 Supervisor/DSH）

本目录是 C 段「中文交互」的真实任务证据，不是预览或 mock。运行栈全部在隔离
目录、端口和数据库上；没有使用生产库、生产 profile 或 3082 实例。

## 隔离环境

| 组件 | 值 |
| --- | --- |
| 数据库 | `moyu_m6c_c_real`（PostgreSQL 16，`127.0.0.1:55432`） |
| 测试仓库 | `Bouyer12/m6c-c-real-task-1795085845`（private、一次性） |
| 仓库起点 | `0411f35da720ab90db69bd58b0bf8d6d794d17b3` |
| Supervisor | 隔离进程 `127.0.0.1:4494`；profile `m6cc`；DSH `3483`；Bridge `3484` |
| API | 隔离进程 `127.0.0.1:3102` |
| Dispatcher | 隔离进程，delivery interval 300 ms |
| Runtime | 固定模板 profile，`dsh-superagent` 指向 `/tmp/m6c-c-artifact`（含 0001–0030 补丁；`lib/index.js` sha256 `1fc0dbea8926deec4a724de700482f010d64fef032687e514782d523d6b54b66`） |
| 身份 | root 隔离目录；不复制生产 runtime 的 uid/gid 或 service 配置 |

`stack.json` 记录同一组事实；`prompt-preview.json` 是运行中实例通过
`/panel-action/prompts/preview` 返回的实际 HTTP 预览（不是源码级模拟）。

## 真实流程

1. 仓库副本准备成功：`preparation.state=ready`，head `0411f35…`。
2. 通过 API 创建 Work 会话与任务（`executionMode=execute`）。
3. 通过 API 发送中文消息，要求创建文本文件、开始前接单、完成后中文总结、不要
   创建 PR。
4. Dispatcher 把消息投递到隔离 Bridge；执行器真实运行并回调 API。
5. 任务 `completed`；`real-task.json` 保留完整消息正文，`progress-events.json`
   保留真实 `task.progress` 事件，`worktree.txt` 保留文件 hash、内容和提交。

## 实际回执

| 类型 | 正文（节选） |
| --- | --- |
| 接单 acknowledgement | 收到：我会在仓库根目录新建 m6c-language-check.txt，写入“中文回执验证”，完成后用中文汇总改动与验证结果。 |
| 进度 `task.progress`（prepare） | 准备任务工作区：从仓库副本检出冻结提交… |
| 进度 `task.progress`（ready） | 任务工作区已准备好（从仓库副本检出）；正在启动 worker… |
| 进度 `task.progress`（worker） | worker 已启动，开始执行任务。 |
| 进度 `task.progress`（完成） | 任务已完成，用中文总结如下：… |
| 完成 result | 已在仓库根目录创建 m6c-language-check.txt，内容为“中文回执验证”（UTF-8，含行尾换行），提交 8ba6a8f 并推送到分支 `agent/language-check-file-f33dffc16a2c`。按用户要求未创建 PR。 |
| 完成 reply | 已完成：仓库根目录的 `m6c-language-check.txt` 已创建，内容为“中文回执验证”，核对文件字节与服务端一致，仅新增该文件。 |

产物：`m6c-language-check.txt`，内容 `中文回执验证`，sha256
`682e9b5aad161de96183c734de6a3b8be11d2d6d56ab979431afc9f1ebec4c24`，
提交 `8ba6a8f`。

## 未触发的情形

本任务很小，且用户要求不创建 PR 并直接完成，因此：

- **提问**：未触发（没有需要人工决策的分歧）。
- **失败/受阻**：未触发（任务一次完成）。
- 没有创建 PR，因此没有 PR 审阅或 CI 回执。

这些不是遗漏：同一真实任务的接单、进度和完成正文已经覆盖；提问/失败需要另一条
不同任务才能自然触发。

## 未验

- 没有在真实手机或生产域名上重复执行。
- 未验证生产发布、生产库或 3082 实例；这些仍按所有者流程。
