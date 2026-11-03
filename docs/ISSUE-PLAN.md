# 用户实际操作与分阶段 Issue

本文件是用户复制给 superagent 的操作步骤。本次没有自动向 GitHub 发消息。本项目取值：仓库 `bouyer-sutrasky/MoYu`、agent `Bouyer12`、HTTPS 域名待定（M2 前确定）；历史记录中的账号不是本次确认的当前授权。

## 第一步：建仓库并提交资料

1. 仓库已建：`bouyer-sutrasky/MoYu`（组织仓库，公开，Issues 已启用）。用户自行决定公开/私有。
2. 在仓库 Settings → Collaborators 或组织访问设置中，给予专用 agent 账号所需写权限，并确认邀请已接受；现有token/SSH凭据也必须能访问此新仓库。
3. 将 repo-kit 目录里的文件作为仓库根内容提交；不要把整个 E:/workplace 上传。该包含 AGENTS.md、README.md、docs 及脱敏取证，不含运行凭据和数据库。
4. 可在 GitHub 网页使用 Add file → Upload files，上传解压后的目录内容并提交。若用 Git，clone新仓库到单独目录，复制repo-kit内容，检查 `git diff --cached` 后再commit/push；不要把设计工作目录直接变为生产仓库。

## 第二步：让现有实例为新仓库准备入口

现场旧实例只监听 sutrasky/personal-ui-assets；提交前核实运行配置仍指向它。新仓库直接 @ 不足以接单。引导有两条并列入口：

- 现有策略允许 agent 读取新仓库及执行部署准备时，在旧监听仓库新建下面的引导 Issue。Issue表达用户授权范围，但不能扩展系统实际权限。
- 如果 agent 无法读取新仓库或不能管理宿主，管理员直接从新仓库下载本指南，按 BOOTSTRAP-RUNBOOK.md 的已核对CLI模板建立独立非root运行身份、DSH_HOME/profile、状态、工作目录、凭据及回环端口，通过固定版本支持的setup流程完成新仓库配置。无需等待旧agent读取失败或反复重试。首次profile初始化只在确认目标不存在时执行；已有profile通过设置修改，不能覆盖重建。

### 可复制：旧仓库引导 Issue

标题：为 `sutrasky/MoYu` 准备独立 superagent 开发实例

```text
@Bouyer12

我要让你开发新的 MoYu 网页。新仓库是 sutrasky/MoYu，开发资料已提交在其 docs/ 下。

本任务明确授权的目标是为这个新仓库准备独立开发实例；现有仓库和实例继续运行，不将现有 profile 改指向新仓库。

先读取新仓库 docs/DEVELOPMENT-GUIDE.md 第0阶段及 docs/research/server-environment.md，再核对当前真实环境。现有记录为 Ubuntu24、Node22.23.3、Harness0.2.1-rc.2、superagent0.1.0、Nginx已占80/443，部署目录没有.git；这些是快照，不可盲目套用。

按现有支持的setup流程建立新仓库专用bootstrap profile、独立state/worktree/回环端口，非root运行，单worker起步，设置准确的仓库、允许请求者及专用GitHub身份。必要管理员操作必须服从现有执行授权；缺权限时交付具体命令和原因，不绕过权限。凭据只在受限配置中处理，禁止在Issue、PR、日志输出。

先验证新账号对新仓库的读取、克隆与推送权限，再验证新实例确实只监听新仓库。不要全局升级或替换现有dsh，不覆盖旧profile，不启用会覆盖原配置的初始化命令。

目标是让我在新仓库 @ 你后可以接单。完成后回复：新实例名称与运行状态、正确的触发方式、已跑检查及结果、还需我做的明确事项。没有实际完成时不要宣称入口已可用。

平台开发、被测runtime升级与生产切换另开任务；此任务不要求一次开发整个网页。
```

