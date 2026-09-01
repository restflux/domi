---
name: code-review
description: 从固定点(commit、分支、tag 或 merge-base)起审查改动,沿两条轴——Standards(代码是否符合仓库记录的规范)与 Spec(实现是否忠实于来源 issue/PRD/规格)。用 Domi collaboration 派一个 reviewer 子会话审查。当用户想审查分支、PR、进行中的改动,或说"review 一下/审查一下/帮我看看这段改动"时使用。不要用于修改后的常规复核、一句话的 diff、或只为获得"最终 Yes"的重复审查——那些由当前会话直接完成。
version: "1.0.0"
---

# Code Review(双轴审查)

> 基于 [mattpocock/skills](https://github.com/mattpocock/skills)(MIT License, Copyright 2026 Matt Pocock)改造。

审查 `HEAD` 与用户指定固定点之间的 diff,沿两条互相独立的轴:

- **Standards** — 代码是否符合仓库文档化规范(CLAUDE.md、CONTRIBUTING、ADR、工具配置等)?
- **Spec** — 实现是否忠实实现了来源 issue / PRD / 规格?

两条轴由**一个** Domi 协作子会话(role=review)完成,父会话聚合结果。**只派一个 reviewer、只跑一轮**;不要为了拿到"最终 Yes"反复续审。

## 流程

### 1. 确定固定点

用户说什么就是什么——commit SHA、分支名、tag、`main`、`HEAD~5`。不要自作主张。没给就问:"跟什么比?分支、某个 commit,还是 main?"没拿到固定点不往下走。

一次取齐 diff 与提交列表:`git diff <fixed>...HEAD`(三点,相对 merge-base)与 `git log <fixed>..HEAD --oneline`。

### 2. 找规格来源(Spec 轴的输入)

按顺序:

1. commit message 里的 issue 引用(`#123`、`Closes #45`、`!67`),通过项目可用的方式取内容(有 GitHub MCP 用 MCP,没有就用 `gh` 或提示用户提供)。
2. 用户直接给的路径。
3. `docs/`、`specs/` 下与分支名/特性匹配的 PRD/规格文件。
4. 都找不到就问用户。用户说没有规格,Spec 轴就跳过,并在报告里注明"无规格可对照"。

### 3. 找规范来源(Standards 轴的输入)

仓库里任何写明"代码该怎么写"的文件:`CLAUDE.md` / `AGENTS.md`、`CONTRIBUTING.md`、`CONTEXT.md`、`docs/adr/`、以及工具强制的配置(`tsconfig.json`、`eslint.config.*`、`.editorconfig` 等——记下它们,但不要重复检查工具已经强制的东西)。

### 4. 派一个 reviewer 子会话

用 Domi collaboration 派**一个** role=review 的子会话,任务自包含,包含:

- 固定点与 diff/commit 命令(子会话在相同工作目录执行);
- 规范来源文件清单;
- 规格来源(路径或内容摘要);
- 指令:「先读规范文档,再读 diff。逐文件/逐 hunk 报告——(a) 违反文档化规范的地方,引用规范(文件 + 具体规则),区分硬违规与判断取舍,跳过工具已强制的;(b) 规格要求了但缺失或只做了一半的需求;(c) diff 里规格没要求的内容(范围蔓延);(d) 看起来实现了但实现可疑的需求。每条发现引用来源。总字数控制在 400 字内。」

给子会话设定合理的时间预算(默认 900 秒);**不要派两个子会话并行跑两条轴**——一个 reviewer 依次完成即可,避免协调成本。

### 5. 聚合报告

父会话把子会话结论按 `## Standards` 与 `## Spec` 两个标题原样(或轻度整理)呈现。**不要合并或重新排序发现**——两条轴刻意分开,让用户独立判断。

结尾一行总结:每条轴的发现总数 + 最严重的单条问题(若有)。

## 为什么是两条轴

一个改动可以过一条轴挂另一条轴:

- 每条规范都遵守但做错了需求 → **Standards 过,Spec 挂**。
- 完全按 issue 要求做但违反项目惯例 → **Spec 过,Standards 挂**。

分开报告,一条轴就不会掩盖另一条轴。

## 何时不该用本技能

- 改动小于 20 行、单文件、一眼可判:父会话直接看 diff 给结论。
- 修复后的常规复核(Medium/Low 发现):父会话自己修、自己测,不要为"最终 Yes"重复派 reviewer。
- 用户要的是"帮我看看思路对不对"的讨论,而不是正式审查:直接对话,不派子会话。
