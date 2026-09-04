# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

**重要提示：**
- 当功能发生变化时，请保持此文件和 `README.md` 同步更新。请更新文档以反映当前状态，但是需要经过我的允许后再修改。
- 所有的注释和日志优先采用中文，保留必要的专业术语部分。
- 所有的依赖包的安装都要先进行搜索，综合判断依赖采用的版本，而不是默认采用某个版本。
- 状态管理上我们全部采用 Jotai 来实现。
- 这是个开源项目，本地存储优先；会话和大部分配置优先采用 JSON / JSONL，不使用 localStorage。规划模块已有 `planning.db` SQLite 例外，不要在没有 ADR 的情况下继续扩大数据库范围。
- 保证充分的组件化以及人类的可读性，每次完成改动后都要思考这一点，运行@code-simplifier 来简化优化代码，保持简单直接不过渡设计的风格。
- 在 UI 设计上采用更现代的方案，UI 组件推荐采用 ShadcnUI，在合适的情况下，用卡片和阴影取代边框，用符合主题的饱满色彩，设置界面要设置背景，为未来做不同主题留下空间。
- 采用 BDD 行为驱动开发的方案。

## 项目概述

Domi 是基于 Proma 演进的 Personal Coding Workbench，采用 Electron 桌面应用架构。Domi 使用独立安装身份、本地数据目录、`@domi/*` workspace package 和 `DOMI_*` 活动环境变量，不连接 Proma 官方更新通道，也不向用户仓库注入上游 Git/PR 推广标识。旧 `.proma` 数据和旧推广标识只允许在显式迁移或拒绝识别路径中读取，不得继续作为 Domi 的主动写入格式。

Agent Runtime 固定为 Pi。用户可选的持久工作方式只有研究与执行：新会话默认执行，底层统一使用当前 Windows 用户权限且没有 OS 沙箱；研究通过只读 Workflow 限制项目写入，并可申请仅当前 run 生效的本次执行。所有工具调用仍经过宿主最终门禁；owner Isolated 的执行 run 可自动完成 managed Worktree 内部 Git 整理，并可在用户明确要求 push 时申请绑定 checkout/remote/ref、仅由宿主 push 工具消费的进程内会话授权。Managed Web、Pi Extension Trust 和脱敏 audit 均为宿主能力。

### 产品术语

- 用户界面中的 `agent` 应用模式统一显示为 **Work**；内部 `AppMode` 值、文件/组件/API 命名继续使用 `agent`。
- **Agent** 仍用于 Agent Runtime、Agent 会话、Domi Agent、子 Agent 等执行主体或技术概念，不应机械替换为 Work。

## Monorepo 结构

Bun workspace monorepo：

```
domi/
├── packages/
│   ├── shared/     # 共享类型、IPC 通道常量、配置、工具函数
│   ├── core/       # AI Provider 适配器、代码高亮服务
│   ├── session-core/# Agent 会话解析与导出真源
│   └── ui/         # 共享 UI 组件 (CodeBlock, MermaidBlock)
└── apps/
    ├── cli/        # Domi CLI
    └── electron/   # Electron 桌面应用
        └── src/
            ├── main/       # 主进程 + 服务层 (main/lib/)
            ├── preload/    # IPC 上下文桥接
            └── renderer/   # React UI (Vite + Tailwind + Radix UI)
```

**包命名规范**：`@domi/*` 作用域（`@domi/core`、`@domi/shared`、`@domi/ui`、`@domi/electron`）

**依赖管理**：package.json 中使用 `workspace:*` 引用内部包

### 包职责详解

#### @domi/shared
- **导出模块**：`./types`、`./config`、`./utils`；Shell/权限分类只存在于 Electron Execution Policy，不从 shared 导出 raw-string rules
- **关键类型**：`AgentMessage`、`ChatMessage`、`Channel`、`PermissionRequest`、`FeishuConfig`
- **依赖**：无运行时依赖（仅 TypeScript）

#### @domi/core
- **导出模块**：`./providers`、`./highlight`、`./types`、`./utils`
- **关键功能**：Provider 适配器注册表、代码高亮（Shiki）
- **依赖**：`@domi/shared`、`shiki`
- **Peer 依赖**：无

#### @domi/ui
- **关键组件**：共享 React UI 组件库
- **依赖**：`@domi/core`、`beautiful-mermaid`、`mermaid`、`shiki`
- **Peer 依赖**：`react@^18.3.0`、`react-dom@^18.3.0`

