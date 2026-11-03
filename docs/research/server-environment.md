# 京东云运行环境

现场核对日期为 2026-11-03。工作区部署资料与 SSH 配置共同指向 `jd-mc`，通过 BatchMode 和已有主机密钥只读核对。另参考本地既有部署记录 `E:/workplace/dsh-superagent-research/京东云部署-可行性评估.md` 第9至12节；该本地原始记录不随GitHub交接包发布，关键脱敏结论已包含在本文。

| 项目 | 现场证据 |
| --- | --- |
| 宿主 | Ubuntu 24.04.2 LTS，内核 6.8.0-53-generic，4 vCPU，内存 15,989 MiB，快照可用 13,839 MiB，交换分区 4,095 MiB |
| 存储 | 根分区 99 GiB，43 GiB 可用，使用率 55% |
| 运行时 | Node 22.23.3，pnpm 10.34.7，Git 2.43.0；未发现 Docker CLI、Compose 或 Docker/containerd unit，Podman CLI 也未发现 |
| Harness | `/usr/bin/dsh` 指向 `/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`；CLI 与包版本 0.2.1-rc.2，包无 gitHead；入口 SHA-256 为 `80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f` |
| superagent | `/root/dsh-superagent`，包版本 0.1.0；目录无 .git，包无 gitHead；旧记录称从 codeload tarball 解包后构建。锁文件 SHA-256 为 `ba6b997c448984a04b28eeb5b620c14c7cfeff5eb170e1abd6e0734007405c39` |
| 实例 | `/root/.dsh/profiles/superagent` 与 `/root/.dsh/state/superagent`。`dsh-superagent.service` 启用，oneshot、active/exited、MainPID 0，实际 tmux、Node 与 gh 进程仍在服务 cgroup 内。启动脚本 `/usr/local/bin/sa-start.sh`；`dsh-superagent-check.timer` 启用，旧记录显示巡检尊重 stop 标记。 |
| 网络 | superagent Node 监听 `127.0.0.1:3082`。nginx 1.24.0 持有 80/443，现有 TLS 站点包括 `code.sutrasky.com`、`ui.sutrasky.com`、`preview.sutrasky.com`。启用站点抽查未见 3082 的反代；Workspace 专用域名及 DNS 尚未确认。 |
| 资源 | cgroup v2，memory、cpu、io、pids 控制器存在。现有 superagent 单元快照约 388 MiB、观测峰值约 422 MiB，MemoryHigh/MemoryMax 为 infinity。该样本未覆盖代表性构建，也无法证明新平台总预算。 |

## GitHub 来源与新增实例

SQLite 使用 immutable 只读打开，检查落盘设置版本 3，仅提取白名单字段。GitHub Source 当前指向 `sutrasky/personal-ui-assets`，执行器 maxWorkers 为 2。现有 `/root/src/widgets` 的 SSH origin 指向同一仓库，HEAD 为 `e118ed2421341ba35f48dd8b1e2a2d0504492f22`，这是工作仓库 commit。历史部署记录给出 agent 登录名 `Bouyer12`、允许请求者 `sutrasky` 及包装器 `/root/.local/bin/gh-agent`；现场未再次验证账号授权和允许名单，immutable 读取也可能落后于 WAL。

新建 GitHub 仓库需要让专用账号取得所需访问与推送权限，并为新仓库设置独立 profile、状态目录、GitHub Source repository、允许请求者、工作 checkout、回环端口与执行限额。已有实例只按原仓库匹配，继续服务原仓库。既有部署记录表明 SSH over 443 可用于 clone/fetch/push，启用前应重测可达性、当前授权、管理 API 与 Source 的准入行为，并核对多实例共享账号时通知的消费语义。profile 需要能加载相同版本的 Harness/superagent、预设与模型配置；配置应通过受支持的 setup/settings 流程生成，部署前用隔离测试验证。

现有服务和 worker 在 root 上下文运行。新实例应先在非 root 的受限身份和独立文件/凭据边界内验证，再将平台、数据库和执行子进程纳入共同 cgroup 核算。新服务可复用 nginx 增设独立 HTTPS 站点与回环后端，域名确认后固定 WebAuthn RP ID；现有端口分配使直接引入一个同样绑定 80/443 的 Caddy 有冲突。容器方案仍需要准备容器运行时，或明确验证独立 systemd 运行方案的隔离与资源边界。

实际安装的上游 commit 尚未恢复。二进制入口与锁文件摘要只能辅助比对，实施前需从可追溯部署制品确认 commit 或选定可复现版本，并核验 Source、Session、停止、模型、账号共享与重启恢复。现场只执行检查，未修改服务、配置或仓库。
