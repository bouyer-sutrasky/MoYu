# M5-B 现场矩阵（基线 `main` = `f2ba6e91`）

本目录是一次现场矩阵取证运行留下的东西：可复跑的隔离 harness、原始日志、以及每项的判定。
**不是**七项全线的通过证明；哪些项做了、哪些没做，见 [SUMMARY.md](SUMMARY.md)。

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

## 非 root 运行身份

`scripts/m5b/matrix/prepare-nonroot.sh` 建一个专用身份 `m5bmatrix`（uid 995）并打印每处访问授权的
before/after。之后 `stack.sh up` 让 **anchor / provider / supervisor / dispatcher / api** 全部以该身份运行
（PostgreSQL 一直是 `postgres`）。supervisor 的实例 cgroup 在它自己被委托的单元 cgroup 下
（`Delegate=yes` + `DelegateSubgroup=payload`），控制器以该身份写入。运行时的 harness home 与
supervisor 的凭据/env/日志/worktree 目录都搬到了 `/tmp/m5bmatrix`，共享的 `/root/.dsh-m5` 不再被改。

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
- `local-provider` 的 prompt dump 只在 `/tmp/m5bmatrix/provider-prompts.jsonl`，不入库。

## 非 root 运行还需要两样东西

- `prepare-nonroot.sh` 之外，runtime 的 worker 要 clone 私有仓库：该身份在自己的
  `/home/m5bmatrix/.ssh` 有一份 0600 的 agent 私钥副本与 `known_hosts`（源自 root 的
  `/root/.ssh/sa_agent2` 与 `ssh-keyscan -p 443 ssh.github.com`），脚本会实测
  `ssh -T git@ssh.github.com` 输出 `successfully authenticated`。
- 构建测试进程用 `/opt/moyu-node24`，该目录组只读；不安装/不升级任何包。
这两项都只给 `m5bmatrix` 组，退役时可用脚本打印的原始 group/mode 回退。
