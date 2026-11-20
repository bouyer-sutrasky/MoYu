# 隔离验收环境准备（2026-11-20，Issue #92）

本文件记录本轮在**宿主上实际执行**的环境准备、只读预检、专用探测凭据和两轮生命周期演练。
旧 PR #49 的只读预检与代码修复记录保留在 [HARNESS-ISOLATION.md](./HARNESS-ISOLATION.md)；
本文是它的现场续篇，不替代旧记录。

实测基线：`main@b6c2efab08e2703cc8e974dda7ff872db3122612`。
工作分支：`agent/isolated-env-credentials-2aefc61b10b2`（从上述基线直接建立）。

## 1. 修前现场（只读预检）

命令与退出码：

```bash
node scripts/m5b/matrix/precheck.mjs
# exit 1 — verdict=violated
```

关键行（脱敏；只输出 owner/mode/布尔值）：

```text
FAIL  /root/.dsh-m5                  owner=0 mode=0770 computed=writable observed=writable
FAIL  /root/.config/gh-agent         owner=0 mode=0770 computed=writable observed=writable
FAIL  /root/.config/gh-agent/hosts.yml  mode=0660 computed=readable observed=readable
FAIL  /root/.dsh-m5/.credentials.yaml   mode=0660 computed=readable observed=readable
FAIL  /root/.dsh-m5/instances.json      mode=0660 computed=readable observed=readable
INCOMPLETE ssh-key:/root/.config/m5bmatrix/probe_ssh_key — does not exist
INCOMPLETE gh-config:/root/.config/m5bmatrix/gh — does not exist
FAIL  /tmp/m5bmatrix                  owner=995 mode=0755
FAIL  legacy-secret:supervisor-token  owner=0 mode=0600 outside the protected directory
FAIL  legacy-secret:seed.env          owner=0 mode=0600 outside the protected directory
FAIL  bridge-credentials              61 stale credential file(s)
verdict=violated
```

旧运行根 `/tmp/m5bmatrix` 由低权身份拥有，却包含 root 写入的 `supervisor-token`、`seed.env`
和测试快照；这正是可被路径替换的写入目标。清点结果（只记录文件名/owner/mode）：

```text
## root-owned files inside a matrix-owned tree
root:root 600 /tmp/m5bmatrix/supervisor-token
root:root 600 /tmp/m5bmatrix/seed.env
root:root 600 /tmp/m5bmatrix/logs/initdb.log
root:root 600 /tmp/m5bmatrix/ticket-*.json 等
```

## 2. 本轮实际动作

### 2.1 清理旧运行根与遗留 slice

```bash
systemctl stop m5bmatrix.slice
rm -rf /etc/systemd/system.control/m5bmatrix.slice.d
systemctl daemon-reload
rm -rf /tmp/m5bmatrix          # 旧测试状态；路径已先 realpath 核对
```

结果：slice 与 cgroup 子树消失，旧 token/seed 与 61 个 Bridge 凭据文件不再存在。

### 2.2 收敛旧写授权（受信身份管理特权配置）

```bash
bash scripts/m5b/matrix/prepare-nonroot.sh --revoke
# exit 0
# /root/.dsh-m5          root:m5bmatrix 0770 -> root:root dirs=0700 files=0600
# /root/.config/gh-agent root:m5bmatrix 0770 -> root:root dirs=0700 files=0600
# /home/m5bmatrix/.ssh/sa_agent2（宿主 agent key 副本）已由低权身份自己删除
```

### 2.3 给探测仓配置独立凭据

新增 `scripts/m5b/matrix/provision-probe-credential.sh`：生成全新 ed25519 key，作为
**write deploy key 只加入探测仓**，私钥留在 root-only 目录。它拒绝宿主 key 的改名副本。

```bash
bash scripts/m5b/matrix/provision-probe-credential.sh --apply
# exit 0
# key=/root/.config/m5bmatrix/probe_ssh_key owner=root group=root mode=600
# fingerprint=SHA256:LLlQppfcsF4SvvABwZ/AUmEVaVTLKkhyKfsTt3vmfJQ
# authorized=Bouyer12/m5a-beta-adf10ad9 id=170529702 (deploy key)
```

