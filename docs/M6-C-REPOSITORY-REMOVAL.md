# M6-C 仓库管理入口与移除生命周期

更新时间：2026-11-19。范围是 Issue #87 第 3 项，基线 `e6470da1031946eba23aa40913227025dfee971a`。

## 1. 入口与确认

工作台侧栏新增「管理仓库」。列表显示已接入仓库的实例状态、仓库副本准备
阶段和移除状态。授权所有者可对单个仓库发起「从 MoYu 移除」。

确认页明确写出：

- 仓库全名；
- 影响范围：停止该仓库的 Superagent 实例，删除 MoYu 内的本地 Git 副本、
  实例 profile/state、运行目录、凭据与环境文件；
- 不影响：GitHub 原仓库、分支、PR 和远端数据；
- 历史保留：历史任务与会话在 MoYu 数据库中只读保留 30 天，期间不在工作台
  显示；重新接入同一仓库可恢复；
- 旧链接：返回「已从 MoYu 移除」的说明，不再返回通用未找到。

取消不会发出任何请求。

## 2. 服务端流程

`DELETE /api/v1/repositories/:id`：

1. 只允许该仓库的 owner；其他 owner 得到 404，不泄露存在性。
2. 在 `repositories` 行锁内原子认领：检查准备中副本、未结束任务（含等待人工）
   和活动租约；有阻塞时返回 409，不写入 `deleting`。并发 DELETE 只有一个能
   认领，其他请求返回当前 `deleting` 状态。
3. 认领写入 `deletion_state='deleting'`、`deletion_operation_id`、尝试次数和
   开始时间，然后调用 supervisor 的 `POST /control/v1/instances/:id/remove`。
   supervisor 再次校验任务/租约/后台进程，停止实例，删除本次仓库专属资源，并
   删除 `repository_instances` 行、`runtime_cursors` 行和仓库的 Bridge 绑定。
4. 成功/失败回执只在 `deletion_state='deleting'` 且 `deletion_operation_id`
   仍匹配时更新；晚到的旧操作回执不会覆盖新操作。成功写入 `removed`、
   `removed_at` 和结束时间；仓库从 `GET /api/v1/repositories` 中隐藏，任务和
   会话行保留。
5. supervisor 失败时写入 `failed` 和脱敏原因，页面显示重试；重试就是再次发送
   同一 `DELETE`。
6. 任务准入与移除使用同一 `repositories` 行锁：并发新建任务/执行不会绕过
   `deleting`；副本准备在 supervisor 侧也拒绝非 `none` 的删除状态。
7. 服务重启时，仍为 `deleting` 的行改为 `failed` 并清除操作 id、提示重试；
   supervisor 的删除是幂等的，已清理的路径不会再次报错。

`POST /api/v1/repositories` 遇到同一全名的已移除行时，先校验原 owner：只有原
owner 能复用原行（同一仓库 id）恢复为 `provisioning` 并重新准备实例；其他
owner 得到 409，归属不会被改写。未移除或移除中的同名仓库仍返回冲突。

## 3. 本地清理范围

supervisor 只使用自己的配置与实例行推导路径，不接受请求中的路径：

```
DSH_HOME/profiles/<profile>          实例 profile
DSH_HOME/homes/<profile>             动态 profile 的 runtime home
外置 homes/<profile>                 固定 profile 的 runtimeHome（仅配置在 homes 根内）
DSH_HOME/state/<profile>[.lock]      旧版共享 state（如存在）
WORKTREE_ROOT/<profile>              仓库 Git mirror、任务工作区与残留
RUNTIME_CREDENTIALS_DIR/<repoId>.json
INSTANCE_ENV_DIR/<repoId>.env
INSTANCE_LOG_DIR/<profile>.log
```

每个路径都必须是配置根目录的真子路径；配置根本身、越界路径和非法 profile
会被拒绝。其他仓库的 profile、工作区和 GitHub 远端不受影响。

## 4. 数据与迁移

迁移 `0023` 在 `repositories` 增加 `deletion_state`、`deletion_detail`、
`deletion_attempts`、`deletion_started_at`、`deletion_finished_at`、`removed_at`
和状态检查约束；迁移 `0024` 增加 `deletion_operation_id`。仓库行不删除，因此
历史任务/会话的外键保持完整。移除后第 30 天起，API 启动时和每小时的后台任务
都会清理该仓库的会话（消息和任务行随外键级联），与确认页写的「30 天后自动
清理」一致。清理和重新接入使用同一个 `repositories` 行锁：重新接入会重新确认
原 owner、`removed` 状态和到期时间，过期时在同一事务内先删旧历史再恢复；清理
在删除前也会锁行并复核「仍已移除且已到期」，因此不会误删重新接入后的新会话。

回滚：`0024` 只删除 `deletion_operation_id` 和 ledger 行；`0023` 删除其余列和
ledger 行。已停止的实例和已删除的本地副本不会因此恢复，重新升级后仓库重新
可见但需要重新唤醒/准备。

## 5. 验证

- API 集成测试：有活动任务时 409；移除此后从列表隐藏、历史行保留、旧链接
  提示已移除、重复请求幂等、supervisor 失败后状态为 failed 且重试成功、
  服务重启恢复为 failed、其他 owner 404、同名重新接入恢复原 id。
- supervisor 单元测试：路径派生只包含该仓库资源；非法 profile、越界路径和
  经中间符号链接逃逸的路径被拒绝；删除幂等且不删除配置根。
- 并发 DELETE 只调用一次 supervisor；并发任务准入与删除只有一个成功；晚到
  旧 operation id 回执不改变状态；服务重启把 `deleting` 恢复为可重试失败；
  过期历史被清理而近期历史保留。
- Web 单元测试：现有格式与管理入口不依赖 mock 数据。

未验：未在运行中的生产 release 上执行真实移除；需要按发布流程升级后，用一个
测试仓库验证真实实例停止、路径删除、失败重试和重新接入，并记录 before/after
本地资源清单。
