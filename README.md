# Domi

Domi 是一款本地优先的 Personal Coding Workbench。它把多模型 Chat、可执行的 Work 会话、项目文件、终端、内置浏览器、Skills、MCP、Automation、任务与日程放进同一个 Electron 桌面应用。

> Domi 正在快速迭代。目前以源码构建为主要使用方式，不提供自动更新或自动安装，也不会连接第三方产品的发布通道。

[English README](./README.en.md) · [使用教程](./tutorial/tutorial-v2.md) · [工程文档](./docs/README.md) · [贡献指南](./CONTRIBUTING.md)

## 核心能力

- **多模型 Chat**：支持 Anthropic、OpenAI、Google、DeepSeek、Kimi、智谱、MiniMax、豆包、通义千问和自定义兼容端点。
- **Work 会话**：由 Pi Agent Runtime 驱动，可读取和修改项目、运行测试、使用工具并持续交付多步骤任务。
- **执行控制**：Execution Policy 与 Workflow 独立；权限强度、Plan First 和 Session Target 不会互相隐式提升。
- **项目工作台**：文件树、Diff、Preview、Scratch Pad、内置终端和内置浏览器集中在同一窗口。
- **本地优先**：会话、配置、Skills、MCP、审计和大部分状态保存在本机；任务与日程使用本地 SQLite。
- **扩展能力**：支持工作区 Skills、MCP Server、Chat HTTP 工具、Automation、Collaboration 和飞书集成。
- **多会话并行**：全局事件监听和按 session 隔离的状态模型让后台 Work 会话可以持续运行。

## 快速开始

### 环境

需要：

- [Bun](https://bun.sh/)
- Git
- 当前平台可用的 Electron 构建环境

Windows 是当前必过平台；Linux 运行类型检查，macOS 提供手动兼容检查。

### 从源码运行

```bash
bun install --frozen-lockfile
bun run dev
```

手动拆分开发进程：

```bash
cd apps/electron
bun run dev:vite
# 另一个终端
bun run dev:electron
```

### 构建与测试

```bash
bun test
bun run typecheck
bun run electron:build
```

Windows 本地验证包：

```bash
cd apps/electron
bun run dist:win:fast
```

`dist:win:fast` 生成无签名本地验证包；正式签名与公开发布必须显式使用 release 通道。详见[工程文档](./docs/README.md)。

## Work 的安全模型

Domi 把“允许做什么”和“按什么流程做”分开：

- **Execution Policy**：Controlled、Autonomous、Full Access。
- **Workflow**：Direct、Plan First；受限准备阶段只允许经过证明的读取和宿主管理能力。
- **Session Target**：Local Checkout 或 Domi managed Isolated Checkout。

关键边界：

- Full Access 使用当前 Windows 用户权限，不是 OS 沙箱。
- Plan 批准只改变 Workflow，不会提升 Execution Policy。
- Isolated Checkout 回写 Local、破坏性 Git、外部发布和扩展信任仍由宿主门禁控制。
- Shell 决策基于结构化分析；解析不确定时 fail closed。
- Browser 和 Managed Web 限制私网、凭据、重定向与交互范围，但不等同于网络沙箱。
- 用户 Shell 与 Agent 可见终端相互隔离。

架构与威胁边界见 [`docs/adr/`](./docs/adr/) 和 [`SECURITY.md`](./SECURITY.md)。

## 本地数据

正式版默认使用 `~/.domi/`，开发版使用 `~/.domi-dev/`：

```text
~/.domi/
├── channels.json
├── conversations.json
├── conversations/
├── agent-sessions.json
├── agent-sessions/
├── agent-workspaces/
├── attachments/
├── planning.db
├── settings.json
└── sdk-config/
```

- 渠道密钥通过 Electron `safeStorage` 加密。
- 会话主要使用 JSON / JSONL；本地规划模块使用 `planning.db`。
- Domi 不会自动读取其他产品的数据目录。旧数据只能通过显式迁移流程导入。
- 项目文件和用户仓库不会被注入产品推广归因。

## Monorepo

Domi 使用 Bun workspace：

```text
domi/
├── apps/
│   ├── cli/            # Domi CLI 与会话渐进式读取
│   └── electron/       # Electron 主进程、Preload、Renderer
├── packages/
│   ├── core/           # Provider adapters 与代码高亮
│   ├── session-core/   # Agent 会话解析与导出真源
│   ├── shared/         # 共享类型、配置和 IPC 常量
│   └── ui/             # 共享 React UI 组件
├── docs/adr/           # 架构决策记录
└── scripts/            # 构建、测试和仓库门禁
```

内部 workspace package 使用 `@domi/*`，当前只作为 monorepo identity，不表示已发布到 npm。

常用入口：

```bash
bun run dev
bun run typecheck
bun test
bun run electron:build
```

修改代码前请阅读 [`AGENTS.md`](./AGENTS.md)、[`CONTEXT.md`](./CONTEXT.md) 和 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 文档

- [Domi 使用教程](./tutorial/tutorial-v2.md)
- [工程文档索引](./docs/README.md)
- [领域语言](./CONTEXT.md)
- [架构决策](./docs/adr/README.md)
- [安全政策](./SECURITY.md)
- [第三方声明](./THIRD_PARTY_NOTICES.md)

## 贡献与安全

欢迎通过 Issue 和 Pull Request 改进 Domi。提交前请运行最相关测试，并在涉及 shared 类型、根配置、打包或跨 package 接口时扩大验证范围。

安全问题请勿提交公开 Issue；请按 [`SECURITY.md`](./SECURITY.md) 使用 GitHub Private Vulnerability Reporting。

## 来源与许可证

Domi 演进自 [Proma](https://github.com/proma-ai/Proma)，并进行了大量产品、运行时和安全边界改造。上游及后续贡献者的版权分别保留；详细归属见 [`NOTICE`](./NOTICE) 与 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

本项目采用 [GNU Affero General Public License v3.0](./LICENSE)。使用、修改、分发或通过网络提供修改后的版本时，请遵守 AGPL-3.0 的对应源代码义务。