之后安装读授权与身份侧 SSH 材料：

```bash
bash scripts/m5b/matrix/prepare-nonroot.sh --apply
# exit 1 — 仅因专用 gh 凭据缺失（fail closed）；读授权与 SSH 已安装
# ssh git@ssh.github.com:443 authenticated
#   (Hi Bouyer12/m5a-beta-adf10ad9! ...)
# host_write_boundary=clean
# dedicated_credentials=incomplete
```

专用探测 key 只授权探测仓：同一 key 对受控私有仓和 MoYu 的 `git push --dry-run` 均被
GitHub 拒绝（`exit=128`），对探测仓允许（`exit=0`）。两轮演练中重复验证，见 §4。

### 2.4 运行根分区

`guard.mjs` 的 `prepareDir` 在全新宿主上先由 root 创建目录、再 chown 给身份，但原实现只在
“目录已存在”分支 chown，导致首次 `stack.sh up` 在干净宿主上失败。本轮修复为：新建目录后
立即按目标 uid/gid 交接，再验证；新增一个 root-only 回归用例（guard 测试 19 → 20）。

```bash
node --test scripts/m5b/matrix/guard.test.mjs
# tests 20 / pass 20 / fail 0
```

## 3. 修后现场（只读预检）

```bash
node scripts/m5b/matrix/precheck.mjs
# exit 2 — verdict=incomplete（仅缺专用 gh token）
```

关键行：

```text
PASS  /root/.dsh-m5                  owner=0 mode=0700 not-writable
PASS  /root/.config/gh-agent         owner=0 mode=0700 not-writable
PASS  /root/.config/gh-agent/hosts.yml   mode=0600 not-readable
PASS  /root/.dsh-m5/.credentials.yaml    mode=0600 not-readable
PASS  ssh-key:/root/.config/m5bmatrix/probe_ssh_key  sha256=20cc90eab9cb5448 mode=600
INCOMPLETE gh-config:/root/.config/m5bmatrix/gh — does not exist
PASS  /tmp/m5bmatrix                 owner=0 mode=0755
PASS  protected                      owner=0 mode=0700
PASS  config                         owner=0 mode=0750
PASS  legacy-secret:supervisor-token absent
PASS  bridge-credentials             none
verdict=incomplete
```

`bash scripts/m5b/matrix/prepare-nonroot.sh --check` 同样给出
`host_write_boundary=clean`、`dedicated_credentials=incomplete`；`provision-probe-credential.sh --check`
给出 key 与 deploy key 的绑定关系。

## 4. 两轮生命周期演练

新增 `scripts/m5b/matrix/environment-rehearsal.sh`，在宿主上按真实入口跑两轮
**初始化 → 异常退出 → 清理 → 重启**，每轮核对：

- `/var/tmp/m5b-host-sentinel`（root:root 0600）的内容哈希、mode、uid、size、mtime 不变；
- 身份提前放置的符号链接在清理时只被 unlink，不跟随到宿主哨兵；
- `protected/` 只能由 root 写，`supervisor-token` 保持 0600；
- 身份拥有自己的 `tmp/credentials/dsh-home/instance-*` 目录；
- 探测仓 `git push --dry-run` 允许，受控私有仓拒绝。

```bash
bash scripts/m5b/matrix/environment-rehearsal.sh
# verdict=PASS rounds=2
```

关键行（两轮相同）：

```text
PASS: round N: protected secrets are root-only and the identity cannot write them
PASS: round N: the matrix process was killed; the next start must clean its state
PASS: round N: unlinking the replaced path left the host sentinel unchanged
PASS: round N: protected secrets removed and identity state emptied
PASS: round N: restart re-created the protected layout with root ownership
probe_allowed=Bouyer12/m5a-beta-adf10ad9 exit=0 (dry-run, no ref updated)
private_denied=Bouyer12/m5a-epsilon-adf10ad9 exit=128
scope_validated=probe-only
PASS: host sentinel content and metadata are unchanged after both rounds
```

