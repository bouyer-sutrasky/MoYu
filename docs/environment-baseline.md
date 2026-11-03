# 第 0 阶段环境基线（M0）

取证时间：2026-11-03 05:56–06:26 UTC（浏览器/服务器本地时间为 UTC+8）。
范围：`sutrasky/MoYu` 的 M0 兼容性取证，为后续网页、调度服务和受控 superagent 补丁建立可复现基线。
结论：**可继续开发，但必须先按本文件固定上游制品，并保留下列未验证项；不得把现场安装目录直接当作可追溯发布物。**

## 1. 结论摘要

- 现场 superagent 是上游 `deepseek-ai/dsh-superagent-prototype` 的**未修改源码**：216 个文件的清单摘要与 commit `6337fc823ce20251c8de8085948165c81aaa701e` 的 codeload 制品完全一致。
- 现场 Harness 是 npm 包 `@deepseek-ai/dsh@0.2.1-rc.2`，安装文件与 npm tarball 完全一致，入口摘要为 `80112efe…`；对应上游 tag `dsh-v0.2.1-rc.2`（commit `687f282e8625c6b8d11ff58211a90524be2e4317`）。
- 用声明的 `pnpm@11.7.0` 在干净环境中从该 commit 重建：typecheck 通过、build 通过，重建后的 `lib/` 12 个文件摘要与现场安装的 `lib/` **逐文件一致**（清单摘要 `c2ca910f…`）。
- `pnpm check` 的测试为 **1196 / 1197 通过**；唯一失败在可选 Feishu Source 的测试，GitHub/Workspace 路径没有失败。详见 §6。
- 在独立 `DSH_HOME`、独立 profile、独立 state、独立回环端口和独立私有测试仓库中启动了两个实例（3182 / 3183）。两个实例共享同一 GitHub 账号，但 GitHub Source 实际请求的是**仓库级** notifications 端点；各自只落自己仓库的 Trigger，互不吞事件，实例间没有交叉 Trigger。
- 现场 bootstrap 实例（3082，`sutrasky/MoYu`）全程未重启、未改配置、未替换 runtime；本文件的取证只对其做只读检查。
- 兼容性细节与补丁前的精确差异见 [compatibility-findings.md](../integrations/superagent/compatibility-findings.md)，机器可读锁定见 [upstream.lock.json](../integrations/superagent/upstream.lock.json)。

## 2. 主机与运行时

| 项目 | 现场值 | 证据 |
| --- | --- | --- |
| 宿主 | Ubuntu 24.04.2 LTS，内核 6.8.0-53-generic，x86_64，4 vCPU | `/etc/os-release`、`uname -a`、`nproc` |
| 内存 | 15,989 MiB；取证结束时约 13.5 GiB available（13,816 MiB） | `free -m` |
| 磁盘 | `/` 99 GiB，44 GiB 可用（55% 使用） | `df -h /` |
| Node | v22.23.3 | `node --version` |
| npm | 10.9.9 | `npm --version` |
| pnpm | 10.34.7（系统全局）；复现构建用 `pnpm@11.7.0` | `pnpm --version`、`corepack pnpm@11.7.0 --version` |
| Corepack | 0.36.0 | `corepack --version` |
| Git | 2.43.0 | `git --version` |
| Harness CLI | `/usr/bin/dsh` → `/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`；`dsh --version` 为 0.2.1-rc.2 | `readlink -f /usr/bin/dsh`、`dsh --version` |
| Nginx | 1.24.0，持有 80/443 | `nginx -v`、`ss -ltn` |
| 容器 | 当前 PATH 无 Docker / Podman | `command -v docker`、`command -v podman` |
| 端口 | bootstrap 监听 `127.0.0.1:3082`；测试实例使用 3182/3183，测试结束后已关闭 | `ss -ltn` |

现场 Harness 部署文档（`docs/006-deployment.md`）写的是 `0.2.1-rc.3`，实际安装是 `0.2.1-rc.2`。这不构成“版本相近即可兼容”的证据；本基线以实际安装的 rc.2 为准，未来升级需另做兼容验证。

