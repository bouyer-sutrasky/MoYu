# 管理员：为新仓库准备独立开发实例

仅用于旧agent没有跨仓库/宿主管理权限时的并列入口。命令模板已按现场CLI帮助及上游部署文档核对，但本次没有执行创建、安装、启动或配置修改。操作者需先替换路径、仓库及端口，并确认账号授权。

## 前置条件

- 用户已建新GitHub仓库，提交repo-kit，专用GitHub账号已接受所需写权限。
- 管理员建立专用非root运行用户及其目录；当前SSH身份和sudo权限由管理员确认。不要复制整个/root配置或把/root目录放宽给新用户。
- 在该用户可访问的位置放置固定版本Harness和已构建superagent bundle。现场版本与部署文档有差异，先复现现有版本或验证新的固定组合。禁止全局升级现有dsh。
- 给新身份配置受限GitHub凭据、SSH已验证host key及必要模型访问。私钥、token和provider配置通过秘密管理路径处理，不贴到GitHub。
- 下列操作在新专用用户shell进行。`dsh_bin`必须指向明确版本CLI；`bundle_dir`必须已经安装依赖并构建，且版本证据保存在M0报告。

## 创建新profile

```bash
set -euo pipefail
bootstrap_home="$HOME/.dsh-workspace-bootstrap"
bootstrap_profile="workspace-bootstrap"
dsh_bin="/absolute/path/to/pinned/dsh"
bundle_dir="/absolute/path/to/pinned-built-dsh-superagent"
bootstrap_port=3083

test -x "$dsh_bin"
test -d "$bundle_dir"
test -x "$bundle_dir/scripts/dsh-superagent"

if test -e "$bootstrap_home/profiles/$bootstrap_profile" || test -L "$bootstrap_home/profiles/$bootstrap_profile"; then
  echo '目标profile已经存在：停止初始化，改用现有配置检查流程。' >&2
  exit 1
fi

env DSH_HOME="$bootstrap_home" "$dsh_bin" --version
ss -ltn
# 人工确认 bootstrap_port 未占用后，再执行下面两行。
env DSH_HOME="$bootstrap_home" "$dsh_bin" --profile "$bootstrap_profile" --from-default-profile web --dump-config >/dev/null
env DSH_HOME="$bootstrap_home" "$dsh_bin" plugin --profile "$bootstrap_profile" add "link:$bundle_dir"
```

`--from-default-profile`会覆盖profile配置，因此只用于以上明确不存在的目标。不是 `dsh profile init`。构建命令按固定bundle package.json执行；已核验上游check包含类型检查、测试及构建。

## 配置与启动

编辑新profile内 `cordis.patch.yml`，参照固定bundle的 `examples/profile.cordis.patch.yml`，在对应插件条目设置：

- `id: webserver` 的config：`host: 127.0.0.1`、新端口。
- `id: dsh-superagent` 的config：新独立绝对 `stateDir`。
- 加载所需模型provider与预设；配置秘密不进入Git。

以上是应设置的字段，不是完整YAML，不能拿三行替换整份profile。

启动脚本内部需要找到固定版本 `dsh`。先核对脚本与PATH；可令固定CLI所在bin目录排在PATH首位，并用 `command -v dsh` 验证。

```bash
export PATH="$(dirname "$dsh_bin"):$PATH"
command -v dsh
env DSH_HOME="$bootstrap_home" "$bundle_dir/scripts/dsh-superagent" \
  --profile "$bootstrap_profile" --url "http://127.0.0.1:$bootstrap_port" start
env DSH_HOME="$bootstrap_home" "$bundle_dir/scripts/dsh-superagent" \
  --profile "$bootstrap_profile" --url "http://127.0.0.1:$bootstrap_port" status
```

`--url`是健康探针地址，不改变监听端口。监听地址必须在profile内配置。启动脚本仍是上游现有运维方式，不代表最终平台必须用tmux；新平台调度另按开发指南实现。

管理面板通过SSH转发访问，不公开Harness端口。可另开本地终端，以现有SSH别名 `jd-mc` 为例：

```text
ssh -N -L 13083:127.0.0.1:3083 jd-mc
```

本地13083也需未占用。按该版本实际启动输出完成Harness原生访问认证；不要把启动token写入Issue。Workspace自己的Passkey是后续开发内容，不是这个管理面板已有功能。

在管理面板完成：Sources设新GitHub仓库及专用账号CLI；Policy设允许请求者；Execution设独立工作根目录、prepare/worktree命令和maxWorkers=1；Prompts设交付PR、不自动合并。CLI包装器应在非root用户可执行，授权只覆盖必要仓库。

Overview/setup通过并验证账号身份及权限后，再在新仓库发M0 Issue。最后根据管理员选定的服务方式配置持久运行，验证重启后使用同一用户、PATH、DSH_HOME及profile；不要套用原root服务单元直接改路径。

## 验收

1. 旧实例3082及旧仓库保持原状。
2. 新实例实际以非root身份运行，监听新回环端口，拥有独立状态/工作目录。
3. 新仓库收到允许的人@后接单；未允许的人不能发起工作；agent自身回复不触发循环。
4. 新worker的checkout属于新仓库，测试PR确实提交到新仓库。
5. 用于开发的bootstrap不会被待测补丁替换；测试另用独立profile与预算内资源。

若缺权限/模型/CLI兼容性，记录具体失败与待处理动作。停止在不满足的前置步骤，不跳过到“已可使用”。
