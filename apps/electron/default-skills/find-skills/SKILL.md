---
name: find-skills
description: Discover and compare external agent Skills only when the user explicitly asks to find, browse, compare, or install a Skill, or explicitly wants to extend Agent capabilities with an installable Skill. Do not trigger for ordinary “how do I do X”, “can you help with X”, or specialized tasks the current Agent can answer or execute directly. Searching is read-only; installing any external Skill requires explicit confirmation after source/content review, defaults to the current Domi workspace, and must not use global unattended flags such as `-g -y`.
version: "1.0.2"
---
# Find Skills

Use this Skill to discover external Skills from the open ecosystem without turning ordinary help requests into package searches.

## When to use

Use only when the user explicitly wants one of these outcomes:

- “帮我找一个 X Skill / 有没有现成 Skill”；
- 比较几个 Skill 的来源、能力和适用边界；
- 安装、更新或扩展 Agent 的 Skill 能力；
- 当前 Agent 明确缺少一项可复用能力，且用户同意先搜索外部生态。

Do **not** use when:

- 用户只是问 “how do I do X / 怎么做 X”；直接回答；
- 用户问 “can you help with X”；当前 Agent 能做就直接执行；
- 仓库或 Domi 工作区已有匹配 Skill；优先复用已有能力；
- 需求是一次性的，做成/安装 Skill 没有复利价值。

## Search before install

搜索和安装是两个独立阶段。

1. 先检查当前会话提供的 `available_skills` 与 Domi 工作区 Skills，避免重复安装。
2. 用户明确要搜索外部生态时，可以运行只读搜索：

```bash
npx skills find <specific-query>
```

3. 展示候选时说明：
   - 名称与解决的问题；
   - 来源仓库/发布者；
   - 与现有 Skill 是否冲突；
   - 安装范围与潜在副作用；
   - 可查看的来源链接。
4. 没找到时直接说明，并继续用通用能力帮助；只有重复流程明确成立时才提议 `skill-creator`。

## Supply-chain boundary

External Skills are executable instructions and may include scripts. Before installation:

- 读取候选 `SKILL.md` 与会执行的脚本/命令；
- 检查来源可信度、维护状态、license 和明显的凭据/网络/删除副作用；
- 提醒用户这是外部内容，不由 Domi 内置维护；
- 明确询问用户是否安装这个具体候选及安装范围。

未经用户明确确认，不得执行任何安装或更新命令。

## Installation defaults

用户确认后：

- 默认安装到当前 Domi 工作区，而不是用户全局目录；
- 使用交互式、可审计的安装方式；
- 不得使用 `-g -y`、`--global --yes` 或其他跳过确认的全局无人值守组合；
- 不要把来源不明的 Skill 安装进共享全局目录；
- 安装后重新读取实际落盘内容，确认没有与审查内容发生漂移。

如果用户明确要求全局安装，仍需再次说明影响范围，并在执行前获得对“全局”这一具体副作用的确认。

## Response style

搜索结果以 1–3 个高相关候选为限，不倾倒长列表。优先告诉用户“现有能力能否直接完成”，只有外部 Skill 真有额外价值时才推荐安装。