如果原账号已接受邀请但新仓库没有接单，先查新profile Source仓库/允许名单/账号通知与运行状态，而不是反复发同一需求。旧实例不能因为你在Issue里提了仓库名就自动更改监听配置。

## 第三步：在新仓库发送第一单

标题：M0 固定兼容版本并建立开发基线

```text
@Bouyer12

请按仓库 AGENTS.md 和 docs/DEVELOPMENT-GUIDE.md 执行第0阶段的兼容性取证。目标是为本仓库的新网页建立可复现开发基线。

阅读 docs/DESIGN.md、docs/API-CONTRACTS.md 和 docs/research/。核对实际安装版本、源码制品、Source内部类型、Session事件、stop/retry语义、模型和两实例账号通知行为。原部署无.git，不能编造commit；选定可追溯版本在隔离profile复现。

提交 docs/environment-baseline.md、integrations/superagent/upstream.lock.json，以及后续开发所需的兼容性验证结果和精确差异。维护本项目补丁的目标是workspace Source、机器Bridge、可恢复暂停、任务模型和统一执行准入。

保持当前负责本任务的bootstrap实例不变。被测实例必须有独立状态/端口/测试仓库，使用资源仍计入同机预算；不得热替换你自己的runtime。

只完成本阶段，提交PR，附真实命令与证据，列出未验证项。开发阶段按后续Issue推进，不自行合并。
```

M0完成并审阅后，按顺序创建下面的Issue。每次替换阶段号与目标，通用触发文案见下一节。

| Issue | 对应指南阶段 | 本阶段必须看到的结果 |
| --- | --- | --- |
| M1 工程与存储 | 1 | monorepo、锁版本、CI、真实数据库迁移与幂等约束 |
| M2 Passkey 与页面外壳 | 2 | 真实注册登录、会话撤销、主题及手机布局截图 |
| M3 单仓库完整闭环 | 3 | Web发任务→真实worker→追问回答→PR，断网重投不重复 |
| M4 执行控制与GitHub汇总 | 4 | readonly硬约束、停止继续、追加消息、GitHub/Web去重 |
| M5 两实例调度与资源 | 5 | 同仓库串行、休眠/唤醒、第三仓库排队、8GB聚合上限证据 |
| M6 完整体验与部署交付 | 6 | 附件/diff/通知/清理、HTTPS端到端、重启恢复及回滚手册 |

## 第四步：后续每单通用文案

```text
@Bouyer12

执行 M<N>：<阶段目标>。前置阶段PR已经审阅合并，请基于当前默认分支工作。
遵守 AGENTS.md；按 docs/DEVELOPMENT-GUIDE.md 对应阶段开发，接口以 docs/API-CONTRACTS.md 为本项目契约，产品行为以 docs/DESIGN.md 为准。

实现该阶段全部验收项，提供可运行代码、必要迁移与真实集成测试证据。遇到版本差异先查固定源码再调整adapter，并记录原因；不得虚构上游接口或用mock演示冒充接通。

服务器范围仅限新平台隔离目录/profile/测试仓库及明确授权的新服务；保留旧实例和现有Nginx站点。管理员部署操作如不在现有权限内，提供可审阅步骤由我执行。

完成后创建PR并停止等待审阅；回复已完成项、测试命令/结果、未验证项、部署与回滚说明。不要自动合并，不提前开展下阶段。
```

## 第五步：验收、合并、继续

每个PR先看本阶段运行证据；必要时在原Issue/PR继续 @ 修改。确认后由用户在GitHub合并，再发下一阶段Issue。不要同时把所有阶段都 @ 一遍，以免旧worker并发配置导致抢跑。

M2前确定长期使用的HTTPS域名。M6上线前必须有域名/DNS控制权、证书与备份位置；这些不由agent凭空推断。若尚未确定，继续在独立测试域名或localhost验证，正式凭据只在最终RP ID下登记。

完成的判据是浏览器真实登录后向指定仓库提交任务并收到可审阅PR，不是页面看起来像ChatGPT，也不是一个health接口返回200。
