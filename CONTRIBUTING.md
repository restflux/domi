# Contributing to Domi

感谢你改进 Domi。这个仓库是 Bun workspace monorepo，桌面应用位于 `apps/electron`，共享包位于 `packages/`。

## 开始之前

- 先阅读 [`AGENTS.md`](./AGENTS.md) 和 [`CONTEXT.md`](./CONTEXT.md)。
- 架构边界与状态见 [`docs/adr/README.md`](./docs/adr/README.md)。
- 安全问题不要提交公开 Issue，请按 [`SECURITY.md`](./SECURITY.md) 私下报告。
- 大改动建议先开 Issue 说明用户问题、预期行为和影响范围；小型修复可以直接提交 PR。

## 本地开发

需要 Bun 1.2.5+、Git，以及当前平台可用的 Electron 构建环境。

```bash
bun install --frozen-lockfile
bun run dev
```

常用验证：

```bash
bun test
bun run typecheck
bun run electron:build
git diff --check
```

只运行受影响测试通常更快；修改共享类型、根配置、打包或跨 package 接口时再扩大验证范围。

## 代码与产品约定

- 使用 TypeScript 严格模式，不使用 `any`；对象结构优先使用 `interface`。
- Renderer 状态管理使用 Jotai。
- 注释和日志优先使用中文，保留必要的技术术语。
- Domi 本地优先；会话和大部分配置使用 JSON / JSONL。不要在没有 ADR 的情况下扩大数据库范围。
- 新增 IPC 时同步更新 shared 类型、Main handler、Preload bridge 和 Renderer 调用。
- 用户界面称为 **Work**；内部 `agent` 命名和 `@domi/*` 兼容标识不要机械重命名。
- 不要恢复 Proma 官方自动更新或发布通道。
- 不要在提交、PR 或生成内容中添加产品推广归因。

## 测试与版本

Domi 使用 BDD 风格测试：断言用户可观察行为和长期契约，不绑定偶然实现细节。

- 先运行最相关测试，再运行受影响 workspace 的 typecheck。
- 修改 Electron、shared、core、ui、CLI 或 session-core 行为时，递增对应 package 的 patch 版本。
- 修改 `apps/electron/default-skills/<skill>/` 时，必须同时递增该 Skill `SKILL.md` frontmatter 的 patch 版本，并更新默认 Skill manifest。
- 纯文档修改无需机械递增 package 版本；若修改应用文案、打包资源或运行时行为，则按受影响包处理。

## 第三方内容

提交 vendored 代码、默认 Skill、字体、图标、模板或原生二进制前：

1. 确认来源和精确许可证；
2. 保留版权与许可证文件；
3. 更新 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)；
4. 不提交许可证不明、仅限非商业或禁止再分发的材料。

## Pull Request

PR 描述应包含：

- 要解决的问题和最终行为；
- 主要实现与影响范围；
- 执行过的测试命令和结果；
- UI 改动的截图或录屏；
- 数据格式、权限、网络、打包或迁移风险。

保持提交聚焦，不混入无关格式化、生成文件、个人路径、凭据、会话记录或构建产物。向本项目提交贡献即表示你同意按项目的 AGPL-3.0 许可证提供该贡献。
