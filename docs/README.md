# MoYu 文档索引

## 现行指引

| 用途 | 文档 |
| --- | --- |
| 运行环境、域名、服务与分支保护 | [部署与验收事实](./DEPLOYMENT.md) |
| 发布、备份、恢复、回滚 | [M6-C 运行手册](./M6-C-RUNBOOK.md) |
| 产品范围、术语与接口 | [产品决策](./DESIGN.md)、[术语表](./GLOSSARY.md)、[接口契约](./API-CONTRACTS.md) |
| 仓库约定与设置字段 | [仓库约定](../AGENTS.md)、[设置映射](./M6-C-SETTINGS-MAPPING.md)、[历史开发指南](./DEVELOPMENT-GUIDE.md) |
| 当前交付边界与未完成动作 | [M6-C 最终状态](./M6-C-FINAL-STATUS-2026-11-16.md) |
| 当前真人验收修复 | [MoYu Issue #79](https://github.com/bouyer-sutrasky/MoYu/issues/79) |

## 历史设计与验收记录

- 首次搭建：[分阶段派单模板](./ISSUE-PLAN.md)、[独立实例引导](./BOOTSTRAP-RUNBOOK.md)、[概念实现方案](./IMPLEMENTATION.md)。
- M1–M3：[数据库](./M1-VERIFICATION.md)、[认证](./M2-VERIFICATION.md)、[投递](./M3-VERIFICATION.md)、[SSE 边界](./M3-SSE-BOUNDARY-VERIFICATION.md)。
- M4–M5：[执行控制](./M4-VERIFICATION.md)、[工作台体验](./M4-UX-VERIFICATION.md)、[多仓库实例](./M5-A-VERIFICATION.md)、[资源与租约](./M5-B-VERIFICATION.md)、[重启对账](./M5-B-RESTART-RECONCILE.md)。
- M6：[附件与审阅](./M6-A-VERIFICATION.md)、[通知与历史清理](./M6-B-VERIFICATION.md)、[M6-C 验收表](./M6-C-ACCEPTANCE.md)、
  [M6-C 验证记录](./M6-C-VERIFICATION.md)、[2026-11-16 发布与验收快照](./M6-C-FINAL-STATUS-2026-11-16.md)。
- [按阶段存放的原始证据](./evidence/)和[环境调研](./research/)用于追溯当时的版本、命令和结论。
