# 开发环境核查

核查日期为 2026-11-03，使用 `E:\workplace` 下的 Windows PowerShell 会话。项目技术基线见 [实现方案](../IMPLEMENTATION.md)。

## 本机已验证

| 命令 | 结果 |
| --- | --- |
| `node --version` | `v25.2.1` |
| `pnpm --version` | `12.15.0` |
| `npm --version` | `11.6.2` |
| `git --version` | `2.45.2.windows.1` |
| `Get-Command docker,corepack,psql,sqlite3 -ErrorAction SilentlyContinue` | 当前 PATH 未命中 |
| `wsl --list --quiet` | 列出 `kitty` |
| `git -C superagent-workspace-design rev-parse --show-toplevel` | 返回当前目录不在 Git 仓库内 |

核查时设计目录已有设计、术语、实现方案与 ADR，尚无平台 `package.json` 可执行。

## Node 基线

Node.js 官方发布表将 v24 Krypton 标为 LTS，将本机 v25 标为 EOL。建议以 Node 24 LTS 作为平台与上游复现实验的共同基线，在项目建仓时锁定具体补丁版本和包管理器版本。 [Node.js 官方发布表](https://nodejs.org/en/about/previous-releases)

使用 `Get-Content dsh-superagent-research/upstream/package.json -Raw | ConvertFrom-Json` 核对本地上游参考。其声明 Node `^22.19.0 || >=24.0.0`、`pnpm@11.7.0` 和 DSH `^0.2.1-alpha.2`，`pnpm check` 依次运行 TypeScript 类型检查、Vitest 和 tsdown 构建。上游复现实验应遵守该参考版本的声明。平台应根据自己的锁文件固定 pnpm。

## 待验证

- Windows PATH 的查询只覆盖当前会话。WSL 内的容器引擎和 PostgreSQL 服务尚未检查。运行 Compose 前执行 `docker compose version` 和 `docker info`。
- PostgreSQL 连接、迁移、Playwright 用户流程和真实服务器验收均待平台代码及相应环境就绪后执行。平台验证可按不需要数据库的检查、需要开发 PostgreSQL 的集成测试、真实服务器验收分层。
- 本次核查没有安装依赖、启动服务或访问部署服务器。
