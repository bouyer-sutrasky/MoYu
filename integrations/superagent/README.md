# superagent 集成基线

本目录固定本项目依赖的上游 superagent 与 Harness 制品，并记录后续补丁的边界。M0 只做取证与锁定，没有修改上游或 bootstrap 实例。

## 文件

| 文件 | 用途 |
| --- | --- |
| `upstream.lock.json` | 可追溯版本、commit/tarball 摘要、安装清单摘要、构建结果与已知失败 |
| `compatibility-findings.md` | Source / Session / stop-retry / 模型 / 执行准入的真实差异与补丁落点 |
| `verify-lock.sh` | 只读核对现场安装制品是否仍与锁定值一致 |
| `patches/`（后续） | 按顺序应用的补丁；`git apply` 失败即停止构建，不模糊套用 |

环境、隔离 profile、两实例通知实验与清理步骤见 [`docs/environment-baseline.md`](../../docs/environment-baseline.md)。

## 固定组合

- superagent：`deepseek-ai/dsh-superagent-prototype` commit `6337fc823ce20251c8de8085948165c81aaa701e`
- Harness：`@deepseek-ai/dsh@0.2.1-rc.2`（tag `dsh-v0.2.1-rc.2`）
- Node 22.23.3；构建用 `pnpm@11.7.0`

## 校验

```bash
integrations/superagent/verify-lock.sh
```

可选传入 tarball 做网络侧复核：

```bash
SUPERAGENT_TARBALL=/path/to/6337fc8.tar.gz \
DSH_TARBALL=/path/to/dsh-0.2.1-rc.2.tgz \
integrations/superagent/verify-lock.sh
```

## 约束

- 不把 `/root/dsh-superagent` 当作可编辑发布物；补丁在固定 commit 的 checkout 上生成，并作为有序 patch 提交。
- 运行 `pnpm check` 必须用干净环境，避免 worker shell 的 `GIT_CONFIG_GLOBAL`/`PATH` 污染（见 environment-baseline §4）。
- 当前上游 `pnpm check` 有 1 条可选 Feishu 测试失败；不得把它描述成全绿。
- 不提交 token、私钥、Cookie、真实绑定码或数据库内容；测试仓库只放探针文件。
- 不修改 bootstrap profile/state/3082；被测实例必须使用独立 `DSH_HOME`、state、端口和测试仓库。
