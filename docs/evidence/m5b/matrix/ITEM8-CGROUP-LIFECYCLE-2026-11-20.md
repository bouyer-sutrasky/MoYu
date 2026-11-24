# 真实 DSH 实例生命周期与 cgroup 归属现场验收（Issue #94 / PR #102）

2026-11-20 在 `#100` 建好的隔离矩阵内运行；不使用生产实例、不重启 3082、不触碰生产库或
共享 55432 PostgreSQL。

## 基线、身份与命令

| 项目 | 值 |
| --- | --- |
| `main` | `f1d55148169bbcc4791128f6911f7717cdb43748`（已合入 #100 / #101） |
| 被测代码树 | `50e21199cc48692a86e70eef2f40f5e93996cd92`（本分支合入最新 `main` 的 merge commit；证据提交只新增脚本/日志） |
| 宿主 | kernel `6.8.0-53-generic`，cgroup v2，systemd 255 |
| 隔离边界 | `m5bmatrix.slice`（8 GiB，swap 0）；服务身份 `m5bmatrix` uid 995 |
| cgroup 根 | `/sys/fs/cgroup/m5bmatrix.slice/m5bmatrix-supervisor.service/instances` |
| 运行时 | profile `m5b`，面板 `127.0.0.1:3404`，Bridge `127.0.0.1:3403` |

```bash
bash scripts/m5b/matrix/stack.sh up          # exit 0
bash scripts/m5b/matrix/item8-cgroup-lifecycle.sh docs/evidence/m5b/matrix/item8-cgroup-lifecycle.log
# exit 0；34 项 verdict 全部 pass，0 项 FAIL
bash scripts/m5b/matrix/stack.sh down        # exit 0；运行根秘密删除，slice 停止
```

原始脱敏日志：[`item8-cgroup-lifecycle.log`](./item8-cgroup-lifecycle.log)（173 行）。
日志中的 token 一律 `***`；只保留 PID/starttime、cgroup 路径/inode、端口、矩阵内 task/lease
UUID 和容量计数。

## 实际加载的制品

| 制品 | 实际路径 | SHA256 | 大小/版本 |
| --- | --- | --- | --- |
| supervisor | `apps/supervisor/dist/main.js` | `69aa134da721de2e70f406cd01da1e2961e85cb675b8a005724bc52306daa4bf` | 433731 bytes |
| platform API | `apps/api/dist/server.js` | `266248522a2965af412e42445ae6588473c3af9b9d0fdb9464103c87c1be94d6` | 391k |
| dispatcher | `apps/dispatcher/dist/main.js` | `aae1c459f76f55683413ee9dff3e40721fb79c548d5a2a3fed027218198b0004` | 276816 bytes |
| DSH 入口 | `/usr/bin/dsh` → `@deepseek-ai/dsh/lib/bin.js` | `80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f` | 运行时实际 exec |
| DSH 插件 | `/root/src/upstream/m5b-admission-build21`（`dsh-superagent@0.1.0`） | `lib/index.js` `64ce5c5aeb6d0671a195ee5aad66c941a641c29919f1a7603fe64cd0b288df6f`；`package.json` `d428e669805ea1dfb6a4900bddbffe3cafb8f06a0b1eb139266c2b2f6b94b021`；`cordis.patch.yml` `c91fab94d3a27c7068b5f5391907fb4d69342112ad50f987fdfed9985c2c7905` | 548951 bytes entry |

运行时进程 argv：`node /usr/bin/dsh --profile m5b --no-open`；profile 的
`node_modules/dsh-superagent` 实际指向 `/root/src/upstream/m5b-admission-build21`。

## 逐代次记录

