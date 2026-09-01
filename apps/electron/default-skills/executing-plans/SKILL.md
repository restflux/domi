---
name: executing-plans
description: Use when a written implementation plan already exists and must be executed. Follow the current Domi Session Target and continue through safe batches without inventing extra approval pauses. A plan does not itself trigger full TDD: use Red/Green only when the user explicitly requested TDD or the seam meets the same high-risk boundary as the tdd Skill.
version: "1.0.6"
---
# Executing Plans

## Overview

读取已有计划，先做一次关键缺口检查，再按可验证垂直切片执行。**默认连续执行**；计划存在不代表每三个任务都要打断用户。

## Process

### 1. Review once

1. 读取计划和系统注入的 `## Session Target`；
2. 检查是否存在会改变产品方向、安全边界或不可逆数据语义的缺口；
3. 有真正阻塞项时只问一个关键问题；没有则立即开始。

不要因为命名、局部实现方式或可通过测试决定的细节暂停。

### 2. Execute vertical slices

先对每个切片复核测试先行门槛：只有用户明确要求 TDD/BDD/先写测试，或该 seam 涉及安全、权限、计费、数据一致性、迁移、并发、关键业务不变量等高风险行为，且失败测试能显著降低契约误判风险时，才执行完整 Red/Green。

普通切片：

1. 必要时更新可见进度任务；
2. 明确 public behavior 与最聚焦验证；
3. 写最小实现；
4. 补必要回归测试并运行相关检查。

命中 TDD 门槛的切片：

1. 写一个失败行为测试并确认 Red；
2. 写最小实现并确认 Green；
3. 保持测试为绿后重构；
4. 做范围匹配的回归检查。

不要因为计划文本写了“Red/Green”就机械扩大流程，也不要先批量写完所有测试或在每个微小修改后跑全仓验证。

### 3. Checkpoints without unnecessary waits

以下情况才暂停等待用户：

- 计划或用户明确要求阶段确认；
- 新发现会改变产品目标、权限/安全边界或不可逆数据语义；
- 验证连续失败且合理修复仍无进展；
- 范围显著超出已批准计划。

其他情况下，完成一个安全 batch 后可以记录进度并继续。**不要仅为了批次边界暂停等待用户**，也不要固定说“Ready for feedback”。

### 4. Final verification

- 按变更风险选择 Quick / Standard / Full 验证，不重复无价值检查；
- 如实记录 baseline failure 与 current regression；
- 当前是 owner Isolated Checkout 时，以 `ReadyForReview` 作为最后一个单独工具调用；
- 不自行 Apply、合并、清理或切换 Worktree。

## Session Target rules

- Domi-managed Isolated Checkout：直接使用当前 cwd，禁止嵌套 worktree。
- Local Checkout：除非用户或计划明确要求隔离，否则使用当前目标；需要托管隔离时只调用 Domi 提供的 handoff 工具。
- 永远不要运行 `git worktree add`、用 `cd` 切换到另一 checkout，或绕过 Domi 的 Diff/Apply/Discard 生命周期。

## Stop conditions

仅在以下情况停止：阻塞依赖缺失、计划核心语义不清、权限/安全边界需要新确认、或验证失败无法在当前范围内收口。普通实现选择由 Agent 基于代码和测试自行决定。