## 3. 实际安装制品与溯源

### 3.1 Harness

| 项 | 值 |
| --- | --- |
| npm 包 | `@deepseek-ai/dsh@0.2.1-rc.2` |
| npm tarball | `https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.1-rc.2.tgz` |
| tarball SHA-256 | `40e3d025c0240c4316ff42dee9bedc7709c0fb38aea10543b47076ed2af52e1d` |
| tarball shasum / integrity | `a502d1551aabc881020e3cb7961c38901565731a` / `sha512-tvY+yhfKRifthbqPe/OK0AYxM5ZkvqfYq/jMYgJcEUxiRRL1Vwra3Ti5TB6AXgSWQdiPHYh/Vp6SJa9yHwMNuw==` |
| 上游 tag | `dsh-v0.2.1-rc.2` |
| tag commit | `687f282e8625c6b8d11ff58211a90524be2e4317`（release merge，2026-10-17T07:22:43Z） |
| 安装目录 | `/usr/lib/node_modules/@deepseek-ai/dsh` |
| 入口摘要 | `lib/bin.js` SHA-256 `80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f` |
| 包文件 | 20 个；清单摘要 `1e001a9d058149eb84a8646dc547789aa370d541f98b0ab2d368bf6b13f0fd34` |

包本身没有 `gitHead` 元数据，因此不能凭 package.json 写出 commit。这里用“npm 版本 + tarball 摘要 + 上游 tag/commit”三条证据建立可追溯关系；安装文件与 npm tarball 逐文件比较只多出 `node_modules/`，没有本地代码改动。

### 3.2 superagent

| 项 | 值 |
| --- | --- |
| 包 | `dsh-superagent@0.1.0`（private） |
| 上游仓库 | `https://github.com/deepseek-ai/dsh-superagent-prototype` |
| 固定 commit | `6337fc823ce20251c8de8085948165c81aaa701e`（2026-10-31T12:05:39Z，`main`） |
| 上游 tree | `3efbb036e5a56183c6bf642e2e1856a1f64e7be3` |
| codeload tarball | `https://codeload.github.com/deepseek-ai/dsh-superagent-prototype/tar.gz/6337fc823ce20251c8de8085948165c81aaa701e` |
| tarball SHA-256 | `31402e86aed27ef173d47d1eb8e36fd7baaf818050dbcdf8ebb8c59caf083659` |
| 许可证 | MIT |
| 安装目录 | `/root/dsh-superagent`（无 `.git`、无 `gitHead`） |
| 源码文件 | 216 个（排除 `node_modules/`、`lib/`、`.artifacts/`） |
| 源码清单摘要 | `d50cacb9be5acd49553a44af48df6b4774e5428bf036e204811ed40e2f3c6711` |
| 安装 `lib/` | 12 个文件，清单摘要 `c2ca910f54b990455ed3ded026d858a7b480ad1ffdb562e50ad4f0b9bf0d1047` |

溯源方法（不编造 commit）：

1. `gh api repos/deepseek-ai/dsh-superagent-prototype/commits/6337fc…` 与 `git ls-remote … refs/heads/main` 确认 commit 与远端 `main` 指向。
2. 下载 codeload tarball 并计算 SHA-256；解包后用 `diff -rq --exclude=node_modules --exclude=.git --exclude=lib --exclude=.artifacts` 与 `/root/dsh-superagent` 比较，无差异。
3. 用“排序后的逐文件 SHA-256 清单再取 SHA-256”的固定方法生成清单摘要（见 `upstream.lock.json` 的 `manifestMethod`），安装目录与固定 commit 的摘要相同。
4. 安装文件的 mtime 为 2026-10-31 20:05（UTC+8），与 commit 的 12:05Z 相符，但 mtime 只作辅助，不作为 commit 证据。

`docs/research/server-environment.md` 记录的入口摘要 `80112efe…` 与本次复测一致，说明现场没有被热替换成另一份 Harness 入口。

## 4. 可复现构建