#### @domi/electron
- **职责**：Electron 桌面应用主体，集成所有包
- **关键依赖**：
  - `@earendil-works/pi-coding-agent@0.84.4` - 默认 Agent Runtime
  - `@larksuiteoapi/node-sdk` - 飞书集成
  - Radix UI、TipTap、Tailwind CSS
  - 内置终端：`node-pty` + `@xterm/xterm`，PTY 运行于 Electron utility process
  - 文件解析：`pdf-parse`、`officeparser`、`word-extractor`

## 常用命令

```bash
# 开发模式（推荐 - 自动启动 Vite + Electron + 热重载）
bun run dev

# 手动开发模式（调试时更稳定）
# 终端 1: cd apps/electron && bun run dev:vite
# 终端 2: cd apps/electron && bun run dev:electron

# 构建并运行
bun run electron:start

# 仅构建
bun run electron:build

# 类型检查（所有包）
bun run typecheck

# 单包类型检查
cd packages/core && bun run typecheck

# 测试
bun test

# 打包分发
cd apps/electron
bun run dist:mac          # macOS
bun run dist:win          # Windows 正式发布（等同 dist:win:release）
bun run dist:win:fast     # Windows 本地快速包：无签名、store 压缩，输出到 out/fast；上一份安装包保留在 out/fast-history/
bun run dist:win:unsigned # Windows 未签名公开发布包：手动 executable edit、正式压缩，输出到 out
bun run dist:win:release  # Windows 签名正式包：标准 executable edit + 代码签名流程
bun run dist:linux        # Linux x64 AppImage + deb
bun run dist:fast         # 当前架构快速打包（macOS 可视化脚本）
```

`.github/workflows/release.yml` 在手动触发时只构建并保存 Windows/Linux artifacts；推送与 package 版本一致的 `v*` tag 后才创建 Draft Release，仍需维护者核验并人工公开为正式 Release。只有 alpha、beta、rc 或明确测试版本才标记为 Pre-release。发布版本契约由 `scripts/verify-release-version.ts` 校验，完整流程见 `docs/releasing.md`。

### Electron 构建脚本（`apps/electron/` 目录下）

```bash
bun run build:main        # esbuild → dist/main.cjs
bun run build:terminal-runtime # esbuild → dist/terminal-runtime.cjs（external node-pty）
bun run build:preload     # esbuild → dist/preload.cjs
bun run build:renderer    # Vite → dist/renderer/
bun run build:resources   # 复制 resources/ 到 dist/
bun run generate:icons    # 生成应用图标
```

## 运行时环境

使用 Bun 代替 Node.js/npm/pnpm：

- `bun install` 安装依赖，`bun run <script>` 运行脚本
- `bun test` 运行测试（内置测试运行器，`import { test, expect } from "bun:test"`）
- Bun 自动加载 .env 文件（无需 dotenv）
- 优先使用 Bun 原生 API：`Bun.file` > `node:fs`，`Bun.$\`command\`` > `execa`

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| **运行时** | Bun | 1.2.5+ |
| **语言** | TypeScript | 5.0.0+ |
| **桌面框架** | Electron | 43.2.0 |
| **前端框架** | React | 18.3.1 |
| **状态管理** | Jotai | 2.17.1 |
| **UI 组件** | Radix UI | 最新 |
| **样式** | Tailwind CSS | 3.4.17 |
| **富文本编辑器** | TipTap | 3.19.0 |
| **代码高亮** | Shiki | 3.22.0 |
| **Markdown** | React Markdown | 10.1.0 |
| **图表** | Beautiful Mermaid | 最新 |
| **数学公式** | KaTeX | 0.16+ |
| **构建工具** | Vite | 6.0.3 |
| **打包工具** | esbuild | 0.24.0+ |
| **分发工具** | Electron Builder | 25.1.8 |
| **Agent SDK** | `@earendil-works/pi-*` | 0.82.1 |
| **飞书 SDK** | @larksuiteoapi/node-sdk | 最新 |

## 核心架构

### IPC 通信模式（最重要的架构模式）

类型定义 → 主进程处理 → Preload 桥接 → 渲染进程调用：

1. **类型 & 常量**：`@domi/shared` 定义 IPC 通道名称常量和请求/响应类型
2. **主进程处理**：`main/ipc.ts` 是大型高冲突 wiring 文件，只注册 `ipcMain.handle()` 并调用 `main/lib/` 服务；业务逻辑应下沉到深模块
3. **Preload 桥接**：`preload/index.ts` 通过 `contextBridge.exposeInMainWorld` 暴露类型安全的 API
4. **渲染进程**：通过 `window.electronAPI.*` 调用，Jotai atoms 中封装调用逻辑

