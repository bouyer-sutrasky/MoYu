# M5-B 现场验收环境隔离（M5B-D02F07F-HARNESS-ISOLATION）

日期：2026-11-08。基线：`main@d02f07f1483e0c85a13c1dfe24d03d855a72d0a1`（Issue #36；来源 #31 / PR #32 的全线复验）。
实现 head 见 PR 固定评论。本文记录**只读预检 + 代码/夹具修复**；现场收敛与专用凭据属于所有者动作，
未执行，因此本目录的现场矩阵复跑仍被阻断（见 §4、§5）。

## 1. 现状（只读预检）

```bash
node scripts/m5b/matrix/precheck.mjs
```

原始输出（脱敏；不含任何 token、私钥或文件内容）：

```text
# M5-B matrix isolation precheck
recorded=2026-11-08T04:57:28.847Z
host=lavm-flnape7bgu user=m5bmatrix
matrix_home=/home/m5bmatrix
ssh_key=/root/.config/m5bmatrix/probe_ssh_key
gh_config=/root/.config/m5bmatrix/gh
run_root=/tmp/m5bmatrix
probe_repositories=Bouyer12/m5a-beta-adf10ad9
forbidden_repository=bouyer-sutrasky/MoYu

## identity
  PASS       m5bmatrix — uid=995 gid=986 groups=986
## host-boundary
  PASS       /root — owner=0 mode=0710 computed=not-writable observed=not-writable
  PASS       /root/.ssh — owner=0 mode=0700 computed=not-writable observed=not-writable
  PASS       /root/.dsh — owner=0 mode=0755 computed=not-writable observed=not-writable
  FAIL       /root/.dsh-m5 — owner=0 mode=0770 computed=writable observed=writable
  PASS       /root/.config — owner=0 mode=0710 computed=not-writable observed=not-writable
  FAIL       /root/.config/gh-agent — owner=0 mode=0770 computed=writable observed=writable
  PASS       /root/.local — owner=0 mode=0710 computed=not-writable observed=not-writable
  PASS       /root/.local/bin — owner=0 mode=0750 computed=not-writable observed=not-writable
  PASS       /root/src — owner=0 mode=0710 computed=not-writable observed=not-writable
  PASS       /root/src/upstream — owner=0 mode=0710 computed=not-writable observed=not-writable
  PASS       /opt/moyu-node24 — owner=0 mode=0750 computed=not-writable observed=not-writable
  PASS       /etc — owner=0 mode=0755 computed=not-writable observed=not-writable
  PASS       /root/.ssh/sa_agent — mode=0600 computed=not-readable observed=not-readable
  PASS       /root/.ssh/sa_agent2 — mode=0600 computed=not-readable observed=not-readable
  PASS       /root/.ssh/id_ed25519 — mode=missing computed=not-readable observed=not-probed
  FAIL       /root/.config/gh-agent/hosts.yml — mode=0660 computed=readable observed=readable
  PASS       /root/.dsh/.credentials.yaml — mode=0600 computed=not-readable observed=not-readable
  FAIL       /root/.dsh-m5/.credentials.yaml — mode=0660 computed=readable observed=readable
  FAIL       /root/.dsh-m5/instances.json — mode=0660 computed=readable observed=readable
## credentials
  INCOMPLETE ssh-key:/root/.config/m5bmatrix/probe_ssh_key — the matrix SSH key does not exist: /root/.config/m5bmatrix/probe_ssh_key
  INCOMPLETE gh-config:/root/.config/m5bmatrix/gh — the matrix gh config does not exist: /root/.config/m5bmatrix/gh
## scope
  SKIP       online-probes — run with --online to check repository reach
## run-layout
  FAIL       /tmp/m5bmatrix — owner=995 mode=0755
  INCOMPLETE protected — absent (created by stack.sh)
  INCOMPLETE config — absent (created by stack.sh)
  FAIL       legacy-secret:supervisor-token — owner=0 mode=0600 outside the protected directory
  FAIL       legacy-secret:seed.env — owner=0 mode=0600 outside the protected directory
  PASS       legacy-secret:state.env — absent
  FAIL       bridge-credentials — 56 stale bridge credential file(s) from earlier runs
  PASS       dsh-home — owner=995 mode=0700

verdict=violated
```

