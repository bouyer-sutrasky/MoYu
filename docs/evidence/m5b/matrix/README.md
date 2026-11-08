# M5-B 现场矩阵（基线 `main` = `f2ba6e91`）

本目录是一次现场矩阵取证运行留下的东西：可复跑的隔离 harness、原始日志、以及每项的判定。
**不是**七项全线的通过证明；哪些项做了、哪些没做，见 [SUMMARY.md](SUMMARY.md)。

> 2026-11-08 起，harness 增加了凭据与特权文件的隔离（[HARNESS-ISOLATION.md](HARNESS-ISOLATION.md)）：
> `stack.sh up` 会先审计测试身份对宿主配置的写权限、并要求专用探测凭据，任一不满足直接失败。
> 本目录此前的日志来自旧 harness；复跑七项之前必须先完成该文档 §4 的所有者动作。

## 这个 harness 起的是什么

`scripts/m5b/matrix/stack.sh up` 在一个**单一受管 slice** 里起整套现场：

| 组件 | 位置 | 说明 |
| --- | --- | --- |
| 隔离 PostgreSQL 16 | `m5bmatrix.slice/m5bmatrix-pg.service`，`127.0.0.1:55433` | 独立数据目录 `/tmp/m5bmatrix/pgdata` |
| 平台 API | `m5bmatrix.slice/m5bmatrix-api.service`，`127.0.0.1:4510` | `apps/api/dist/server.js` |
| dispatcher | `m5bmatrix.slice/m5bmatrix-dispatcher.service` | `apps/dispatcher/dist/main.js`，sha256 见日志 |
| host supervisor | `m5bmatrix.slice/m5bmatrix-supervisor.service`，`127.0.0.1:4491` | `MOYU_CGROUP_ROOT` 指到 slice 内 |
| runtime 实例 | `m5bmatrix.slice/instances/m5b-*` | profile `m5b`，面板 3404 / Bridge 3403 |
| 本地测试 provider | `m5bmatrix.slice/m5bmatrix-provider.service`，`127.0.0.1:3851` | `scripts/m5b/local-provider.mjs` |

宿主 `3082`（生产 bootstrap）、生产库、共享的 `55432` PostgreSQL 全程未触碰；
`/root/src/upstream/*` 源码未改。

```bash
scripts/m5b/matrix/stack.sh up      # 重建库、迁移、seed、起 supervisor、起 runtime、起 API/dispatcher
scripts/m5b/matrix/stack.sh down    # 连同 runtime 的 instance cgroup 一起收掉
scripts/m5b/matrix/stack.sh status  # 只读：slice 读数与各 unit 的 PID/cgroup
```

辅助命令走真实接口，不写 fake 状态：

```bash
node scripts/m5b/matrix/live.mjs new-task --text "..."   # 建会话 + 发消息（Web 入口）
node scripts/m5b/matrix/live.mjs pause|resume|retry --task <id>
node scripts/m5b/matrix/live.mjs snapshot --task <id>
node scripts/m5b/matrix/live.mjs ticket --ticket <id>
```

## 非 root 运行身份与凭据边界

`scripts/m5b/matrix/prepare-nonroot.sh` 建一个专用身份 `m5bmatrix`（uid 995）并打印每处访问授权的
before/after。它只授予**读/遍历**权限；`/root/.dsh-m5`、`/root/.config/gh-agent` 和任何 DSH home
都不再对测试身份可写。`stack.sh up` 让 **anchor / provider / supervisor / dispatcher / api** 全部以该
身份运行（PostgreSQL 一直是 `postgres`）。supervisor 的实例 cgroup 在它自己被委托的单元 cgroup 下
（`Delegate=yes` + `DelegateSubgroup=payload`），控制器以该身份写入。

每次运行的状态分区：

| 目录 | 属主/模式 | 内容 |
| --- | --- | --- |
| `/tmp/m5bmatrix` | root 0755 | 运行根，测试身份不能改名/替换条目 |
| `protected/` | root 0700 | supervisor token、seeded 会话 token、`state.env` |
| `config/` | root:matrix 0750 | `instances.json`（supervisor 只读） |
| `tmp/ credentials/ instance-env/ dsh-home/ ...` | m5bmatrix 0700 | provider/worker 交互文件、Bridge 凭据、暂存 home |