添加新 IPC 通道时，需要同步修改这四个位置。

#### 主要 IPC 通道组

- `IPC_CHANNELS` - 基础通道（运行时、Git、环境）
- `CHANNEL_IPC_CHANNELS` - 渠道管理
- `CHAT_IPC_CHANNELS` - Chat 功能
- `AGENT_IPC_CHANNELS` - Agent 功能
- `ENVIRONMENT_IPC_CHANNELS` - 环境检查
- `PROXY_IPC_CHANNELS` - 代理设置
- `SYSTEM_PROMPT_IPC_CHANNELS` - 系统提示词
- `CHAT_TOOL_IPC_CHANNELS` - Chat 工具
- `FEISHU_IPC_CHANNELS` - 飞书集成
- `GITHUB_RELEASE_IPC_CHANNELS` - GitHub 发布
- `BROWSER_IPC_CHANNELS` - 内置浏览器可见 Host、用户导航、布局、缩放与固定 isolated-world 元素选择；选择结果由 Main 补齐页面身份并作为不可信 Work 输入引用，Agent Snapshot/ref 与原子操作保持 Main-only，不向 Renderer 暴露任意 CDP/selector/脚本

### 主进程服务层（`main/lib/`）

#### 核心服务

| 服务 | 职责 |
|------|------|
| `agent-orchestrator.ts` | Agent 核心编排层（71KB）：并发守卫、渠道查找、环境变量构建、SDK 路径解析、消息持久化、事件流处理、错误处理、自动标题生成 |
| `agent-session-manager.ts` | Agent 会话管理：SDK 消息持久化、会话元数据 CRUD、JSONL 存储 |
| `agent-prompt-builder.ts` | Agent 系统提示词构建（18KB）：动态上下文构建、内置 Agent 构建、工作区上下文注入 |
| `agent-permission-service.ts` | Agent 权限管理：工具权限检查、权限模式管理 |
| `agent-ask-user-service.ts` | Agent 用户交互：AskUser 请求处理 |
| `agent-exit-plan-service.ts` | Agent 退出计划服务 |
| `agent-workspace-manager.ts` | 工作区管理（16KB）：MCP Server 配置、Skills 配置、工作区 CRUD |
| `chat-service.ts` | Chat 流式调用编排（20KB）：Provider 适配器集成、消息持久化、AbortController |
| `conversation-manager.ts` | 对话管理（13KB）：对话 CRUD、JSONL 消息存储、置顶、上下文分割 |
| `channel-manager.ts` | 渠道管理（16KB）：渠道 CRUD、API Key AES-256-GCM 加密（safeStorage）、连接测试、模型获取 |
| `browser/` | Main-owned `WebContentsView` Browser Session、Profile/URL/权限策略、公开网络与严格 loopback 地址、缩放/适应宽度，以及基于短生命周期 ref 的有界 Snapshot、点击、普通文本输入、滚动与文本提取；Work 消息链接复用同会话 Browser，不向 Renderer 暴露任意 CDP/selector/脚本 |

#### 集成服务

| 服务 | 职责 |
|------|------|
| `feishu-bridge.ts` | 飞书集成（68KB）：消息同步、任务通知、OAuth 认证 |

#### 工具与文件

| 服务 | 职责 |
|------|------|
| `chat-tools/` | Chat 工具实现目录：内置工具函数 |
| `workspace-watcher.ts` | 项目根目录、会话文件与附加目录监听：文件系统变化监控 |
| `chat-tools-watcher.ts` | Chat 工具监听：工具配置变化监控 |
| `attachment-service.ts` | 附件管理：存储/读取/删除、文件对话框 |
| `document-parser.ts` | 文档解析：PDF/Office/文本文件提取 |

#### 系统服务

| 服务 | 职责 |
|------|------|
| `runtime-init.ts` | 运行时初始化：Shell 环境、Bun、Git 检测（`bun-finder.ts`、`git-detector.ts`、`shell-env.ts`） |
| `config-paths.ts` | 配置路径管理：正式版 `~/.domi/`、开发版 `~/.domi-dev/` |
| `user-profile-service.ts` | 用户档案持久化 |
| `settings-service.ts` | 应用设置持久化（主题等） |

Domi 的自动更新主进程 wiring 与设置 UI 已移除或不可达，不得恢复 Proma 官方更新通道。`AboutSettings` 只说明版本、环境和源码或外部二进制构建的手动更新方式。