命令退出码 1。判定（现场事实）：

1. `m5bmatrix` 对宿主共享配置**有写权限**：`/root/.dsh-m5`、`/root/.config/gh-agent` 当前都是
   `root:m5bmatrix 0770`（应回到 `root:root 0700`）。这是上一版 `prepare-nonroot.sh` 的
   `g+rwX` 授予，尚未收敛。
2. `m5bmatrix` 能**读**共享凭据：`/root/.config/gh-agent/hosts.yml`（0660）、
   `/root/.dsh-m5/.credentials.yaml`、`/root/.dsh-m5/instances.json`（0660）。
3. 测试身份仍持有宿主 agent 私钥的副本：`/home/m5bmatrix/.ssh/sa_agent2`（内容与
   `/root/.ssh/sa_agent2` 相同；见 `prepare-nonroot.sh --check` 输出）。
4. 专用探测凭据不存在（`/root/.config/m5bmatrix/probe_ssh_key`、`/root/.config/m5bmatrix/gh`）。
5. 运行根 `/tmp/m5bmatrix` 属 `m5bmatrix`（0755），而特权引导文件 `supervisor-token`、`seed.env`
   就写在它下面——测试身份可以替换路径，root 的写入会跟随到别处。
6. 历史运行累计留下 56 个 Bridge 凭据文件，未随停止清理。

```bash
bash scripts/m5b/matrix/prepare-nonroot.sh --check
# 关键行：
#   /home/m5bmatrix/.ssh/sa_agent2  owner=m5bmatrix mode=600
#   refused=copy-of-host-agent-key (run --revoke to remove)
#   ssh_credential=missing path=/root/.config/m5bmatrix/probe_ssh_key
#   gh_credential=missing path=/root/.config/m5bmatrix/gh/hosts.yml
#   WRITE /root/.dsh-m5 via /root/.dsh-m5 (group)
#   WRITE /root/.config/gh-agent via /root/.config/gh-agent (group)
# 退出码 1
```

## 2. 代码修复

### 2.1 `scripts/m5b/matrix/guard.mjs`（新）

隔离规则的唯一实现，shell 与测试共用：

- `auditHost` / `assertNoHostWrite`：按 owner/group/mode 逐级计算测试身份对宿主路径的写权限。
  **父目录可写也算违例**——能替换目录项就能替换文件；`sticky` 目录（如 `/tmp`）不会把
  “新建名字”误报为“替换既有文件”。共享凭据的可读性单独审计。
- `prepareRunRoot` / `prepareDir`：运行根必须由 root 拥有（0755，/tmp 的 sticky 位保护它不被改名），
  受保护目录 `protected/` 0700 root，共享配置目录 `config/` 0750 root:matrix，测试身份自己的
  目录 0700 且逐级拒绝符号链接。
- `writeSecuredFile` / `readSecuredFile` / `removeSecuredFile`：每次写入前重新校验目录的
  owner/mode；目标若是符号链接直接拒绝（不跟随）；先写 `wx` 临时文件、`fsync`、再 `rename`，
  部分写入不会变成生效 token。
- `cleanOwnedDir`：只清空经过校验、由测试身份拥有的目录；`rmSync` 只删除链接本身，不跟随。
- `assertDedicatedSshKey`：拒绝 `/root/.ssh` 内的路径，也拒绝**改名后的同内容副本**（sha256 比对
  宿主所有 key 文件）；要求 0600。
- `assertDedicatedGhConfig`：拒绝复用 `/root/.config/gh-agent`，要求专用目录 0750/文件 0640 且
  含非空 `oauth_token`；只报告“token present”，不输出内容。
- CLI：`prepare-run`、`check-run`、`write-protected`、`write-config`、`read-protected`、
  `remove-protected`、`clean-owned`、`audit-host`、`audit-credentials`。