未运行完整平台矩阵（`stack.sh up`）：`stack.sh` 的凭据门禁在专用 gh token 缺失时按设计
拒绝启动，这是下节的授权缺项，不是绕过项。

## 5. 授权缺项（逐条）

1. **专用 gh token（已由所有者于 2026-11-20 配置，见 §9）**。GitHub 不提供用现有 PAT
   程序化创建用户 fine-grained token 的 API；本轮先以部署 key 覆盖 git 传输。所有者随后
   配置了仅限探测仓的专用 token，正式 precheck 已 clean。
   需要：为 `Bouyer12/m5a-beta-adf10ad9` 创建仅限该仓、Contents/Issues/Pull requests 读写的
   fine-grained token，然后：
   ```bash
   GH_CONFIG_DIR=/root/.config/m5bmatrix/gh gh auth login --with-token   # 从 stdin 输入 token
   chown -R root:m5bmatrix /root/.config/m5bmatrix/gh
   chmod 0750 /root/.config/m5bmatrix/gh && chmod 0640 /root/.config/m5bmatrix/gh/hosts.yml
   node scripts/m5b/matrix/precheck.mjs --online   # 期望 verdict=clean, exit 0
   ```
   影响：`stack.sh up` 继续 fail closed；依赖真实 PR 打开的 #39 等现场项暂不可跑。

2. **轮换共享凭据**。收敛前 `/root/.config/gh-agent/hosts.yml` 与 `/root/.dsh-m5/.credentials.yaml`
   对 `m5bmatrix` 可读、目录可写；按已暴露处理。轮换会影响宿主 3082/agent 现有配置，属所有者动作。

3. **多探测仓凭据**。deploy key 只绑定单个仓库；若矩阵项使用 `M5B_MATRIX_EXTRA_REPOS`，
   每个额外探测仓需要各自的 key 与 SSH 选择方式。本轮只配置了默认探测仓。

## 6. 制品与哈希

```text
（见 docs/evidence/m5b/matrix/isolated-env/artifacts.txt）
```

## 7. 返修：无副作用的 gh 写权限探测（P2）

返修前 `precheck.mjs` 用固定假分支 `POST /pulls`：若该分支恰好存在且满足条件，预检可能真的
创建 PR；`42x`/`invalid` 的宽泛匹配也会把其他失败当成“写权限通过”。

现改为 `POST /repos/<repo>/git/refs`，ref 名包含 `..`（git 永远不接受），并附加 nonce：

- 仅当 **HTTP 422 且消息为 `is not a valid ref name`** 才记为 `allowed`；其他 422 记为
  `failed`，401/403/404 记为 `denied`，认证缺失记为 `missing`，超时/执行错误/其他失败分开记录；
- 状态码 0（意外创建）记为 `unexpected-success` 并判 FAIL，绝不当作授权通过；
- 探测前后分别读取 `refs/heads` 与 `pulls?state=all` 的 head ref，断言 nonce 未出现且数量不变
  （`gh-side-effects:<repo>`）；被拒绝的私有仓读取即被拒绝，不发起写请求，标为 SKIP；
- 单元测试 `scripts/m5b/matrix/gh-probe.test.mjs` 6 例，覆盖 allowed/denied/missing/timeout/
  exec-error/其他 422/意外成功/副作用断言。

用真实 API 演练了分类器和副作用断言（仅逻辑演练，使用受信身份的 root 配置，不是专用 token
作用域证据）：

```text
write { kind: 'allowed', http: 422 }
effects { ok: true, detail: 'refs=11 pulls=12' }
```

另外修正了 deploy key 被拒绝时的文本分类：`ERROR: Permission to <repo>.git denied to deploy key`
此前落入 `failed`，现在归为 `denied`，因此 MoYu 的负向 git 探测显示 PASS 而不是 INCOMPLETE。