| 代次/场景 | 根 PID + starttime | cgroup inode | 递归成员 | 端口 | 租约 | 槽位 |
| --- | --- | --- | --- | --- | --- | --- |
| 初始在线 | 363471 / 346674327 | 1954026 | 1 | 3404 + 3403 | 0 active | 1/1 |
| 休眠 | — | 旧 cgroup 保留（空） | 0 | 释放 | — | 0 |
| 唤醒 | 364051 / 346678256 | 1954117 | 1 | 3404 + 3403 | 0 active | 1/1 |
| 空目录冷启 | 364311 / 346679039 | 1954201 | 2 | 3404 + 3403 | 0 active | 1/1；`memory.current=284819456`、`memory.max=3221225472`、`pids.current=17` |
| 主 PID 退出（后代存活） | 364311 / 346679039 → 已退出 | 1954201（旧对象保留） | 子进程 4 → 0 | 释放 | task `56e4a971…`、lease `0f68f895…` active → released | 1 → 0 |
| 清理后下一代 | 364856 / 346680690 | 1954243 | 1 | 3404 + 3403 | 0 active | 1/1 |
| 陌生进程占端口 | —（启动被拒） | — | — | 陌生 pid 365127 持有 3404；`port_in_use` | 0 active | 0 |
| 释放端口后下一代 | 365201 / 346681930 | 1954285 | 2 | 3404 + 3403 | 0 active | 1/1 |
| 同名 cgroup 重建 | 365201 已退出 | 记录 1954285 → 新对象 1954369 | 陌生 pid 365440 | 释放 | 0 active | **保留 1/1**（`stopping`/`stop_failed`） |
| 清理同名对象后 | — | 旧对象保留 | 0 | 释放 | 0 active | 0 |
| 清理后下一代 | 365579 / 346684563 | 1954411 | 2 | 3404 + 3403 | 0 active | 1/1 |
| supervisor 重启 | 365579 → 365784 / 346685317 | 1954411 → 1954597 | 2 | 3404 + 3403 | 0 active | 1/1 |

## 场景结论

| 场景 | 结果 |
| --- | --- |
| 空目录冷启 | PASS：删除 `instances` 根后唤醒，supervisor 自行建根、启用 `memory`/`pids`，实例子组有 `memory.current`/`memory.max`/`pids.current` |
| 休眠/唤醒 | PASS：休眠后旧 PID/端口/槽位释放，旧 cgroup 保留且递归为空；唤醒得到新 PID、新 starttime、新 inode、同端口监听 |
| 主 PID 退出但后代存活 | PASS：cgroup 内 4 个成员中只杀根，supervisor 停止存活后代、端口释放、槽位释放；task/lease 记录后再释放；下一代可启动 |
| 陌生进程占端口 | PASS：`m5bmatrix` 的陌生监听者持有 3404，supervisor 报 `port_in_use` 并写明 pid/cgroup，进程保持存活；释放端口后 retry 启动下一代 |
| 同名 cgroup 重建 | PASS：记录 inode `1954285`，重建后新对象 `1954369`；陌生 pid 365440 保持存活且仍在新对象内；旧代次保持 `stopping`/`stop_failed`，容量保留 1/1，ownership 仍写旧 cgroup+inode；清理新对象后槽位释放，下一代启动 |
| supervisor 重启 | PASS：`systemctl restart` 后旧 runtime 随单元 cgroup 结束，supervisor 对账并以新 PID/新 inode 恢复在线，端口与槽位恢复 |

## 与前期证据的关系

- 进程/cgroup 原语与单元级回归仍见 `docs/evidence/m5b/cgroup-coldstart-{before,after}.txt` 与
  `cgroup-unit-delegation-{before,after}.txt`；本文件是真实 DSH runtime 的现场续篇。
- `#47` 的 launch 超时联验仍待两边合流后在同一矩阵内进行；本轮没有改动租约/围栏实现。
- 生产 `moyu-m6c`、3082 bootstrap、生产库和共享 55432 PostgreSQL 未触碰；矩阵运行后
  `stack.sh down` 退出 0，运行秘密删除，残留 slice 已停止。