### 2.2 `stack.sh` / `lib.sh`

- 单次运行的布局分区：`protected/`（0700 root：supervisor token、seed、state）、`config/`
  （0750 root:matrix：`instances.json`）、`tmp/ credentials/ instance-env/ instance-logs/ worktrees/
  dsh-home/`（0700 m5bmatrix，临时状态）。预置 token 与 seeded 会话 token 不再落在测试身份可写的
  `/tmp/m5bmatrix` 根下。
- root 不再向测试身份拥有的目录做 `chown -R`/写入：profile 先在 root 独有的 `stage/` 生成，
  `chown` 给测试身份后由**该身份自己**复制进 `dsh-home/`；路径被替换时受害的只能是它自己的文件。
- 生命周期：`down` 删除 `supervisor-token`、`seed.env`、`state.env` 并清空 Bridge 凭据目录；
  `up` 重建前清空临时状态，历史凭据不再跨运行累积。
- `up` 前置校验：`m5b_audit_host`、`m5b_audit_credentials`、仓库产物与 gh wrapper 的可读/可执行性；
  任一失败立即退出（fail closed），不会带着共享凭据启动矩阵。
- `GITHUB_CLI` 改为仓库内的 `gh-m5b.sh`，固定 `HOME`/`GH_CONFIG_DIR` 到专用配置。

### 2.3 `prepare-nonroot.sh`

- 只授予读/遍历权限：`/root` 0710、`/root/src` 0710、仓库树 `g+rX`、upstream 构建 `g+rX`、
  `/root/.local/bin` 0750、`/opt/moyu-node24` g+rx；**不再**给 `/root/.dsh-m5`、
  `/root/.config/gh-agent` 或任何 DSH home 写权限。
- 专用凭据：`M5B_MATRIX_SSH_KEY` 安装为 `/home/m5bmatrix/.ssh/probe_deploy`（0600），
  `M5B_MATRIX_GH_CONFIG_DIR` 0750/0640；缺失时打印所有者动作并返回非零。
- `--check` 只读；`--apply` 安装读授权与凭据；`--revoke` 由所有者执行，把
  `/root/.dsh-m5`、`/root/.config/gh-agent` 收敛回 `root:root 0700/0600`，并删除测试身份手里的
  宿主 agent 私钥副本。

### 2.4 `apps/supervisor/src/provision.ts`

“特权引导文件”在 supervisor 侧的写入也收紧：

- `ensurePrivateDir`：拒绝路径上任一符号链接；要求目录属当前进程 uid；修复 mode 到 0700。
- `writePrivate`：写入前再校验父目录；目标为符号链接/非普通文件/属主不符一律拒绝；
  `wx` 临时文件 + `fsync` + `rename`，保持 0600。
- 新增 `apps/supervisor/test/provision-private.test.ts` 覆盖重跑、链接替换、宿主 sentinel 不变。

### 2.5 脚本配套

- `live.mjs` 默认 state 路径改为 `<run>/protected/state.env`；
- item 5/6 的 provider/worker 交互文件改到 `<run>/tmp/`，`supervisor-token` 走受保护读取；
- `item5-awaiting-review.sh` 的 gh 调用改用 `gh-m5b.sh`（专用配置）。

## 3. 隔离回归（夹具）

```bash
node --test scripts/m5b/matrix/guard.test.mjs
```

```text
# tests 19
# pass 19
# fail 0
```

覆盖：运行布局与 0700/0750/0755 校验、重跑幂等且 token 保持 0600、符号链接 bootstrap 文件被拒且
宿主 sentinel 不变、符号链接受保护目录/父目录被拒、组可写受保护目录被拒、`cleanOwnedDir` 不跟随
链接、宿主组可写目录被审计为违例、共享凭据可读被审计、改名后的宿主 key 副本被拒、共享 gh 配置
被拒、`prepareRunRoot` 拒绝符号链接运行根、CLI 端到端重跑与恶意路径替换（exit 1 且 sentinel 不变）。

```bash
corepack pnpm --filter @moyu/supervisor test
```

