# Domi 文档

本目录只保留帮助用户使用 Domi、帮助贡献者理解当前架构，以及记录长期有效决策的文档。一次性实施计划、内部调研流水账、上游跟进评估和会话生成资料不进入正式文档树。

## 用户文档

- [中文 README](../README.md)：产品能力、安装、数据目录与开发入口。
- [English README](../README.en.md)：英文项目首页。
- [Domi 使用教程](../tutorial/tutorial-v2.md)：从配置渠道到 Chat、Work、Skills、自动任务和远程机器人的使用流程。
- [贡献指南](../CONTRIBUTING.md)：开发、测试、版本和第三方内容要求。
- [安全策略](../SECURITY.md)：支持范围与私下漏洞报告方式。
- [桌面安装包发布](./releasing.md)：Windows/Linux 资产、Release Candidate、tag、校验和与 Draft Release 人工审核流程。
- [第三方声明](../THIRD_PARTY_NOTICES.md)：上游来源、bundled Skills、字体、图标和原生依赖许可。

## 工程文档

- [项目领域语言](../CONTEXT.md)：产品术语和关键不变量。
- [项目开发约束](../AGENTS.md)：仓库结构、命令、代码风格、打包和 Agent Runtime 约束。
- [Pi 上下文压缩架构](./architecture/context-compaction.md)：压缩生命周期、pinned facts、预算和回退边界。
- [Vision Relay 架构与安全边界](./architecture/vision-relay.md)：图片授权、规范化、单次外发和不可信结果。

## 架构决策

- [ADR 索引](./adr/README.md)：当前有效、已取代和仍处于提议阶段的架构决策。

## 文档维护规则

1. README 和教程描述用户当前能够使用的行为。
2. `architecture/` 只记录当前实现和长期不变量，不记录按轮次排列的实验过程。
3. `adr/` 记录有长期约束力的决策；被替代的 ADR 保留状态和替代关系。
4. 尚未实施的工作进入 Issue 或当前任务计划，不以日期计划文件堆积在仓库中。
5. 外部项目研究、上游版本评估和作者观点应保留在任务 Context 或外部资料中；只有被 Domi 采用且能由当前代码验证的结论才提炼进正式文档。
6. 文档不得包含凭据、个人绝对路径、会话转录、私有构建策略或本地生成产物。
