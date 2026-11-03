# MoYu

**MoYu** —— 个人智能体工作台（内部概念名 Superagent Workspace）：ChatGPT式布局，DeepSeek Harness视觉变量；Work接入superagent，Chat预留接口。

此提交是开发交接资料，不含已完成应用。

- [用户如何发任务](docs/ISSUE-PLAN.md)：新仓库权限、独立实例引导、可复制Issue。
- [开发指南](docs/DEVELOPMENT-GUIDE.md)：环境依据、仓库结构、阶段与验收。
- [接口契约](docs/API-CONTRACTS.md)：浏览器API、事件流、Bridge及上游差异。
- [管理员引导步骤](docs/BOOTSTRAP-RUNBOOK.md)：现有agent不能跨仓库或管理服务时的并列入口。
- [产品决策](docs/DESIGN.md)：已经确认的范围和行为。
- [环境与接口调研](docs/research/)：现场快照与未验证项。

先完成M0兼容性取证，再按M1–M6顺序实现。需要部署时复核现有Nginx与运行实例，使用隔离环境；正式Passkey绑定需要明确的HTTPS域名。
