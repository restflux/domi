---
name: writing-plans
description: Use only when the user explicitly asks for an implementation plan, the current Workflow is Plan First, or a broad/high-risk coding change needs a durable plan before edits. Do NOT use for low-risk coding, local bug fixes, or clear small changes that can be implemented and verified directly.
version: "1.0.7"
---
# Writing Plans

## When to use

使用本 Skill 的条件至少满足一项：

- 用户明确要求实施计划、开发计划或先出方案；
- 当前 Workflow 是 Plan First；
- 调查确认涉及权限、安全、凭据、数据迁移或删除、并发一致性、外部发布、不可逆操作、跨 package 架构改造；
- 成功标准存在实质歧义，直接编码会造成明显返工风险。

**Do NOT use for low-risk coding**：目标明确的局部 bug、少量相关文件修改、可回滚 UI 调整和已有 seam 上的普通功能，直接按 Coding Fast Lane 实现并做聚焦验证。任务包含多个自然语言步骤，本身不构成写长计划的理由。

## Plan depth

计划只写实施所需信息，不为了模板完整而扩张：

- 准确目标和非目标；
- public behavior seam 与风险边界；
- 需要创建/修改的精确文件；
- 实施与验证顺序；只有用户明确要求 TDD，或 seam 涉及安全、权限、计费、数据一致性、迁移、并发、关键业务不变量等高风险行为时，才写完整 red → green；
- 精确验证命令；
- 真实风险、回滚和阻塞决策。

普通 Standard 改动优先短计划；只有 Guarded 改动才写完整独立 Implementation Plan。

## Location

- Plan First：写入系统提示词注入的当前会话 `.context/plan/`，不要写项目根。
- 用户明确要求跨会话持久实施文档：写入用户指定位置；未指定时才使用 `docs/plans/YYYY-MM-DD-<feature-name>.md`。

## Durable plan header

只有创建项目级独立 Implementation Plan 时才使用：

```markdown
# [Feature Name] Implementation Plan

> **For Domi Agent:** Use the `executing-plans` Skill to implement this plan while preserving the selected Session Target.

**Goal:** [One sentence]

**Architecture:** [2-3 sentences]

**Tech Stack:** [Key technologies]

---
```

## Task structure

每个任务应是可验证的垂直切片，但计划本身不得把普通功能和局部 bug 自动升级成完整 TDD：

```markdown
### Task N: [Behavior]

**Files:**
- Create/Modify/Test: `exact/path`

**Step 1: Define the public behavior and focused validation**
**Step 2: Implement the smallest coherent change**
**Step 3: Run the focused regression checkpoint**
```

只有命中 `tdd` Skill 的明确意图或高风险门槛时，才把该切片改写为“失败行为测试 → 确认 Red → 最小实现 → 确认 Green → 重构”。已有计划写了 Red/Green 也不等于必须机械执行；若与当前风险门槛冲突，应保留验收行为并降级为聚焦回归，而不是扩大流程。

## Domi lifecycle

- 当前 Session Target 是权威位置；不要手工创建或切换 Git worktree。
- 不要把每个计划 Task 分派成临时子 Agent；只有真正独立且明显耗时的方向才使用 Domi collaboration。
- Domi managed Worktree 中不要插入手工 `git commit` checkpoint；以测试、`git diff --check` 和最终 `ReadyForReview` 交付。
- 计划完成后，若用户已经授权实施且无阻塞决策，可继续执行，不要额外要求一句“继续”。