### AI Provider 适配器（`packages/core/src/providers/`）

基于适配器模式的多 Provider 支持，通过注册表统一管理：

#### 核心架构
- `ProviderAdapter` 接口：定义统一的 `sendMessage()` 流式方法
- `provider-registry.ts`：Provider 注册表，按 `providerId` 查找适配器
- `sse-reader.ts`：通用 SSE 流读取器（fetch + ReadableStream）

#### 支持的 Provider

| Provider | 适配器 | API 协议 | 特性 |
|----------|--------|----------|------|
| **Anthropic** | `anthropic-adapter.ts` | Messages API | extended_thinking、多模态 |
| **OpenAI** | `openai-adapter.ts` | Chat Completions | 标准 OpenAI 协议 |
| **DeepSeek** | `anthropic-adapter.ts` | Messages API | Anthropic 兼容 |
| **智谱 AI** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **MiniMax** | `anthropic-adapter.ts` | Messages API | Anthropic 兼容 |
| **豆包** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **通义千问** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **Google** | `google-adapter.ts` | Generative Language API | Gemini 系列 |
| **Custom** | `openai-adapter.ts` | Chat Completions | 自定义 OpenAI 兼容端点 |

#### 多模态支持
- **图片**：各 Provider 格式不同，适配器自动转换
- **文档**：提取文本后注入 `<file>` XML 标签

### Jotai 状态管理（`renderer/atoms/`）

| Atom 文件 | 管理的状态 |
|-----------|-----------|
| `chat-atoms.ts` | 对话列表、当前消息、流式状态（Map 结构支持多对话并行）、模型选择、上下文设置、并排模式、思考模式、待上传附件 |
| `agent-atoms.ts` | Agent 会话列表、当前会话、流式状态（`AgentStreamState`）、工作区选择、渠道选择、权限/AskUser 请求队列，以及按 sessionId 隔离的原生 steering / follow-up 队列镜像 |
| `active-view.ts` | 主面板视图切换（'conversations' / 'settings'） |
| `app-mode.ts` | 应用模式（Chat / Work；内部值仍为 `agent`） |
| `settings-tab.ts` | 设置面板当前标签页 |
| `theme.ts` | 主题模式（light / dark / system） |
| `user-profile.ts` | 用户档案（姓名 + 头像） |
Domi 没有 updater atom；不要新增或恢复指向 Proma 官方更新通道的更新状态。

### 渲染进程组件架构（`renderer/components/`）

- **`app-shell/`**：三面板布局（左侧导航 | 中间主任务 | Right Workspace）；左侧负责项目/会话导航，右侧以顶部工具带统一承载文件、改动、Browser、动态 Preview 与辅助问答，文件 Preview 和 Browser 不再进入 MainArea 分屏
- **`chat/`**：聊天核心 — ChatView（消息加载/流式订阅）、ChatHeader（模型选择/上下文设置）、ChatInput（Tiptap 富文本编辑器）、ChatMessages（消息列表/自动滚动）、ParallelChatMessages（并排模式）
- **`agent/`**：Work 模式 — AgentView（纯展示 + 交互，IPC 监听已提升到全局）、AgentHeader（渠道/模型选择）、AgentMessages（消息列表 + 工具活动）、ToolActivityItem（工具调用展示）、WorkspaceSelector（工作区切换）、PermissionBanner/AskUserBanner（权限/问答请求 UI）
- **`settings/`**：设置面板 — GeneralSettings（用户档案）、AppearanceSettings（主题）、ChannelSettings（渠道管理）、ChannelForm（Provider 配置）、AgentSettings（Agent 渠道/工作区/MCP）、McpServerForm（MCP 服务器配置）、AboutSettings（版本、环境与手动更新说明）、FeishuSettings（飞书集成）；含 `primitives/` 可复用表单组件
- **`right-workspace/`**：右侧工作区 — RightWorkspaceToolbar（未选中时显示紧凑图标，活动工具平滑展开名称，窄宽度收纳到“更多”菜单）、RightWorkspaceHeader（上下文标题、文件来源、草稿聚焦与动态关闭）；整区折叠入口固定在 MainArea 右上角，按 Work Session 隔离活动工具和 Preview 返回目标，草稿正文继续全局持久化，Browser 切换仅隐藏原生 View，显式关闭才释放 Session
- **`file-browser/`**：文件浏览器 — FileBrowser（会话文件与项目根目录文件树浏览）
- **`terminal/`**：底部内置终端 — xterm Dock、多终端 Tab、用户 Shell 与 Agent Run 状态展示；文件树/改动目录可按授权 cwd 打开，完成的 Agent Tab 仅在同 Session/Target revision/cwd/profile 下复用；Main/utility process 持有 PTY
- **`ai-elements/`**：AI 展示组件 — Markdown 渲染、代码块、Mermaid 图、推理折叠、上下文分割线、富文本输入
- **`ui/`**：Radix UI 组件（现代化设计，CSS 变量主题）