测试身份的仓库凭据与 gh 凭据都是**专用且仅授权探测仓库**的（`M5B_MATRIX_SSH_KEY`、
`M5B_MATRIX_GH_CONFIG_DIR`）；`guard audit-credentials` 会拒绝宿主 agent key 的副本（含改名）
和共享 gh 配置。缺凭据时 `prepare-nonroot.sh --check` 会打印所有者动作。

## 被刻意改过的现场配置（复跑前必读）

隔离栈必须在没网、没真 key 的情况下把 worker 回合跑起来。这些改动都落在矩阵自己的暂存目录
`/tmp/m5bmatrix`（不在仓库里，也不影响生产 3082）；共享的 `/root/.dsh-m5` 保持原样：

1. 测试 fixture 只写**暂存副本**（`/tmp/m5bmatrix/dsh-home/profiles/m5b`），共享
   `profiles/m5b/cordis.patch.yml` 保持原样：`local-test` provider 增加 `reasoningEfforts`
   （supervisor 给 eval 模型硬写 `reasoningEffort: "low"`，否则启动校验 400）；
   `agent-default-model` 改为 `local-test/local-test`；移除 `commandcode` provider，
   使 orchestrator 只能走 loopback provider（否则真实的 orchestrator 回合会调用外部模型，
   决策 `trigger_id` 与实际候选不匹配 → `decision_ignored`）。
2. 暂存 home 自己的 `.credentials.yaml` 只有 `refs: LOCAL_TEST_API_KEY: local-test-dummy`
   （0600，m5bmatrix 所有）；共享的 `/root/.dsh-m5/.credentials.yaml` 不被读取也不被修改。
3. `stack.sh up` 每次重建暂存 home，因此不会有上一个 orchestrator session 里持久化的 provider
   选择（那会导致 `NO_ADAPTER`）；归档旧会话时也把目录移出 `sessions/`，否则 JSONL 会话存储
   会判定为「corrupt session log」而整个 workspace 服务起不来。

恢复原状态：把 `profiles/m5b/cordis.patch.yml` 改回 `commandcode` 默认模型与 provider 段，
删掉 `LOCAL_TEST_API_KEY`，把 `state/*.pre-matrix-*`、`session-archive/*` 移回原名。

## 现场边界与安全

- 所有压测/长回合都只在 `/sys/fs/cgroup/m5bmatrix.slice`（8 GiB，swap 0）内；
  `stack.sh` 在 `down` 时用 `cgroup.kill` 收掉 runtime 的 instance 子树，避免端口被孤儿进程占住。
- 日志里的 token 一律 `***`；feishu/生产凭据未进入任何日志。
- 特权 token 只在 `protected/`（root 0700）；`down` 会删除它们，Bridge 凭据目录每次 `up` 清空，
  历史运行不再累积凭据文件。
- `local-provider` 的 prompt dump 只在 `/tmp/m5bmatrix/tmp/provider-prompts.jsonl`，不入库。

## 非 root 运行还需要两样东西

- **专用探测凭据**：`prepare-nonroot.sh` 把 `/root/.config/m5bmatrix/probe_ssh_key`
  （root:root 0600）安装为 `/home/m5bmatrix/.ssh/probe_deploy`（0600），并配置
  `ssh-keyscan -p 443 ssh.github.com` 的 `known_hosts`；该 key 只应加入探测仓库。
  gh 走 `/root/.config/m5bmatrix/gh`（0750 root:matrix，`hosts.yml` 0640），由
  `scripts/m5b/matrix/gh-m5b.sh` 固定 `HOME`/`GH_CONFIG_DIR` 使用。
  不再复制 `/root/.ssh/sa_agent2`；`prepare-nonroot.sh --revoke` 会删除旧副本。
  现场范围用 `node scripts/m5b/matrix/precheck.mjs --online` 验证（探测仓库可达、MoYu 被拒）。
- 构建测试进程用 `/opt/moyu-node24`，该目录组只读；不安装/不升级任何包。
这两项都只给 `m5bmatrix` 组，退役时可用脚本打印的原始 group/mode 回退。