在 `/root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2` 中执行：

```bash
export COREPACK_HOME=/root/src/upstream/.corepack
corepack pnpm@11.7.0 install --frozen-lockfile
```

结果：lockfile 通过供应链策略检查，234 个包解析完成；`proper-lockfile 4.1.2`、`zod 4.4.3` 安装成功。

```bash
env -i HOME=/root/src/upstream/m0-home \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  COREPACK_HOME=/root/src/upstream/.corepack CI=1 \
  corepack pnpm@11.7.0 typecheck
# exit 0

env -i ... corepack pnpm@11.7.0 build
# exit 0；ESM 产物 11 个文件、693.50 kB，另有 CJS client.js 1 个；共 12 个文件

env -i ... corepack pnpm@11.7.0 test
# 1196 passed, 1 failed；见 §6
```

重建后的 `lib/` 与现场安装 `/root/dsh-superagent/lib/` 的 12 个文件 SHA-256 完全一致；两份清单的摘要都是 `c2ca910f…`。因此可以确认现场运行的就是这个 commit 构建出来的 bundle，而不是“版本号相同”的近似物。

**环境陷阱（很重要）**：在由 dsh worker 启动的 shell 里直接跑 `pnpm check`，会继承 `GIT_CONFIG_GLOBAL=/root/.dsh/state/superagent/worker-gitconfig` 和 worker-bin 的 `PATH`，导致 `tests/runtime.spec.ts` 的两条环境测试失败（连同 Feishu 测试共 3 条）。复现时必须使用上面的 `env -i` 干净环境，否则会把测试环境污染误判为版本不兼容。

## 5. 隔离复现

### 5.1 隔离边界

| 项 | bootstrap（保持不动） | 测试实例 A | 测试实例 B |
| --- | --- | --- | --- |
| `DSH_HOME` | `/root/.dsh` | `/root/.dsh-m0` | `/root/.dsh-m0` |
| profile | `superagent` | `m0a` | `m0b` |
| state | `/root/.dsh/state/superagent` | `/root/.dsh-m0/state/m0a` | `/root/.dsh-m0/state/m0b` |
| 端口 | 3082 | 3182 | 3183 |
| GitHub 仓库 | `sutrasky/MoYu` | `Bouyer12/m0-compat-a-5b173b63` | `Bouyer12/m0-compat-b-5b173b63` |
| 运行方式 | systemd + tmux（原有） | tmux，独立 profile | tmux，独立 profile |
| 使用的 bundle | `/root/dsh-superagent` | 固定 commit 的新构建目录 | 同 A |

测试实例由支持的 profile 模板创建，没有复制 bootstrap 的 profile、state 或凭据：

```bash
env DSH_HOME=/root/.dsh-m0 dsh --profile m0a --from-default-profile web --dump-config >/dev/null
env DSH_HOME=/root/.dsh-m0 dsh plugin --profile m0a \
  add "link:/root/src/upstream/superagent-tar/dsh-superagent-prototype-6337fc823ce2"
```

然后在 `cordis.patch.yml` 只设置独立 `webserver.port` 和 `dsh-superagent.stateDir`；Sources / Policy / Execution 通过本机管理 API 保存。测试 profile 的 `node_modules/dsh-superagent` 指向固定 commit 的构建目录，`lib/index.js` 摘要与 bootstrap 的安装一致（`98595370…`）。

### 5.2 通知实验（真实 GitHub，非 mock）

测试仓库为 `Bouyer12` 下的两个私有临时仓库，各有一个 Issue #1。工作流由 `github-actions[bot]` 在 Issue 下写入 `@Bouyer12` 的评论，产生真实通知；两个实例都使用专用账号 `Bouyer12` 的 CLI。测试实例的 Policy 故意设为 `allowed: []`，因此 bot 评论被记录为 Trigger，但决策是 `not_human`，不会进入 worker，也不会调用模型。

