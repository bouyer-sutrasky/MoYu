# M1 Web 视觉证据

本目录保存 M1 最小 Web 页面在真实浏览器中的截图。截图是验收证据，不是最终视觉设计；M2 才会接入固定上游 design tokens 与完整外壳。

## 场景

| 项 | 值 |
| --- | --- |
| 场景 | 在浏览器打开 MoYu Web 应用（`http://127.0.0.1:4173/`），API 使用已迁移的真实 PostgreSQL |
| 视口 | 1440 × 900 |
| 主题 | 浅色（`colorScheme: light`） |
| 浏览器 | Chromium 141.0.7390.37（Playwright 1.56.1 驱动，headless） |
| 基线版本 | `main` @ `234b4a5`（M0 结束、M1 开始前） |
| 变更版本 | 本 PR 分支 `agent/engineering-storage-m1-d43804e68d37` |
| 采集时间 | 2026-11-03T08:49Z–08:50Z |

## Before：`before-desktop-light.png`

M1 之前的默认分支**没有 Web 应用**：`git ls-tree main` 只有 `AGENTS.md`、`LICENSE`、`README.md`、`docs/`、`integrations/`，没有 `apps/web`，也没有 Web 服务。因此不存在可截取的旧页面；在相同 URL 打开时的真实行为是连接被拒绝（`ERR_CONNECTION_REFUSED`），该截图记录的就是这一基线状态。

这是本 PR 唯一无法提供“旧界面截图”的原因：旧界面从未存在，而不是缺少取证。未使用 mockup 冒充旧实现。

## After：`after-desktop-light.png`

使用 `pnpm build` 产物启动 `vite preview`，API 连接空库迁移后的 PostgreSQL：

- 页面标题：`MoYu`
- 状态：`正常 · v0.1.0 · 已运行 29s`（来自 `/healthz` 的真实响应）
- 浏览器控制台错误：无
- 页面正文包含 M1 已建立能力、M2/M3 后续阶段与“Chat 当前不可发送”的明确说明。

## 复现命令

```bash
# 1. 准备并迁移一个真实 PostgreSQL 数据库
DATABASE_URL=postgres://moyu:CHANGE_ME@127.0.0.1:5432/moyu pnpm db:migrate

# 2. 构建并启动 API 与 Web 构建产物
pnpm build
DATABASE_URL=postgres://moyu:CHANGE_ME@127.0.0.1:5432/moyu node apps/api/dist/server.js
pnpm --filter @moyu/web preview --port 4173 --strictPort

# 3. 用 Playwright 以相同视口、浅色主题打开 http://127.0.0.1:4173/
```

截图文件由 Playwright 直接生成，未编辑页面内容。
