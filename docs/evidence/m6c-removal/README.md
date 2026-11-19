# 仓库移除：真实失败、重试、重启恢复与重新接入

2026-11-19 在宿主机隔离栈执行，验证 Issue #87 第 3 项返修。用的是真实 API、
真实 supervisor（`moyu-m6c`）和真实 dsh runtime；没有 mock 接单或执行。

## 环境

- API `127.0.0.1:3102`，隔离 PostgreSQL `moyu_iso_pr90`。
- supervisor `127.0.0.1:44991`，以 `moyu-m6c`（uid 988 / gid 982）运行，
  真实 capability 边界、真实 profile 模板和 `/opt/moyu-m6c/bin/gh-agent`。
- 两个一次性、同为 `Bouyer12` 所有的仓库：
  - 被移除：`Bouyer12/moyu-e2e-public-20261119`，profile `iso-1`。
  - 对照保留：`Bouyer12/moyu-e2e-private-20261119`，profile `iso-2`。
- 两个实例都先进入 online；GitHub 远端只读，不修改分支、PR 或仓库设置。

## 步骤与结果

1. 首次 `DELETE` 前把 `dsh/profiles/iso-1` 设为 immutable，使 supervisor 的
   本地清理真实失败。API 返回 503，仓库状态为 `failed`，`attempts=1`，
   `deletion_operation_id` 为 NULL；实例已被停止，另一个仓库仍 online。
2. 模拟服务在 `deleting` 中被中断：数据库写入 `deletion_state=deleting` 和
   一个 operation id，停止 API 后重启。启动恢复把状态改为 `failed`，清空
   operation id，并提示“服务重启中断了移除……请重试”。
3. 去掉 immutable 标记后重试同一 `DELETE`：HTTP 202，状态 `removed`，
   `attempts=2`，`removed_at` 和 30 天后的 `historyExpiresAt` 写入；operation
   id 清空。
4. 清理核对：profile、runtime home、worktree、credentials、instance env、log
   六类路径全部不存在；`repository_instances` 只剩对照仓库；仓库管理列表不再
   显示被移除仓库，旧链接返回 404。
5. 对照仓库 panel 仍 `runtime=ready`、账号 `Bouyer12`、仓库不变；进程未重启。
6. GitHub 仓库的 `id`、`full_name`、`pushed_at` 在移除前后完全一致。
7. 重新 `POST /api/v1/repositories` 同一全名：HTTP 201，复用同一个仓库 id，
   重新准备并唤醒 `iso-1`，两个实例再次同时 online。

原始事实、HTTP 观测和脱敏日志：

- `runtime-facts.json`
- `http-observations.log`
- `supervisor-redacted.log`
- `before-desktop-light.png` / `after-management-desktop-light.png` /
  `after-confirm-desktop-light.png`：管理入口、管理对话框与移除确认文案。

日志不含 token、私钥、Cookie、`.env` 内容或 GitHub 私有数据。验证结束后停止
隔离 supervisor/API/runtime，删除临时资料和隔离数据库；生产 supervisor、
生产数据库、`/var/lib/moyu-m6c` 和 GitHub 远端未修改。