| 时间（UTC） | 事件 | 实例 A（仓库 A） | 实例 B（仓库 B） |
| --- | --- | --- | --- |
| 06:14:13 | 仓库 A 的 bot 评论 | 收到，Trigger `at=06:14:13` | — |
| 06:14:18 | 仓库 B 的 bot 评论（B 首次启动前） | — | **未收到**（首次轮询的 `since` 晚于评论） |
| 06:18:43 | 仓库 B 的 bot 评论（B 启动后） | — | 收到，Trigger `at=06:18:43` |
| 06:18:44 | 仓库 A 的 bot 评论 | 收到，Trigger `at=06:18:44` | — |
| 06:21:04 | 仓库 A 的 bot 评论（A 停机期间） | 重启后补收，Trigger `at=06:21:04` | — |

结果：

- A 最终 3 个 Trigger、3 个 Decision；B 最终 1 个 Trigger、1 个 Decision。每个实例的 Trigger URL 只指向自己的仓库，没有跨仓库 Trigger。
- B 启动前已存在的评论没有被补收；这符合“新实例从首次轮询开始”的行为。A 停机期间产生的评论在重启后被补收，证明持久化 `github-since` 游标和稳定 Trigger ID 能在重启后补收且不重复。
- 实例轮询后，账号级 `gh api notifications` 仍有 3 条未读（两个测试仓库 + `sutrasky/MoYu`）；实例没有把通知标为已读。两个实例的 `github-since`、`github-cursor:<n>` 分别保存在自己的 state 数据库。
- GitHub Source 的 `notifications?all=true` 经 `Commands.api` 被限定为 `repos/<repository>/notifications`，因此两个不同仓库的实例实际使用**仓库级**通知流，不会相互消费；账号级列表只用于外部核对。

### 5.3 资源观测

- 测试实例 A/B 的 Node RSS 分别约 280 MiB / 278 MiB；bootstrap 约 337 MiB。
- 取证期间（含两个测试实例、pnpm 构建/测试、shell）bootstrap 所在 cgroup 的 `memory.peak` 为 1,658,384,384 B（约 1.54 GiB）；结束后 `MemoryCurrent` 约 676 MiB。
- 这只能说明本次空闲取证未接近 6 GB 常态预算；不能替代阶段 5 的代表性构建、子进程和压力测量。

## 6. 兼容性检查结果

| 检查 | 结果 |
| --- | --- |
| 安装版本与 tarball 一致性 | 通过（Harness 20 个包文件；superagent 216 个源码文件） |
| 从固定 commit 重建 | 通过；typecheck、build 成功；重建 `lib/` 与安装 `lib/` 逐文件一致 |
| 上游测试 | 1196/1197 通过；1 条 Feishu 测试失败（见下） |
| 独立 profile 启动 | 通过；两个实例均进入 `ready`，Source 实际轮询 |
| 仓库级通知隔离 | 通过；无跨仓库 Trigger |
| 停机后补收 | 通过；A 补收停机期间评论，无重复 |
| 账号未读状态 | 未被实例消费；取证后仍有 3 条未读 |
| Source / Session / stop-retry / 模型接口 | 代码级核对完成，详见 findings；运行时只验证了 Source/Engine 路径，未跑真实任务 |

唯一失败测试的原文：

```text
FAIL tests/sources.spec.ts > feishu event consumer > takes in the event lines it reads,
records each chat as direct or not, and reports a malformed line without stopping
AssertionError: expected { state: 'ready', …(2) } to match object { state: 'error', …(1) }
Received: { state: 'ready', detail: 'Listening for bot events' }
Expected: { state: 'error', detail: containing 'JSON' }
```

该测试在干净环境中多次运行（整包检查 1 次、单测连续 3 次及单独复现 1 次）均失败；它属于可选的 Feishu Source，不在 GitHub/Workspace Source、Session、stop/retry 或模型路径上。M0 不修上游测试，但后续若要使用 Feishu，必须先修好或隔离这条测试，不能把 `pnpm check` 全绿作为前提谎报。

## 7. 未验证项

