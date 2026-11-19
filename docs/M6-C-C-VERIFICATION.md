# M6-C C 段验证：页面位置、主题与中文交互

基线：`2e785306f59767f07b91198f275591c050f9f34f`（#82 合并后的 `main`）。
本文件记录 C 段的实现、命令和实际结果；浏览器证据在
[`docs/evidence/m6c-c/`](./evidence/m6c-c/README.md)。

## 1. 刷新与返回恢复

### 实现

`apps/web/src/shell/workspaceRoute.ts` 把可寻址状态放进查询串：

```
?repo=<uuid>&conversation=<uuid>&settings=<section>&settingsRepo=<uuid>&group=<group>
```

- 只接受 UUID 形状的 id、已知设置分区和已知 Superagent 分组；其余值在解析时
  丢弃，不会成为目标。
- `WorkspaceShell` 在仓库列表就绪后解析目标：仓库必须在当前 owner 的列表里；
  会话先调用 `GET /api/v1/conversations/:id` 校验存在性和归属，再切换。校验失败
  才回退到当前/第一个仓库，并用 `replaceState` 规范化地址，显示可见提示。
- 仓库、会话、设置分区、设置分组和设置目标仓库的每次用户导航都写入历史；
  `popstate` 从地址恢复，因此浏览器返回/前进与刷新一致。
- 设置目标仓库独立于工作台仓库：`settingsRepo` 只影响设置弹窗，切换它不会切换
  左侧仓库与会话。
- 旧 URL 没有这些参数时行为不变（回退到第一个仓库）；合并别名解析后地址会
  用 `replaceState` 改成目标 id，草稿在切换前迁移。
- 恢复会话后 `Composer` 仍按 `owner + repository + conversation` 读取草稿，
  因此刷新恢复位置时也恢复该会话的草稿，不同会话互不可见。

### 浏览器结果（真实 API + 测试库，桌面 1440×900）

| 场景 | Before（`2e78530`） | After |
| --- | --- | --- |
| 打开 beta 会话 URL | 回退到 alpha，Beta 不可见 | 面包屑 `beta-fixture / Beta 会话`，URL 保持 beta 会话 |
| 刷新 beta 会话 | — | 仍为 beta 会话 |
| beta 设置→评估 URL | 设置弹窗不打开 | 弹窗打开，目标仓库 beta，分组「评估」`aria-current=page` |
| 刷新设置 | — | 同一分区、仓库、分组 |
| 浏览器返回（B1 → B → A1） | — | 地址和界面逐步回到对应位置 |
| 非法/无权限会话 | — | 清掉会话参数，回到当前仓库，显示「不存在或没有访问权限」 |
| 草稿恢复 | — | beta/alpha 两会话各自恢复自己的草稿，互不串 |
| 设置切仓 | — | `settingsRepo` 改为 A、分组回「来源」，工作台仍是原仓库 |

记录：`browser/after-result.json`、`browser/before-result.json`；截图
`browser/after-restore-beta-conversation.png`、
`browser/before-restore-beta-conversation.png`、`browser/after-restore-beta-settings-eval.png`。

## 2. 深色模式新任务面板

### 根因

`WorkspaceShell.module.css` 里有两个 `.newTaskForm`：新任务面板使用一个；「基于
此任务新建」对话框复用同名类，并带一条 `.newTaskForm select` /
`.newTaskForm input` 规则，把背景写成 `var(--dsw-alias-bg-primary, #fff)`。
主题里没有 `--dsw-alias-bg-primary` 时回退到白色，后出现的规则覆盖面板自己的
`.selectInput`，于是深色下三个选择器（起点分支、模型、推理强度）出现白底、
浅色正文不可读。

### 修复

- 对话框表单改名为 `.newTaskFromTaskForm`，只作用于该对话框。
- 新任务面板继续使用 `.newTaskForm` + `.textInput` / `.selectInput` 的既有
  主题 token：`--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary`、
  `--dsw-alias-border-l3`、focus 用 `--dsw-alias-state-business-primary`。
- 对话框表单也改用相同 token，焦点有可见边框，不再有 `#fff` 回退。

### 计算样式（Chromium，深色）

| 控件 | Before 背景 | After 背景 | After 正文 | After 焦点边框 |
| --- | --- | --- | --- | --- |
| 起点分支 | `rgb(255,255,255)` | `rgb(35,35,36)` | `rgb(249,250,251)` | — |
| 模型 | `rgb(255,255,255)` | `rgb(35,35,36)` | `rgb(249,250,251)` | `rgb(122,170,255)` |
| 推理强度 | `rgb(255,255,255)` | `rgb(35,35,36)` | `rgb(249,250,251)` | — |

移动端 390×844 深色下，`ResponsiveSelect` 的触发器和选择对话框使用既有主题
token；截图见 `browser/after-new-task-dark-mobile.png` 与
`browser/after-new-task-dark-mobile-selector.png`。加载、空、失败三种状态在深色
下都保持同背景/正文；取消后没有 `POST /api/v1/conversations`。

## 3. 中文交互

### 实际生成路径

- 面板的 Prompts preview 走
  `apps/api/src/routes/superagent-settings.ts` → `apps/api/src/runtime/supervisor.ts`
  → supervisor `/panel-action/prompts/preview` → 锁定版 Superagent 的
  `Prompts.preview()`，再由 `composePrompt()` 合成两种角色的提示词。
- 执行器拿到的是同一份合成结果（worker prompt）加上宿主提示词与仓库
  `AGENTS.md`。

### 改动

新增固定内置段 `runtime/language`（`integrations/superagent/patches/0030-language-section.patch`）：

> Human-facing prose follows the language of the source conversation: Chinese when
> the person wrote Chinese, otherwise the language they used. This covers the
> acceptance acknowledgement, questions for a human decision, progress and failure
> reports, and the final completion message. Keep code identifiers, file names,
> paths, commands and necessary technical terms in English; an internal
> engineering note may use the working language.

该段在两种角色中都位于 `runtime/shared` 之后、团队可编辑的 `Communication`
之前；它是新的内置 part，不会替换或重置已有用户提示词、覆盖项和版本历史。
提示词编辑器显示「正文语言 / Message language」，预览会列出该段。

### 预览结果

`docs/evidence/m6c-c/prompt-preview.json` 是 `Prompts.preview()` 的实际输出：
两种角色的 parts 都包含 `runtime/language`，正文含
“Chinese when the person wrote Chinese”，并覆盖接单、提问、进度/失败、完成四类
正文。`upstream-prompt-tests.log` 记录上游提示词/编辑器测试结果。

### 未验

**真实任务回执未执行。** 本轮没有启动隔离的 supervisor/DSH 执行实例和可投递的
测试仓库，因此没有让真实任务经过「接单 → 执行 → 完成回执」来观察中文正文。
预览证明提示词已进入实际合成结果，但没有替代真实执行回执。生产发布后应在
测试仓库跑一条真实任务，确认接单、提问/进度、失败和完成正文的语言。

## 4. 检查与退出码

见 `docs/evidence/m6c-c/README.md` 的命令表；`check.log`、`build.log`、
`integration.log`、`upstream-build.log`、`verify-lock.log` 保留原始输出。

未验证项：真实任务回执、生产发布、真实手机通知（D 段）、生产数据库/服务。
