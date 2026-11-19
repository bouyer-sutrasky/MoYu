# 动态实例实际启动与固定 profile 回归（隔离栈）

2026-11-19 在宿主机隔离栈执行。范围是 Issue #87 第 1 项返修：不是只校验
home 里的 gh 配置，而是让真实 supervisor 以服务身份启动真实 dsh runtime，
完成账号校验、写入 `source:github`、进入 online，并核对两份独立 runtime home。

## 环境

| 项 | 值 |
| --- | --- |
| supervisor 身份 | `moyu-m6c`（uid 988 / gid 982），真实 setpriv 能力边界 |
| DSH_HOME | `/tmp/moyu-iso-pr88/dsh`（一次性目录） |
| 数据库 | 隔离 PostgreSQL `moyu_iso_pr88`（端口 55432，非生产库） |
| profile 模板 | 真实 `/opt/moyu-m6c/profile-template` 的副本 |
| GitHub CLI | 真实 `/opt/moyu-m6c/bin/gh-agent` |
| gh 配置来源 | `/var/lib/moyu-m6c/.config/gh-agent`，只读，复制到每个 home |
| 动态仓库 | `Bouyer12/moyu-e2e-public-20261119`、`Bouyer12/moyu-e2e-private-20261119` |
| 固定 profile 仓库 | `Bouyer12/m5a-beta-adf10ad9`，runtimeUid/Gid 6201，runtimeHome 在临时 homes 根内 |

## 步骤（命令摘要）

1. 复制 profile 模板、`.env`、`.credentials.yaml` 和 `.ssh` 到临时 DSH_HOME；
   `.env` 只含模型 provide key，不进仓库、不打印。
2. 创建独立数据库并迁移，写入 owner 和三个仓库行；`instances.json` 只固定
   `iso-pin` 的 profile/端口/runtimeUid/runtimeHome，动态仓库走模板分配。
3. 创建隔离 cgroup 根并交给 `moyu-m6c`；给 supervisor 写入
   `MEMORY_BUDGET_MB=32768`、`AGGREGATE_CGROUP` 等一次性配置。
4. 用 `setpriv` 以 `moyu-m6c` 启动 supervisor，并只保留
   `CAP_SETUID/SETGID/SETPCAP/KILL/CHOWN/FOWNER/FSETID/DAC_OVERRIDE`。
5. 调 supervisor 控制接口 `prepare`/`wake` 两个动态仓库，轮询数据库直到
   两个都是 `online/listening`；随后用同样方式对固定 profile 做首次启动。
6. 对每个实例读取 `/proc/<pid>/environ`、`/proc/<pid>/status`，并调用 runtime
   panel 的 `/state`、`/settings`；不读取或输出任何 token。

## 结果

原始脱敏事实：`runtime-facts.json`；supervisor 生命周期日志：
`supervisor-redacted.log`。

- 两个动态实例同时在线：
  - public：profile `iso-1`，uid/gid `988/982`，HOME/DSH_HOME
    `/tmp/moyu-iso-pr88/dsh/homes/iso-1`，panel
    `repository=Bouyer12/moyu-e2e-public-20261119`、`agent=Bouyer12`、
    `runtime=ready`、`stateDir=.../iso-1/state/iso-1`。
  - private：profile `iso-2`，uid/gid `988/982`，HOME/DSH_HOME
    `/tmp/moyu-iso-pr88/dsh/homes/iso-2`，panel 同仓库/账号且 ready。
  - 两个 home 不同，`TMPDIR`/`XDG_CACHE_HOME` 也在各自 home 下；两个实例的
    `source:github.config.repository` 分别是各自仓库。
- 固定 profile 首次启动：
  - profile `iso-pin`，uid/gid `6201/6201`，HOME/DSH_HOME
    `/tmp/moyu-iso-pr88/homes/iso-pin`，panel `runtime=ready`、`agent=Bouyer12`、
    `source:github` 为 `Bouyer12/m5a-beta-adf10ad9`。
- 启动耗时（spawn → online，真实日志）：
  - `iso-1` 约 12.8 秒，`iso-2` 约 11.1 秒；Git 副本在启动过程中准备完成，
    HEAD 分别为 `1231d426b82d...` 和 `d387f9af7dbb...`，与现场记录一致。
  - 固定 profile `iso-pin` 首次启动约 8.6 秒。

## 本次返修附带的启动竞态修复

固定 profile 首次启动曾稳定失败在 `gh-agent api user was stopped before it
finished`。原因是 `configureProfile` 先写 `source:workspace`，该保存会安排一次
延迟的 setup restart；紧接着写 `source:github` 的账号探测被这次 restart 中止。
`configureProfile` 现在先保存 `source:github`，并在返回 `restarting: true` 后等待
runtime 重新 ready 再写下一块。上面的固定 profile 结果就是修复后的首次启动；
动态两实例也在同一版本下通过。

## 清理

验证完成后停止隔离 supervisor 和 runtime，删除临时 profile/home/worktree/
credentials/env/log 与隔离数据库；生产数据库、`/var/lib/moyu-m6c` 下的 home、
生产 supervisor 和 GitHub 远端均未修改。日志与 JSON 不含 token、私钥或
`.env` 内容。