### 全局 Hooks（`renderer/hooks/`）

| Hook | 职责 |
|------|------|
| `useGlobalAgentListeners` | 全局 Agent IPC 监听器，在 `main.tsx` 顶层挂载，使用 `useStore()` 直接操作 atoms。处理流式事件、完成/错误、标题更新、权限请求、AskUser 请求，永不随组件卸载销毁 |
| `useBackgroundTasks` | 后台任务管理（Agent/Shell 任务的增删改查），按 sessionId 隔离 |

### 渲染进程初始化组件（`renderer/main.tsx`）

| 组件 | 职责 |
|------|------|
| `ThemeInitializer` | 从主进程加载主题设置、监听系统主题变化、同步到 DOM |
| `AgentSettingsInitializer` | 加载 Agent 渠道/模型/工作区设置、订阅 MCP/文件变化事件 |
| `AgentListenersInitializer` | 挂载 `useGlobalAgentListeners`，全局 Agent IPC 监听 |

Domi 没有 `UpdaterInitializer`，主进程也不初始化 Proma updater。

### 本地文件存储（正式版 `~/.domi/`，开发版 `~/.domi-dev/`）

```
~/.domi/
├── channels.json           # 渠道配置（API Key 经 safeStorage 加密）
├── conversations.json      # 对话索引（元数据，轻量）
├── conversations/          # 消息存储
│   └── {uuid}.jsonl        # 每对话一个 JSONL 文件，追加写入
├── agent-sessions.json     # Agent 会话索引
├── agent-sessions/         # Agent 会话消息存储
│   └── {uuid}.jsonl        # 每会话一个 JSONL 文件
├── agent-workspaces/       # Agent 工作区目录
│   └── {workspace-slug}/
│       ├── {session-id}/   # 会话工作目录
│       ├── workspace-files/# 仅空白项目使用的 Domi 托管项目根
│       ├── mcp.json        # MCP Server 配置
│       └── skills/         # Skills 配置目录
├── attachments/            # 附件文件
│   └── {conversationId}/
│       └── {uuid}.ext
├── user-profile.json       # 用户档案 { userName, avatar }
├── settings.json           # 应用设置 { themeMode }
├── planning.db             # 任务与日程 SQLite 数据库
└── sdk-config/             # Agent SDK 配置目录
    └── projects/           # SDK 项目配置
```

**关键设计**：
- 会话与配置以 JSON + JSONL 为主；规划模块使用本地 `planning.db` SQLite，数据仍位于 Domi 配置根
- Agent 工作区按 slug 隔离，每个会话独立目录
- MCP 配置和 Skills 默认按工作区管理；用户显式开启后，Pi 可只读继承外部用户级 Skills 与 `~/.pi/agent/mcp.json` 顶层服务器，工作区同名配置优先

## 构建工具

- **主进程/Preload**：esbuild；主进程将 Electron 与 Pi runtime 包标记为 external，Preload 仅 external Electron
- **渲染进程**：Vite + React 插件 + Tailwind CSS + HMR
- **开发热重载**：渲染进程 Vite HMR 即时生效；主进程/Preload 通过 electronmon 监听 dist 文件变化自动重启
- **打包分发**：electron-builder（配置见 `electron-builder.yml`）

### 重要：打包配置注意事项

**Agent Runtime 打包要求（必须遵守）：**

