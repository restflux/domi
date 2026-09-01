# Architecture Decision Records

ADR 记录已经进入 Domi 长期架构边界的决策。状态含义：

- **Accepted**：当前实现和后续改动必须遵守。
- **Proposed**：方向已记录，但不能当作当前完整产品能力。
- **Superseded**：保留历史背景，当前行为以替代 ADR 为准。
- **Partially superseded**：部分机制仍存在，冲突部分以新 ADR 为准。

## 索引

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](./0001-pi-as-primary-runtime.md) | Superseded by 0002 | Pi 成为唯一前瞻 Runtime 的过渡决策 |
| [0002](./0002-pi-only-agent-runtime.md) | Accepted | Pi-only Agent Runtime |
| [0003](./0003-separate-application-identity.md) | Accepted | Domi 使用独立应用身份与数据目录 |
| 0004 | Retired | 私人 Fork 的上游跟踪方式不属于公开产品架构 |
| [0005](./0005-separate-workflow-from-execution-policy.md) | Accepted | Workflow 与 Execution Policy 独立 |
| [0006](./0006-session-scoped-isolated-checkouts.md) | Accepted | Session-scoped Isolated Checkout 与 Apply |
| [0007](./0007-host-owned-regression-verification.md) | Proposed | 宿主拥有的回归验证门禁 |
| [0008](./0008-git-panel-scope.md) | Accepted | Git Panel 聚焦会话日常闭环 |
| [0009](./0009-integrated-browser-architecture.md) | Accepted | WebContentsView 与 Main-owned Browser 原子操作 |
| [0010](./0010-integrated-terminal-architecture.md) | Accepted | Main-owned Terminal Session 与隔离 PTY Runtime |
| [0011](./0011-canonical-shell-analysis-and-full-access-trust.md) | Partially superseded by 0016 | Canonical Shell Analysis 与执行信任；用户模式已收敛 |
| [0012](./0012-split-permission-interaction-from-policy-resolution.md) | Accepted | 权限交互与策略解析分离 |
| [0013](./0013-host-authoritative-global-work-activity.md) | Accepted | 从宿主事实派生全局 Work Activity |
| [0014](./0014-explicit-trust-for-pi-extensions.md) | Accepted | Pi Extension 必须显式按路径和内容授权 |
| [0015](./0015-session-scoped-external-impact-grants.md) | Partially superseded by 0011 | 普通 Git push 的有界会话能力 |
| [0016](./0016-research-and-execute-workflows.md) | Accepted | 研究 / 执行成为唯一持久 Work 模式 |

## 本轮编号整理

原目录同时使用了两组 `0002` 和两组 `0010`。为保留已经唯一发布的 ADR 编号，重复文件移动到新的编号；私人 Fork 工作流不再作为产品 ADR：

| 旧路径 | 当前路径 |
| --- | --- |
| `0002-explicit-trust-for-pi-extensions.md` | `0014-explicit-trust-for-pi-extensions.md` |
| `0004-maintain-a-private-upstream-tracking-mirror.md` | 已删除；编号保留为 Retired |
| `0010-session-scoped-external-impact-grants.md` | `0015-session-scoped-external-impact-grants.md` |

新增 ADR 必须使用下一个未占用编号，并在本索引中声明状态和替代关系。已发布、删除或 Retired 的编号都不得复用。
