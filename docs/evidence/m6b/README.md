# M6-B 证据索引

被测代码提交：见本目录 `run.json` 的 `head`（本轮为 `c7945bf2167611a84d37e3cf165ecbfaa54ccd9f`）；基线：
`main@68c01e50d69a075183a0a175c57611fa77e1163a`（M6-A 合并提交）。每条原始输出第 2 行是产出时的
`git rev-parse HEAD` 原文。证据产出后只有一个仅含本目录文件的提交（PR head）；用
`git diff --name-status <evidence-head>..<pr-head>` 核对，输出应只列出 `docs/` 下的证据与验证记录文件。

环境：隔离 PostgreSQL 16（数据库 `moyu_m6b_evidence`）、真实 API `127.0.0.1:4625`（本单）
与基线 API `127.0.0.1:4626`（`main@68c01e5` 独立构建）、真实宿主 supervisor
`127.0.0.1:4696`、真实 Chromium（Playwright 1.56.1）；工作目录 `/tmp/m6b-run/worktrees`。
3082 与生产 API 4300 未重启，`/root/src/upstream/*` 未改动。

| 文件 | 内容 |
| --- | --- |
| `B1-red.txt` | 基线 `/api/v1/activity` 404、活动中心占位文案、设置页无通知权限区 |
| `B1-green.txt` | 两个同上下文真实标签页的 SSE 原始计数、通知去重键 `tag`、刷新重放不重复、点击定位会话、progress 不通知、denied/default 权限行为 |
| `B2-red.txt` | 基线 `/api/v1/history/search` 404 |
| `B2-green.txt` | 关键词分页无重复、跨所有者空结果、特殊字符、1500 字关键词、空关键词、跨查询游标 422 |
| `B3-red.txt` | 基线 `/api/v1/cleanup/runs` 与 `/preview` 404 |
| `B3-green.txt` | 真实 supervisor/worktree 的预览清单、四类跳过原因、仅干净已合并目录删除、重试幂等、审计记录；linked worktree 删除前后 `git worktree list --porcelain` 原始输出与 `worktreePruned` 结果 |
| `before-*.png` / `after-*.png` | 同一数据库、同一任务、桌面 1440×900 / 手机 390×844、浅色/深色的 Before/After |
| `after-history-desktop-light.png` | 历史搜索实际结果 |
| `after-cleanup-confirm-desktop-light.png` | 清理预览 + 二次确认面板 |
| `records.json` / `ui-records.json` | 截图元数据（base、theme、viewport）与证据运行信息 |

红侧语义：`*-red.txt` 中的 `exit code: 0` 表示"基线确实缺少/未通过该项"（预期的红），
`exit code: 1` 表示基线意外已具备该能力；绿侧 `exit code: 0` 表示验收通过。

复现：

```bash
TEST_DATABASE_ADMIN_URL=postgres://moyu@127.0.0.1:55432/postgres \
  node scripts/m6b/evidence.mjs
```

脚本会创建并删除隔离数据库、`/tmp/m6b-run` 与回环端口 4625/4626/4696，不触碰生产服务。

未验证项与限制见 [`../../M6-B-VERIFICATION.md`](../../M6-B-VERIFICATION.md) §8。
