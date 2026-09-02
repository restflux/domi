# Domi

Domi 是一款本地优先的 Personal Coding Workbench。它把多模型 Chat、可执行的 Work 会话、项目文件、终端、内置浏览器、Skills、MCP、Automation、任务与日程放进同一个 Electron 桌面应用。

> Domi 正在快速迭代，首个公开版本线从 **0.20.0** 开始。Windows 与 Linux 预发布安装包通过 GitHub Releases 提供；Domi 不提供自动更新或自动安装，也不会连接第三方产品的发布通道。

[English README](./README.en.md) · [使用教程](./tutorial/tutorial-v2.md) · [工程文档](./docs/README.md) · [贡献指南](./CONTRIBUTING.md)

![Domi Work 会话在隔离 Worktree 中编辑代码，并在右侧实时展示 Diff](./docs/images/readme/work-session.webp)

<p align="center"><sub>Work 会话在隔离 Worktree 中持续执行，文件改动与 Diff 同步可见。</sub></p>

## 核心能力

- **面向 coding 的 Work 会话**：Pi Agent Runtime 可以调查代码、修改文件、运行测试、启动服务并持续完成多步骤任务。
- **研究 / 执行两种工作方式**：研究模式保持项目只读，需要修改时可申请“本次执行”；执行模式直接修改并验证。
- **Isolated Worktree 交付**：每个会话可使用 Local 或 Domi managed Isolated Checkout，并通过 Checkpoint、Preview、验收提交、可证明安全的撤回、恢复和交接完成闭环。
- **轻量 Git 工作流**：在文件改动面板完成状态查看、Diff、暂存/取消暂存、提交、同步、分支选择和最近历史。
- **完整 coding 工作区**：多实例 Right Workspace 标签统一承载文件 Preview、Scratch Pad、可见 PTY 终端、Agent Run、服务地址和内置浏览器。
- **长任务连续性**：支持后台会话、实时 Steering、Follow-up 队列、Pi 原生上下文压缩、AI 生成的可复制交接内容、跨项目继任会话和 Collaboration 子会话。
- **多模型 Chat**：支持 Anthropic、OpenAI、Google、DeepSeek、Kimi、智谱、MiniMax、豆包、通义千问和自定义兼容端点。
- **本地优先与扩展**：会话、配置、Skills、MCP、审计、Automation 和 Planning 保存在本机，并支持 Chat HTTP 工具与飞书集成。

## 快速开始

### 环境

需要：

- [Bun](https://bun.sh/)
- Git
- 当前平台可用的 Electron 构建环境

Windows 是当前必过平台；Linux 发布包会在 GitHub Actions 中完成打包与启动检查，macOS 提供手动兼容检查。

### 下载预发布安装包

从 [GitHub Releases](https://github.com/restflux/domi/releases) 下载当前预发布版本：

- **Windows x64**：下载 `Domi-<version>-windows-x64-setup.exe`。当前安装包未签名，Windows SmartScreen 可能显示“Windows 已保护你的电脑”；请先核对 Release 来源与 `SHA256SUMS.txt`，再决定是否继续运行。
- **Linux x64 AppImage**：下载 `Domi-<version>-linux-x64.AppImage`，添加执行权限后运行：`chmod +x Domi-*.AppImage`。
- **Linux x64 Debian/Ubuntu**：下载 `Domi-<version>-linux-x64.deb`，使用系统软件安装器或 `sudo apt install ./Domi-*.deb` 安装。
- **macOS**：目前没有经过真实 Mac 验证的预构建包，请暂时从源码构建。

Domi 不内置自动更新。升级时请重新访问 Releases，并使用随 Release 提供的 `SHA256SUMS.txt` 校验下载文件。

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

Windows 本地验证与发布候选包：

```bash
cd apps/electron
bun run dist:win:fast      # 本地快速验证
bun run dist:win:unsigned  # 未签名 Pre-release，正式压缩
bun run dist:win:release   # 配置代码签名后的正式发布
```

`dist:win:fast` 只用于本地验证；公开的未签名安装包必须使用 `dist:win:unsigned` 并明确标为 Pre-release。详见[发布文档](./docs/releasing.md)。

## 面向 coding 的 Work 流程

### 研究与执行

界面只提供两种持久工作方式，两者底层都使用当前 Windows 用户权限，Domi 不提供 OS 沙箱：

- **研究**：以只读 Workflow 调查代码、文档和网页；需要写入时可申请仅对当前 run 生效的“本次执行”，结束后自动恢复研究。
- **执行**：直接修改项目、运行命令和验证结果。Local 回写、破坏性 Git、外部发布、扩展信任等宿主事务仍保留独立确认。

### Isolated Worktree 交付

Work 会话可以直接使用 Local Checkout，也可以由 Domi 创建隔离 Worktree：

- Agent 在隔离 checkout 中修改、测试和启动服务，不与 Local 未完成工作互相覆盖；
- Checkpoint 保存阶段成果，Ready for Review 固化验收上下文；
- Preview 将任务层投影到 Local 供真实环境验收，通过后收敛为单个提交；
- Preview 撤回会验证 Local、分支和历史仍与交付快照一致，无法证明安全时 fail closed；
- 冲突预检、恢复状态、保留策略、批量清理和跨会话 handoff 都由宿主追踪；
- owner / inherited 会话共享目标时，交付、清理和 Local 写入仍只允许 owner 执行。

![Domi 将隔离 Worktree 的任务改动预览到 Local，并提供确认保存或安全撤回](./docs/images/readme/worktree-preview.webp)

<p align="center"><sub>任务改动先 Preview 到 Local 验收，再确认保存或安全撤回。</sub></p>

### Git、终端与浏览器

- 文件改动面板提供轻量 Git 闭环，不尝试成为完整 Git 客户端；
- 内置终端支持多个 PTY、Shell profile、用户终端与 Agent Run 隔离，以及本地服务地址检测；
- 内置浏览器提供用户可见页面和有界 Snapshot/ref、点击、普通文本输入、滚动与文本提取；
- Right Workspace 可以同时保留多个文件、Browser、Terminal、Preview 和辅助工具标签。

### 长任务连续性

Agent 工作期间可以继续排入 Follow-up，不需要打断当前步骤；后台会话、Steering、上下文压缩和跨会话 handoff 让长任务保持连续。尚未执行的草稿可以迁移项目；已执行会话统一通过“交接到新会话”选择当前或其他项目，并可使用项目当前目录或新建独立工作区（Worktree）。交接内容由来源会话的当前模型根据持久化对话、代码状态和验证证据生成，可直接创建继任会话，也可仅复制；原会话绑定保持不变。

![Domi 在隔离 Worktree 中执行任务，并将追加要求放入 Follow-up 队列](./docs/images/readme/follow-up-worktree.webp)

<p align="center"><sub>执行中的 Worktree、实时进度与 Follow-up 队列保持在同一会话。</sub></p>

### 安全边界

- Shell 决策基于结构化分析，解析不确定时 fail closed；
- Managed Web 与 Browser 限制私网、凭据、重定向和交互范围，但不等同于网络沙箱；
- Session Target、Local Baseline、Worktree ownership 和外部影响确认不能被研究/执行模式绕过；
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