`--online` 现场输出见 `isolated-env/precheck-online-p2.txt`：探测仓 git 允许 PASS、MoYu 拒绝
PASS、gh 两项 INCOMPLETE。专用 gh token 仍未配置，因此 `precheck --online` 的专用 token
现场证据继续标为**待验**，未用共享凭据回退。

## 8. 返修：Issues / Pull requests 写权限分别核验（P2）

非法 ref 只覆盖 Git refs 写入端点。矩阵还使用 Issue 与 PR 操作，因此把写权限核验拆成三个
互不相同的端点，全部保持无副作用：

| 端点 | 非法请求 | 授权时的精确响应 | 副作用断言 |
| --- | --- | --- | --- |
| `POST /git/refs` | ref 含 `..` | 422 `is not a valid ref name` | refs/heads 与 pulls 前后不变 |
| `POST /issues` | 缺 `title` | 422 `"title" wasn't supplied.` | issue 数前后不变 |
| `POST /pulls` | 缺 `head`/`base` | 422 `"base", "head" weren't supplied.` | PR 数前后不变 |

分类规则：只有上表端点的精确 422 消息才记为 `allowed`；其他 422 一律 `failed`，401/403/404
为 `denied`，认证缺失/超时/执行错误分开记录，状态码 0 记为 `unexpected-success` 并 FAIL。
每个端点探测前后读取对应集合，断言数量不变（`gh-<endpoint>-side-effects:<repo>`）；被拒绝的
私有仓读取即被拒绝，不发起写请求。

真实 API 逻辑演练（受信身份 root 配置，仅逻辑，不是专用 token 证据）：

```text
refs_write={"kind":"allowed","http":422}   refs_effects={"ok":true,"detail":"refs=11 pull requests=12"}
issues_write={"kind":"allowed","http":422}  issues_effects={"ok":true,"detail":"issues=2"}
pulls_write={"kind":"allowed","http":422}   pulls_effects={"ok":true,"detail":"pull requests=12"}
```

`--online` 现场输出见 `isolated-env/precheck-online-p3.txt`：探测仓 git PASS、MoYu denied
PASS、gh refs/issues/pulls 三项 INCOMPLETE。专用 gh token 仍未配置，因此“允许探测仓 /
拒绝受控私有仓”的专用 token 现场证据继续**待验**；未用共享凭据替代，也未把逻辑演练当成
作用域证据。

## 9. 返修：可配置受控私有对照仓与正式入口复跑（P2）

**问题**：正式在线预检把对照仓写死为公开的 `bouyer-sutrasky/MoYu`。专用凭据可读公开仓，
于是预检在 MoYu 上回读 PR 列表并超时（`pulls=timeout` / `read-pulls-before`），
`verdict=incomplete`，`stack.sh up` 的 gate 无法放行。复现输出在
`isolated-env/precheck-online-p4-before.txt`。

**修复**：

- 新增可配置对照仓 `M5B_MATRIX_CONTROL_REPOSITORY`（默认
  `Bouyer12/m5a-epsilon-adf10ad9`，受控私有仓）；`precheck` 同时接受
  `--control-repository`。`stack.sh` 的 scope gate 显式把同一值传给预检。
- 解析顺序 flag → env → 默认值；校验非空、`owner/name` 形状，且不得等于任一探测仓。
  缺失/非法/与探测仓相同会立即 `FAIL` 并退出 1（fail closed），不会跳过负向探测。
- 回归：`resolveControlRepository` 单测覆盖 flag/env/默认、空值、非法形状、与探测仓相同。

**正式入口复跑**（最终代码，专用凭据已由所有者配置）：

```bash
node scripts/m5b/matrix/precheck.mjs --online
# verdict=clean, exit 0

bash scripts/m5b/matrix/stack.sh up
# gate 通过；slice/PG/provider/supervisor/API/dispatcher 全部 active
# bridge healthz {"ok":true}，API /healthz 200
# 见 isolated-env/stack-up-p4.txt

bash scripts/m5b/matrix/stack.sh down
# exit 0；端口释放、protected 秘密删除；slice 另行停止
```