1. **真实任务闭环**：隔离实例只验证了 Source 通知、Trigger 入库、gate 决策；没有在测试仓库跑 worker、写文件、开 PR。没有用 mock 冒充接单或 PR 完成。
2. **模型调用**：测试 profile 没有配置模型，未在隔离实例发起模型请求；bootstrap 的实际运行依赖同一 bundle，但不能据此代替隔离测试。模型消息、推理、预算错误和逐 token 事件属于未验证。
3. **stop / retry 的真实运行语义**：只做了代码级核对（见 findings）；没有在真实 Ticket 上执行停止、重试、等待停止完成和恢复。上游 stop 是终态、retry 是新 Assignment，不能直接当作本项目“可恢复暂停”。
4. **补丁尚未实现**：workspace Source、机器 Bridge、可恢复暂停、任务模型、统一执行准入都只有差异与落点，没有代码。
5. **两实例同仓库**：本实验是两个不同仓库；架构上同仓库应只运行一个实例，没有验证“同仓库双实例”的冲突行为（也不建议这样部署）。
6. **长时间通知延迟**：观察到 GitHub 通知相对评论有约 15–25 秒延迟；5 秒游标回退能覆盖本次实验，但没有证明在更长延迟、限流或通知保留期外的丢事件行为。
7. **非 root 运行**：测试实例仍在 root 下，只做到独立 `DSH_HOME`/state/端口/仓库；生产必须按开发指南使用专用非 root 身份，本 M0 没有验证该隔离强度。
8. **资源预算**：只测了本次取证的空闲/构建峰值，没有代表性构建、worker 子进程、持续任务和 6 GB/8 GB 边界测量。
9. **旧实例的账号授权与允许名单**：沿用现场记录；本次没有重新做 GitHub 权限审计，也没有改动旧实例的监听仓库。
10. **网页/Passkey/数据库/Compose/Nginx 站点**：属于后续阶段，本阶段未实现或验证。

## 8. 变更、迁移与回滚

本 PR 只新增文档和锁定文件，不修改 Harness、superagent、bootstrap profile、state 或服务；没有数据库迁移。

- 回滚：直接 revert 本 PR 的提交。`docs/environment-baseline.md`、`integrations/superagent/` 是新增文件，删除即回到取证前文档状态。
- 清理测试实例（取证后已停止）：`tmux kill-session -t m0a`、`tmux kill-session -t m0b`（如仍存在）；测试端口 3182/3183 应无监听。
- 可选清理测试缓存：`/root/.dsh-m0`（profile/state，约 1.1 MB）与 `/root/src/upstream`（tarball、构建缓存，约 223 MB）。保留它们便于复核；删除不影响 bootstrap。
- 可选删除临时测试仓库：`Bouyer12/m0-compat-a-5b173b63`、`Bouyer12/m0-compat-b-5b173b63`。它们只含 M0 探针文件/Issue，不含秘密；删除是破坏性操作，建议在 PR 审阅后由所有者执行。
- bootstrap 保持原状：3082 仍监听，`dsh-superagent.service` 仍 active；本阶段没有写它的 profile/state（实例自身正常运行产生的数据库写入不属于本阶段改动）。

## 9. 复核命令

```bash
# 对照 lock 的安装制品
integrations/superagent/verify-lock.sh

# 手工核对固定 commit（需要网络）
gh api repos/deepseek-ai/dsh-superagent-prototype/commits/6337fc823ce20251c8de8085948165c81aaa701e
git ls-remote https://github.com/deepseek-ai/dsh-superagent-prototype.git refs/heads/main

# 干净环境重建（在固定 commit 的 checkout 中）
env -i HOME=/root/src/upstream/m0-home \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  COREPACK_HOME=/root/src/upstream/.corepack CI=1 \
  corepack pnpm@11.7.0 install --frozen-lockfile
env -i ... corepack pnpm@11.7.0 typecheck
env -i ... corepack pnpm@11.7.0 build
env -i ... corepack pnpm@11.7.0 test

# 只读检查现场 bootstrap（不要重启或写配置）
ss -ltn | grep 3082
curl -sS -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state
```
