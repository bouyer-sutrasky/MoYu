# 两实例通知实验原始证据快照

时间：2026-11-03 06:14–06:23 UTC。对应 [environment-baseline.md](../../../docs/environment-baseline.md) §5.2 与 [probes/github-notification-probe.md](../probes/github-notification-probe.md)。

两个测试仓库均为 `Bouyer12` 下的私有临时仓库；`sutrasky` 不一定有访问权限，因此本快照保存审阅所需的原始值。仓库本身不含生产数据或凭据，审阅后可删除。

## 1. 仓库与评论

| 仓库 | Issue | 评论 ID | 作者 | created_at | 是否进入 Trigger |
| --- | --- | --- | --- | --- | --- |
| `Bouyer12/m0-compat-a-5b173b63` | #1 | 6596841008 | `github-actions[bot]` | 2026-11-03T06:14:13Z | 是 |
| 同上 | #1 | 6596904324 | `github-actions[bot]` | 2026-11-03T06:18:44Z | 是 |
| 同上 | #1 | 6596937153 | `github-actions[bot]` | 2026-11-03T06:21:04Z（A 停机期间） | 是（重启后补收） |
| `Bouyer12/m0-compat-b-5b173b63` | #1 | 6596842024 | `github-actions[bot]` | 2026-11-03T06:14:18Z（B 首次启动前） | **否** |
| 同上 | #1 | 6596904239 | `github-actions[bot]` | 2026-11-03T06:18:43Z | 是 |

## 2. 实例 SQLite 投影

读取方式：只读打开 `/root/.dsh-m0/state/m0{a,b}/orchestrator.sqlite`。Trigger/Decision 为存储的 JSON 中与判断相关的字段摘录。

实例 A（`m0a`，3182，仓库 A）：

```text
trigger 2026-11-03T06:14:13.000Z a85d1999f5487fefccee9faf376d9c13 github-actions[bot] human=false mention 6596841008
trigger 2026-11-03T06:18:44.000Z 511e1e8d7d995bf81b6b221b8cb57fea github-actions[bot] human=false mention 6596904324
trigger 2026-11-03T06:21:04.000Z f7e56fc5f5d3f2b1a363bfa82b506ebe github-actions[bot] human=false mention 6596937153
decision 2026-11-03T06:15:21.454Z ignore [not_human a85d1999...]
decision 2026-11-03T06:19:26.833Z ignore [not_human 511e1e8d...]
decision 2026-11-03T06:22:27.977Z ignore [not_human f7e56fc5...]
kv github-since "2026-11-03T06:23:22.989Z"
kv github-cursor:1 "2026-11-03T06:22:20.550Z"
```

实例 B（`m0b`，3183，仓库 B）：

```text
trigger 2026-11-03T06:18:43.000Z 79c6f16de22afda10b57eb4f1db2da2b github-actions[bot] human=false mention 6596904239
decision 2026-11-03T06:19:11.995Z ignore [not_human 79c6f16d...]
kv github-since "2026-11-03T06:23:11.854Z"
kv github-cursor:1 "2026-11-03T06:20:07.008Z"
```

每个实例的 Trigger URL 只指向自己的仓库；A 的 `github-cursor:1` 与 B 的不同，说明游标在各自 state 内独立。

## 3. 停机/重启时间线（实例 A）

| 时间（UTC） | 事实 |
| --- | --- |
| 06:20:55 左右 | A 停止；3182 无监听 |
| 06:21:04 | 仓库 A 产生停机期间评论 6596937153 |
| 06:21:28 | 仓库级通知 `updated_at` |
| 06:22:10 左右 | A 以同一 profile/state 重启 |
| 06:22:25 | 首次轮询 `health.github.at`，`1 notifications` |
| 06:22:27 | Trigger `f7e56fc5…` 的 Decision 写入 |

重启后 A 的 Trigger 数从 2 变为 3；没有重复的前两条 Trigger（稳定 ID 去重）。

## 4. 账号未读状态

两个实例轮询后，账号级通知列表（未读，`gh api notifications?per_page=50`）：

```text
Bouyer12/m0-compat-a-5b173b63  mention  2026-11-03T06:21:28Z  M0 notification probe
Bouyer12/m0-compat-b-5b173b63  mention  2026-11-03T06:19:05Z  M0 notification probe
sutrasky/MoYu                  mention  2026-11-03T05:58:29Z  M0
```

3 条都仍为未读，说明轮询读取没有标记已读；两个测试仓库的通知也没有被对方实例消费。

## 5. 实例健康与配置

```text
GET /orchestrator/api/state（3182）
setup.accounts = { repository: "Bouyer12/m0-compat-a-5b173b63", agent: "Bouyer12", feishu: null }
health.github  = { state: "ready", detail: "…", at: "…" }

GET /orchestrator/api/state（3183）
setup.accounts = { repository: "Bouyer12/m0-compat-b-5b173b63", agent: "Bouyer12", feishu: null }
health.github  = { state: "ready", detail: "…", at: "…" }
```

Policy 为 `{ rules: [], sources: { github: { allowed: [], admission: {} } } }`；因此 bot 评论只产生 `not_human` 决策，不进入 worker，也不调用模型。

## 6. 局限

- 两个仓库都是私有临时仓库，审阅者可能无法直接打开；本快照是持久证据，仓库本身可删除。
- 本轮只用 `github-actions[bot]` 评论；没有第二个人类账号在隔离仓库制造人工 @。人工 explicit 的入口由 bootstrap 接收 `sutrasky` 的 issue #1 证明（本 ticket 即由它产生）。
- 没有同仓库双实例实验；这类部署应被宿主 repository lease 阻止（见 findings §6）。