专用凭据现场结果（脱敏，`isolated-env/precheck-online-p4-clean.txt`）：

```text
git-push-dry-run:Bouyer12/m5a-beta-adf10ad9                 allowed
gh-refs-write / gh-issues-write / gh-pulls-write            allowed (422)
gh-refs/issues/pulls-side-effects                           refs=11 issues=2 pull requests=12
git-push-dry-run:Bouyer12/m5a-epsilon-adf10ad9 (denied)     Repository not found
gh-refs/issues/pulls-write:...epsilon... (denied)           HTTP 404
verdict=clean
```

**fail closed 复跑**：把对照仓设成探测仓本身：

```bash
M5B_MATRIX_CONTROL_REPOSITORY=Bouyer12/m5a-beta-adf10ad9 bash scripts/m5b/matrix/stack.sh up
# FAIL: the probe credential scope gate did not pass; exit 1; 0 个单元启动
```

见 `isolated-env/stack-up-failclosed.txt`。最终代码再次从正式入口复跑的结果在
`isolated-env/stack-up-final.txt`（UP_EXIT=0、bridge `{"ok":true}`、DOWN_EXIT=0）。

**正式入口另外发现并修复的两个现场阻塞**：

1. 矩阵 supervisor 默认端口 4491 现在是生产 M6-C supervisor 的监听端口；改为默认 4591
   （仍可由 `M5B_MATRIX_SUP_PORT` 覆盖）。
2. supervisor 为每个 runtime home 准备 GitHub CLI 配置时需要 `GITHUB_CONFIG_DIR`；
   `stack.sh` 原来只传了 `M5B_MATRIX_GH_CONFIG_DIR`，导致 prepare 报
   “The GitHub CLI configuration is missing at /tmp/m5bmatrix/.config/gh-agent”。
   现在 supervisor 单元同时收到 `GITHUB_CONFIG_DIR=<专用 gh 配置>`。

**授权状态更新**：第 5 节第 1 项（专用 gh token）已由所有者配置，正式 precheck 已 clean；
共享凭据轮换与多探测仓 key 仍是所有者动作。

## 10. 返修：显式空对照仓必须被启动入口拒绝（P2）

**问题**：`precheck` 直接运行时会拒绝显式为空的 `M5B_MATRIX_CONTROL_REPOSITORY`，但
`lib.sh` 用 `${M5B_MATRIX_CONTROL_REPOSITORY:-默认值}`，显式空值被替换成默认对照仓，
`stack.sh up` 因此继续启动而不是拒绝。

**修复**：

- `lib.sh` 改为 `${M5B_MATRIX_CONTROL_REPOSITORY-默认值}`：仅变量**未设置**时采用默认仓
  `Bouyer12/m5a-epsilon-adf10ad9`，显式空值原样传给 gate。
- `precheck` 的选项解析保留显式空 flag（`--control-repository ""`），不再把它当作“未提供”
  而回退默认值。
- 回归 `scripts/m5b/matrix/control-repository.test.mjs`：未设置 → 默认；显式空 → 空；
  自定义 → 自定义。

**正式入口复跑**：

```bash
M5B_MATRIX_CONTROL_REPOSITORY= bash scripts/m5b/matrix/stack.sh up
# exit 1; scope/control-repository: a controlled private control repository is required
# 0 个单元启动
# 见 isolated-env/stack-up-empty-control.txt

env -u M5B_MATRIX_CONTROL_REPOSITORY bash scripts/m5b/matrix/stack.sh up
# 使用默认 Bouyer12/m5a-epsilon-adf10ad9；gate clean；完整启动
# bridge {"ok":true}；随后 down exit 0
# 见 isolated-env/stack-up-unset-control.txt
```

`node scripts/m5b/matrix/precheck.mjs --gate --online --control-repository ''` 同样 exit 1
（required）。未设置变量时的默认仓仍是受控私有仓，不影响 fail-closed。
