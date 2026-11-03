# 两实例 GitHub 通知探针（M0）

用途：在不触碰 bootstrap 实例和用户仓库的前提下，用真实 GitHub 通知验证两个不同仓库的 superagent 实例是否互不吞事件。M0 实际使用了两个临时私有仓库；本文件保存可复现的最小步骤。

## 前置

- 专用账号 `Bouyer12` 对测试仓库有 push 权限；`/root/.local/bin/gh-agent` 已登录。
- 两个独立 profile/state/端口，例如 `/root/.dsh-m0` 下的 `m0a:3182`、`m0b:3183`；bundle 来自固定 commit（见 `../upstream.lock.json`）。
- 测试仓库和 Issue 均不含生产数据。

## 1. 测试仓库工作流

在**每个**测试仓库的默认分支放置 `.github/workflows/m0-notification-probe.yml`：

```yaml
name: m0-notification-probe
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      issue:
        description: Issue number to comment on
        required: true
permissions:
  issues: write
jobs:
  comment:
    runs-on: ubuntu-latest
    steps:
      - name: Comment mention
        uses: actions/github-script@v7
        env:
          ISSUE: ${{ inputs.issue || '1' }}
        with:
          script: |
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: Number(process.env.ISSUE),
              body: '@Bouyer12 M0 notification probe from github-actions[bot].'
            })
```

注意：当前 `gh` token 只有 `repo`/`read:org`，不能通过 Contents API 创建 workflow（会 404）。已验证可用 SSH `git push` 提交该文件；`gh` token 的 `workflow` scope 不是本探针的前置条件。

## 2. 实例配置

用支持的 profile 模板创建实例，链接固定 commit 的构建，并只修改：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3182
- id: dsh-superagent
  config:
    stateDir: /root/.dsh-m0/state/m0a
```

启动后通过本机管理 API 保存 Source 与 Policy（`<port>`、`<repo>` 替换）：

```bash
curl -sS -X PUT -H 'content-type: application/json' \
  -H 'x-orchestrator-request: 1' -H 'Origin: http://127.0.0.1:<port>' \
  --data '{"value":{"enabled":true,"config":{"repository":"<repo>","cli":"/root/.local/bin/gh-agent","pollSeconds":60,"failuresBeforeError":3,"observeIssues":false,"observePulls":false,"observeComments":false,"observeCi":false}},"revision":0}' \
  http://127.0.0.1:<port>/orchestrator/api/settings/source:github

curl -sS -X PUT -H 'content-type: application/json' \
  -H 'x-orchestrator-request: 1' -H 'Origin: http://127.0.0.1:<port>' \
  --data '{"value":{"rules":[],"sources":{"github":{"allowed":[],"admission":{}}}},"revision":0}' \
  http://127.0.0.1:<port>/orchestrator/api/settings/policy
```

保存 `source:github` 会触发 setup 检查与插件重启；等待 `GET /orchestrator/api/state` 的 `setup.problem` 为 null、`health.github.state` 为 `ready`。测试实例必须使用独立 `DSH_HOME`、state 和端口；不要复用 3082 的 bootstrap。

## 3. 触发与观察

- 两个仓库各有一个 Issue #1；向默认分支 push 任意探针文件会运行工作流，由 `github-actions[bot]` 评论 `@Bouyer12`。
- 每次实例轮询后读取自己的 state SQLite（只读）或 `GET /orchestrator/api/state`：

```bash
curl -sS -H 'x-orchestrator-request: 1' http://127.0.0.1:<port>/orchestrator/api/state
python3 - <<'PY'
import sqlite3, json
con = sqlite3.connect('file:/root/.dsh-m0/state/m0a/orchestrator.sqlite?mode=ro', uri=True)
print([json.loads(r[0])['url'] for r in con.execute('select value from trigger')])
print(con.execute("select value from kv where key='github-since'").fetchone())
PY
```

M0 的观察结果：

| 测试 | 预期 |
| --- | --- |
| 两个实例分别监听不同仓库 | 各自 `trigger` 只包含自己仓库的 URL |
| 共享账号未读状态 | 实例轮询后 `gh api notifications` 仍未读；没有标记已读 |
| 新实例不补历史 | 首次轮询前存在的评论不落 Trigger |
| 停机后补收 | 重启后从持久化 `github-since` 补收停机期间的通知，且 ID 稳定不重复 |
| 同仓库双实例 | **不要做**；必须由宿主 repository lease 阻止 |

## 4. 收尾

```bash
tmux kill-session -t m0a 2>/dev/null || true
tmux kill-session -t m0b 2>/dev/null || true
ss -ltn | grep -E ':(3182|3183)\b' || true
```

测试仓库可在审阅后删除；删除是破坏性操作，建议由所有者执行。
