# M6-A 证据索引

基线 `main@d02f07f1483e0c85a13c1dfe24d03d855a72d0a1`；被测代码见 PR head。
环境：隔离 API `127.0.0.1:4620`（after）/`127.0.0.1:4621`（before，`main@d02f07f` 构建）、
隔离 PostgreSQL 16 `127.0.0.1:55432`（DB `moyu_m6a`）、宿主 supervisor `127.0.0.1:4690`、
任务 worktree `/tmp/m6a/worktrees/probe1`。生产 4300/3082 与 `/root/src/upstream/*` 未改动。

| 文件 | 内容 |
| --- | --- |
| `A1-upload.txt` | 真实 multipart 上传、逐字节下载对照、HTML 不内联、库表行 |
| `A2-rejections.txt` | 超限/非法类型/未登录/跨所有者上传与读取/空文件的原始响应与行数 |
| `A3-attachment-delivery.txt` | 带附件消息、附件绑定、dispatcher 实际发出的 Bridge Trigger（无 attachments）与未传说明 |
| `A4-diff.txt` | 真实 git 命令输出、采集 JSON、patch 逐字节对照、无改动与已清理 |
| `A5-checks.txt` | 三次真实 `pnpm check`（通过 → 故意失败 → 通过）的命令、exit code、时间、输出 |
| `A6-delivery.txt` | 完整 commit SHA、PR #44 open、PR #45 closed 未合并、GitHub 不可用时的原因 |
| `A7-restart.txt` | 重启 API 前后同一任务投影 digest、库表行、附件下载对照、已清理状态 |
| `A8-regression.txt` | 最终 head 的 `pnpm check` 与真实 PostgreSQL 集成测试条数（含 before 对照） |
| `before-*.png` / `after-*.png` | 同一 DB、同一任务、桌面 1440×900 与手机 390×844、浅/深主题 |
| `after-desktop-light-checks-failed.png` | 检查失败状态（同一任务，故意改坏类型时） |
| `after-desktop-light-cleaned.png` | worktree 已清理的任务 |
| `ui-checks.json` / `panel-text.json` / `records.json` | DOM 断言、详情面板文本、截图元数据 |

脚本：`scripts/m6a/seed-fixture.mjs`（隔离 fixture）、`scripts/m6a/screenshots.mjs`（before/after
截图与断言）、`scripts/m6a/stub-bridge.mjs`（只记录 dispatcher 请求的录制用 stub，不是 runtime）。

未验证项见 [`../../M6-A-VERIFICATION.md`](../../M6-A-VERIFICATION.md) §5。
