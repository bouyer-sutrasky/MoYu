# MoYu 开发约定

## 命名

- 项目名：**MoYu**。Issue、PR、提交信息、文档标题一律写 `MoYu`；不要再写「Superagent Workspace」作为项目名。
- GitHub 仓库：`bouyer-sutrasky/MoYu`（组织 `bouyer-sutrasky`，公开）。agent 账号：`Bouyer12`（仓库 Admin）。
- 2026-11-03 该仓库由 `sutrasky/MoYu` 转移到组织，旧名指同一仓库；`docs/environment-baseline.md`、`docs/M1-VERIFICATION.md` 等历史证据里的旧名保持原样，不要改写。
- `main` 受分支保护：必须走 PR，且 `check (lint, format, types, unit tests, build)` 与 `integration (real PostgreSQL)` 两个检查必须通过；禁直推、禁 force push、禁删除。
- 代码内部标识（如插件 id `dsh-superagent-workspace`、包名 `dsh-superagent/*`）沿用上游命名，不随项目名改动。

开始任何开发任务，先读 docs/DEVELOPMENT-GUIDE.md 对应阶段、docs/DESIGN.md 的已确认行为，以及 docs/API-CONTRACTS.md 的相关接口。部署与兼容性工作还须读取 docs/research/，复核现场事实后写 docs/environment-baseline.md。

任务以 Issue 指定阶段为范围，完成其验收后提交 PR，由所有者审阅合并。沿用已确认产品决策；实现差异记录在 PR，不能用上游缺失能力静默缩减验收。

上游接口以固定版本源码为依据，新平台协议独立维护。机器适配、生命周期和执行准入补丁在 integrations/superagent 管理，应用前后均运行契约测试。

负责本项目开发的 bootstrap 实例保持稳定；被测 runtime 使用独立 profile、状态与测试仓库。现有服务、其他仓库和宿主全局运行时不属于默认修改范围。

凭据使用受限配置与秘密存储；Issue、PR、日志和仓库中不写 token、私钥、Cookie 或真实绑定码。管理员操作遵守现有授权，缺权限时提供具体步骤给操作者。

交付附实际检查命令与结果、未验证项及迁移回滚方法。mock仅用于测试，不作为真实接单、执行与PR闭环完成的证据。