```text
Test Files  7 passed (7)
     Tests  43 passed (43)
```

其中 `test/provision-private.test.ts` 新增 5 个用例：0700 目录与重跑、原子覆盖保持 0600、
符号链接凭据文件被拒且宿主 sentinel 不变、符号链接凭据目录被拒、路径中段符号链接被拒。

## 4. 需要所有者执行的具体动作

本节动作会改动宿主共享配置或轮换共享凭据，按 Issue #36 的要求单独列明，本单只做只读预检与代码。
顺序执行：

1. **收敛旧写授权**（把上一版 harness 改宽的宿主配置改回 0700/0600）：

   ```bash
   bash scripts/m5b/matrix/prepare-nonroot.sh --revoke
   ```

   等价命令（若不想用脚本）：

   ```bash
   chgrp -R root /root/.dsh-m5 && find /root/.dsh-m5 -type d -exec chmod 0700 {} + \
     && find /root/.dsh-m5 -type f -exec chmod 0600 {} +
   chgrp -R root /root/.config/gh-agent && find /root/.config/gh-agent -type d -exec chmod 0700 {} + \
     && find /root/.config/gh-agent -type f -exec chmod 0600 {} +
   rm -f /home/m5bmatrix/.ssh/sa_agent2
   ```

2. **轮换共享凭据**（测试身份在收敛前可读这些值，应按已暴露处理）：`/root/.ssh/sa_agent2`
   与 `/root/.config/gh-agent` 里的 token。轮换会影响宿主 3082/agent 现有配置，必须在所有者参与下做。

3. **提供专用探测凭据**（仅授权探测仓库）：
   - SSH：新建专用 key（或专用机器账号的 key），只加入探测仓库（如
     `Bouyer12/m5a-beta-adf10ad9`）的 deploy key；安装到
     `/root/.config/m5bmatrix/probe_ssh_key`（root:root 0600）。
   - gh API：创建仅限探测仓库的 fine-grained token（Contents/Issues/Pull requests 读写；
     不要给 MoYu 或其它仓库），
     `GH_CONFIG_DIR=/root/.config/m5bmatrix/gh gh auth login --with-token`，
     然后 `chgrp m5bmatrix /root/.config/m5bmatrix/gh && chmod 0750 ... && chmod 0640 hosts.yml`。
   - 多仓库矩阵项（`M5B_MATRIX_EXTRA_REPOS`）需要凭据对每个探测仓库都可用；deploy key
     只能绑定单仓库时，应使用仅加入探测仓库的机器账号（或逐仓库配置克隆 URL，另开单处理）。

4. 安装并复验：

   ```bash
   bash scripts/m5b/matrix/prepare-nonroot.sh --apply
   node scripts/m5b/matrix/precheck.mjs --online   # 期望 verdict=clean，退出码 0
   ```

   `--online` 会以测试身份执行 `git ls-remote` 与 `gh api`：探测仓库必须可达，
   `bouyer-sutrasky/MoYu` 必须被拒绝。

5. 重建产物后复跑矩阵（`pnpm build`，记录 dispatcher sha256），先
   `scripts/m5b/matrix/stack.sh up`；`up` 在边界不干净时会直接失败。

## 5. 未验证项与限制

- 本单**没有执行** §4 的宿主配置收敛与凭据轮换：Issue 要求这两类动作单独列明具体动作，
  本单只做只读预检。因此现场 precheck 目前是 `violated`/`incomplete`，矩阵复跑保持阻断。
- `--online` 的仓库范围探测未运行（专用凭据不存在）；其判定逻辑由 guard 单测覆盖，
  但“真实探测仓库可达、MoYu 被拒”的现场证据要等专用凭据就位后补。
- 本单不重跑七项矩阵。`docs/evidence/m5b/matrix/` 里 PR #32 的结论只对旧 harness 有效；
  任何复跑必须使用本文的 harness，并重新记录命令与原始输出。
- 宿主 `3082`、生产库、生产迁移、真实设备 Passkey 未触碰（所有者保留项）。