- `apps/electron/package.json` 的 `build:main` / `watch:main` 必须 external：`electron`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`。
- electron-builder 前必须运行 `bun run sync:runtime-deps`；`scripts/sync-runtime-deps.ts` 会把 Pi external 依赖的生产闭包同步到 `apps/electron/node_modules/`。
- `electron-builder.yml` 通过 `node_modules/**/*` 收集同步后的运行时闭包，再排除 Electron、builder、esbuild、文档、示例和 sourcemap 等构建期内容；内部 `@domi/*` 已被 bundle，不随 node_modules 重复打包。
- Domi CLI 由 `build:cli` 编译到 `resources/bin/`，默认 Skills 从 `default-skills/` 作为 `extraResources` 打包。修改这些路径时必须同时验证打包后的资源定位。
- Domi 不配置 Proma 官方 `publish` provider。Windows 必过 CI 需要完成 build、runtime dependency sync、未签名打包，并实际启动 `out/win-unpacked/Domi.exe` 做 smoke。
- 首个二进制发布范围为 Windows x64 NSIS、Linux x64 AppImage/deb；macOS 在具备真实 Mac 构建、签名、notarization 和安装验证环境前不上传预构建包。Release workflow 只能创建 Draft Release，不得自动公开；稳定版本核验后公开为正式 Release，只有 alpha、beta、rc 或明确测试版本才标记为 Pre-release。

**修改打包配置时的检查清单：**

1. 确认 esbuild external 列表与 `sync-runtime-deps.ts` 的 runtime roots 一致。
2. 运行 `bun run electron:build` 和 `bun run --cwd apps/electron sync:runtime-deps`。
3. 检查同步后的 Pi runtime 依赖存在，安装树无 `claude-agent-sdk*` / `claude.exe`，且 `@domi/*` workspace symlink 不进入安装包。
4. Windows 运行 electron-builder 后启动 `out/win-unpacked/Domi.exe`；macOS/Linux 按平台分级验证。
5. 不添加自动发布、自动安装或 Proma 官方更新通道。

## 代码风格

- 永远不要使用 `any` 类型 — 创建合适的 interface
- 对象类型优先使用 interface 而不是 type
- 尽可能使用 `import type` 进行仅类型导入
- 注释和日志采用中文，保留专业术语
- **路径别名**：`@/` → `apps/electron/src/renderer/`

## TypeScript 配置

- Module: `"Preserve"` + `"moduleResolution": "bundler"`
- JSX: `"react-jsx"`，严格模式启用，Target: ESNext
- 所有包 `"type": "module"`，导入时使用 `.ts` 扩展名

## 版本管理

提交代码时始终递增受影响包的 patch 版本（如 `0.1.18` → `0.1.19`），影响多个包则都要递增。引入或更新第三方代码、默认 Skill、字体、图标、模板、原生二进制或补丁时，必须同步核对许可证并更新根目录 `THIRD_PARTY_NOTICES.md`。

### 默认 Skills 版本契约（`apps/electron/default-skills/`）

修改任何 `default-skills/<skill>/` 内容时，**必须同步递增该 Skill `SKILL.md` frontmatter 的 `version` 字段**（patch +1）。

**为什么**：`seedDefaultSkills()` 与 `upgradeDefaultSkillsInWorkspaces()` 通过 semver 比较决定是否将 bundle 中的 Skill 同步到老用户的 `~/.domi/default-skills/` 与 `~/.domi/agent-workspaces/<slug>/skills/`。**version 不变 = 老用户拿不到新内容**。默认 Skill 不得指导 Agent 直接读写 `~/.proma/`；旧 Proma 数据只能通过显式迁移流程导入。

**早期实现曾用"无条件 cpSync"绕开这个约束**，但每次启动同步 4MB+ 文件会阻塞主进程导致启动卡顿，已恢复为 semver 比较（见 `config-paths.ts:seedDefaultSkills`、`agent-workspace-manager.ts:upgradeDefaultSkillsInWorkspaces`）。

**新增 Skill 不需要先注入 default-skills 目录的旧版本**——`upgradeDefaultSkillsInWorkspaces` 会通过"目标缺失即注入"路径让所有老工作区自动获得。

## Agent SDK 集成架构

Pi 是 Domi 唯一的 Agent Runtime。Anthropic / Claude 模型仍通过 Provider 层使用；Domi 管理的主指令文件为 `AGENTS.md`，`.claude/memory` 继续作为可读写 Auto Memory，旧 `CLAUDE.md` 仅作为安全迁移与兼容输入，外部 `~/.claude/skills` 只读接入，但不再存在 Claude Agent SDK 执行路径。

### 核心流程

```text
用户输入 → agent-orchestrator.ts
  ↓
pi-agent-adapter.ts
  ↓
SDK 原始消息 → SDKMessage / AgentEvent
  ↓
webContents.send() → useGlobalAgentListeners → Jotai atoms
  ↓
React UI 更新与 JSONL 持久化
```

### 关键组件

- `agent-orchestrator.ts`：会话编排、渠道和凭据、环境、并发、重试及事件持久化；巨型高冲突文件只组装 run context 和 wiring。
- `pi-execution-controller.ts` / `execution-policy/`：Workflow + Execution Policy 组合、Workspace Boundary、Local Baseline、Shell/Git/Process Network 分类和单次审批。
- `adapters/pi-final-tool-guard.ts`：Pi built-in、产品工具、MCP 与 Trusted Extension 的 session-level 最终授权 seam。
- `adapters/pi-extension-trust.ts` / `pi-extension-resource-loader.ts`：按项目 canonical path + SHA-256 授权，在模块求值前 fail closed。
- `managed-web-access/` / `audit/`：公开 Web 目标、secret、redirect 策略与脱敏 JSONL 审计。
- `adapters/pi-agent-adapter.ts`：唯一 Runtime adapter，桥接 Domi 渠道、Skills、MCP、工具和流式/审计事件。
- `adapters/pi-mcp-tools.ts` / `adapters/pi-builtin-tools.ts`：将用户 MCP 与 Domi 产品能力转换为 Pi custom tools。
- `agent-prompt-builder.ts`：构建 Domi 工作区、Context、Execution Controls、知识维护和协作提示词。
- `agent-permission-service.ts`：承载单次审批 UI 适配。

### 关键约束

- Domi 默认不依赖 Pi 或 Claude Code 的全局用户配置，并继续使用自己的配置根和会话 sidecar。唯一例外是用户显式开启的只读全局能力：Skills 可从 `~/.pi/agent/skills`、`~/.agents/skills`、`~/.claude/skills` 发现；MCP 只读取 `~/.pi/agent/mcp.json` 顶层 `mcpServers`，不跟随 `imports`、不加载外部 packages/extensions。
- Pi external runtime 依赖版本以 `apps/electron/package.json` 为准，升级时必须同时验证 adapter、sync-runtime-deps、打包和 Windows smoke。
- Pi `0.84.4` 原生负责工具结果后的 pre-turn 压缩生命周期、Session 更新、同一 Agent loop 续跑和失败事件；Domi patch 继续负责增强 checkpoint、单次物理摘要请求、最终 Provider Context 投影与精确 token 门禁、最多两次安全尝试和超限 fail-closed。不得恢复 threshold hidden continuation 或双重摘要请求来绕开原生生命周期。
- 不得重新引入 runtime selector、Claude adapter/router、Claude MCP wrapper 或平台 `claude.exe` 依赖。
- Anthropic Provider、Claude 模型/logo、Domi 管理的可写 `AGENTS.md` / Memory、legacy `CLAUDE.md` 兼容输入，以及外部 Claude Skills 只读来源，都必须与 Runtime 删除相互独立。
- 执行模式始终使用当前 Windows 用户权限并明确提示未 OS-sandbox；研究、执行、本次执行和 Plan 生命周期只改变 Workflow/当前 run lease，不能绕过 Isolated→Local 回写/维修/交付事务、target ownership、managed Worktree/workbench integrity、产品确认事务或 Extension Trust。敏感路径名、opaque/parser failure、动态删除、Local Baseline、destructive Git、外部影响、网络和解释器等通用风险在执行模式中用于审计和宿主结构边界，不恢复旧的普通 Policy 审批档位。
- 所有 Shell 判断必须消费同一份 Canonical Shell Analysis；Bash 与 PowerShell 必须使用各自语法解析器，严禁把 PowerShell source 送入 Bash AST。下游不得把已证明为 argv 字面量的文本重新解释为 executable。研究模式只能放行可证明无副作用的命令；执行模式中解析结果用于审计和宿主结构边界，解析失败不得转化为旧式权限档位或编造具体 Git 风险类别。PowerShell 变量求值只能在宿主提供的 managed root 内用于研究模式的安全正向判断。
- Research / Plan First 的 Bash 只读白名单可支持有限的 stdout-only 管道，包括 `curl GET | tar --to-stdout | grep` 上游产物检查；stdout 解包只允许从 stdin 读取归档并显式选择成员，执行前清空 `TAR_OPTIONS`，不得放开落盘解压、外部解压程序、文件列表输入或命令 hook。
- `ExecutionPolicy` 是唯一授权分类 owner，并通过 `allow / require-approval / deny` 强类型 resolution 输出决定；`AgentPermissionService` 及 UI 只负责审批交互和宿主事务，不得恢复 session command whitelist、raw-string classifier 或 allow-always 权限提升。
- Workspace Boundary、Managed Web 和 Extension Trust 是宿主策略，不是 OS/网络沙箱；DNS rebinding check/use 间隙必须在用户文档中如实保留。
- Pi Extension trust 不继承项目、Skill 或 MCP 信任；renderer 不得提交任意路径直接授权。
- `@domi/*` 是 Domi 的 canonical workspace package identity；`DomiPermissionMode`、`DomiEvent` 等 Domi 自有类型使用当前产品命名。只有 `SDKMessage`、`sdkSessionId` 和显式旧数据导入字段等真实持久化/协议兼容名可以保留历史命名。

### 共享类型（`@domi/shared`）

- `AgentEvent`：Agent 事件（text / tool_start / tool_result / done / error）
- `AgentSessionMeta`：会话元数据（id / title / channelId / workspaceId）
- `AgentMessage`：持久化消息（role + content blocks）
- `AgentSendInput`：发送请求输入
- `AGENT_IPC_CHANNELS`：Agent 相关 IPC 通道常量
- `WorkspaceCapabilities`：工作区能力（MCP Server 列表 + Skills 列表）

## 创作参考

遵循 [craft-agents-oss](https://github.com/craftship/craft-agents-oss) 的模式：

- **会话管理**：收件箱/归档工作流
- **权限模式**：由 Domi 宿主统一表达和持久化，不直接照搬底层 SDK 的命名
- **Agent SDK**：Pi 是唯一 Agent Runtime；版本与文档入口以 `apps/electron/package.json` 和所安装包为准
- **MCP 集成**：Model Context Protocol 用于外部数据源
- **凭证存储**：AES-256-GCM 加密
- **配置位置**：正式版 `~/.domi/`、开发版 `~/.domi-dev/`（类似 `~/.craft-agent/`）

## 核心特性

### 已实现功能

- ✅ **多 Provider 支持**：Anthropic、OpenAI、DeepSeek、Kimi、智谱、MiniMax、豆包、通义千问、Google、自定义端点
- ✅ **Agent SDK 集成**：Pi-only Runtime，保留 Anthropic / Claude 模型 Provider
- ✅ **飞书集成**：消息同步、任务通知、OAuth 认证（68KB 核心服务）
- ✅ **工作区管理**：多工作区隔离、MCP Server 配置、Skills 管理
- ✅ **Work 工作方式**：研究 / 执行两档持久模式、本次执行 run lease 与 Plan 生命周期；底层统一当前用户权限，关键宿主事务保持独立确认
- ✅ **宿主安全门禁**：Canonical Shell Analysis、Workspace Boundary、Local Baseline、owner Isolated target provenance、Local 写回事务、Managed Web secret/私网防护
- ✅ **跨项目会话交接**：未绑定 Target 的草稿可迁移项目；已执行会话统一通过“交接到新会话”选择当前或其他项目，由来源模型基于持久化证据生成可复制 handoff，并在目标 Local / 新 Isolated Worktree 创建继任会话，绝不改写来源项目与 Checkout 绑定
- ✅ **Pi Extension Trust**：按项目 canonical path + SHA-256 显式授权、变化失效与撤销
- ✅ **本地审计**：策略、Managed Web 和 Pi run timing 脱敏写入 JSONL
- ✅ **手动更新说明**：About 页面说明源码或外部二进制构建的手动更新方式；自动更新 intentionally disabled
- ✅ **代理支持**：系统代理检测与配置
- ✅ **文档解析**：PDF、Office、文本文件提取
- ✅ **内置终端基础**：用户 Shell、目录 cwd 入口与经 Execution Policy 的 Agent 可见长任务终端；用户终端不向 Agent 暴露，Agent Tab 复用受 Session Target 与 shell/cwd 不变量约束
- ✅ **多模态支持**：图片、文档附件
- ✅ **Chat 工具**：内置工具系统 + 动态加载
- ✅ **内置浏览器 Host 与原子操作**：用户可见的 `WebContentsView`、Work 消息链接路由、项目/临时 Profile 隔离、公开网络与严格 loopback URL/权限边界、聚焦模式、紧凑工具栏、缩放与可选适应宽度，以及固定 isolated-world 的单元素选择和 Main-only 有界 Snapshot/ref、点击、普通文本输入、滚动与文本提取；网页元素引用不采集表单值、不保存 selector / XPath，外部交互需要当前 run 的宿主确认并写入脱敏审计

### 架构亮点

- **并发守卫**：同一会话防止并行请求冲突
- **全局监听**：Agent IPC 监听器永不销毁，确保后台会话不丢失
- **权限排队**：按 sessionId 隔离权限请求，支持多会话并行
- **文件监听**：项目根目录、会话文件、附加目录、MCP 配置与 Chat 工具实时监控
- **事件流处理**：SDK 消息流式转换与累积
- **错误映射**：SDK 错误统一转换为应用错误
