# AGENTS.md

本文件为在本仓库工作的 AI Agent 提供项目指令与约束。

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

Domi 是 Personal Coding Workbench，采用 Electron 桌面应用架构，使用独立安装身份、本地数据目录、`@domi/*` workspace package 和 `DOMI_*` 活动环境变量。

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
  - `@earendil-works/pi-coding-agent@0.85.1` - 默认 Agent Runtime
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

选型约束（版本一律以各 package.json 为准，不在此维护副本）：

- 运行时 Bun、语言 TypeScript 严格模式、桌面 Electron、前端 React 18 + Tailwind + Radix UI、状态管理 Jotai、构建 Vite + esbuild、分发 electron-builder。
- Agent SDK 统一 `@earendil-works/pi-*`，版本与 external 打包要求见「打包配置注意事项」。
- 富文本 TipTap、图表 Mermaid、公式 KaTeX、代码高亮 Shiki。

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
| `agent-orchestrator.ts` | Agent 核心编排层：并发守卫、渠道查找、环境变量构建、SDK 路径解析、消息持久化、事件流处理、错误处理、自动标题生成 |
| `agent-session-manager.ts` | Agent 会话管理：SDK 消息持久化、会话元数据 CRUD、JSONL 存储 |
| `agent-prompt-builder.ts` | Agent 系统提示词构建：动态上下文构建、内置 Agent 构建、工作区上下文注入 |
| `agent-permission-service.ts` | Agent 权限管理：工具权限检查、权限模式管理 |
| `agent-ask-user-service.ts` | Agent 用户交互：AskUser 请求处理 |
| `agent-exit-plan-service.ts` | Agent 退出计划服务 |
| `agent-workspace-manager.ts` | 工作区管理：MCP Server 配置、Skills 配置、工作区 CRUD |
| `chat-service.ts` | Chat 流式调用编排：Provider 适配器集成、消息持久化、AbortController |
| `conversation-manager.ts` | 对话管理：对话 CRUD、JSONL 消息存储、置顶、上下文分割 |
| `channel-manager.ts` | 渠道管理：渠道 CRUD、API Key AES-256-GCM 加密（safeStorage）、连接测试、模型获取 |
| `browser/` | Main-owned `WebContentsView` Browser Session、Profile/URL/权限策略、公开网络与严格 loopback 地址、缩放/适应宽度，以及基于短生命周期 ref 的有界 Snapshot、点击、普通文本输入、滚动与文本提取；Work 消息链接复用同会话 Browser，不向 Renderer 暴露任意 CDP/selector/脚本 |

#### 集成服务

| 服务 | 职责 |
|------|------|
| `feishu-bridge.ts` | 飞书集成：消息同步、任务通知、OAuth 认证 |

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

Domi 的 `AboutSettings` 只说明版本、环境和源码或外部二进制构建的手动更新方式。

### AI Provider 适配器（`packages/core/src/providers/`）

- 架构：`ProviderAdapter` 统一 `sendMessage()` 流式接口、`provider-registry.ts` 按 `providerId` 查找、`sse-reader.ts` 通用 SSE 读取器。
- 新增 Provider 优先复用 Anthropic / OpenAI 兼容适配器；具体 Provider 映射以注册表为准，不在此维护副本。
- 多模态：图片各 Provider 格式由适配器转换；文档提取文本后注入 `<file>` XML 标签。

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

### 渲染进程组件架构（`renderer/components/`）

- **`app-shell/`**：三面板布局（左侧导航 | 中间主任务 | Right Workspace）；右侧以顶部工具带承载文件、改动、Browser、动态 Preview 与辅助问答，文件 Preview 和 Browser 不进入 MainArea 分屏
- **`chat/`**：聊天核心 — ChatView、ChatHeader、ChatInput（Tiptap）、ChatMessages、ParallelChatMessages（并排模式，Map 结构支持多对话并行）
- **`agent/`**：Work 模式 — AgentView 只做展示与交互（IPC 监听在全局 hooks）、AgentHeader、AgentMessages、ToolActivityItem、WorkspaceSelector、PermissionBanner/AskUserBanner；输入框上方的 Worktree 验收状态条提供预览/保存/撤回/恢复验收版本/下一轮；owner 活跃 Worktree 的固定验收版本可确认恢复，先保存后续成果，只恢复项目可交付文件，不恢复项目外操作及运行配置；已保留成果可确认“恢复后续成果”，同样先保存当前成果；已应用版本保留的后续成果可在用户显式确认后恢复，并基于已应用版本继续下一轮；恢复失败仍可重试；下一轮须经确认弹窗；验收正文只在消息区显示，详情弹窗不重复正文或建议提交信息
- **`settings/`**：GeneralSettings、AppearanceSettings、ChannelSettings、ChannelForm、AgentSettings、McpServerForm、AboutSettings、FeishuSettings；含 `primitives/` 可复用表单组件
- **`right-workspace/`**：右侧工作区；整区折叠入口固定在 MainArea 右上角，按 Work Session 隔离活动工具和 Preview 返回目标，草稿正文全局持久化，Browser 切换仅隐藏原生 View，显式关闭才释放 Session；`interfaceVariant: workbench-v2` 只切换右侧标签、终端和浏览器呈现，左侧导航沿用现代界面，底层 Jotai Session/Browser/Terminal 状态及 Main 所有权不切换
- **`file-browser/`**：文件浏览器（会话文件与项目根目录文件树）
- **`terminal/`**：底部内置终端；文件树/改动目录可按授权 cwd 打开，完成的 Agent Tab 仅在同 Session/Target revision/cwd/profile 下复用；Main/utility process 持有 PTY。`terminal/v2/` 是 ZCode 终端的第一方移植（固定来源 zai-org/ZCode@29628c9，Apache-2.0），以其为主体持续对齐上游，不做脱离上游的自研迭代；PTY 仍由 Domi Main/utility 持有，owner/session/target 边界不变；v1 TerminalDock 保留为回退。
- **`ai-elements/`**：AI 展示组件 — Markdown 渲染、代码块、Mermaid 图、推理折叠、上下文分割线、富文本输入
- **`ui/`**：Radix UI 组件（CSS 变量主题）

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

### Worktree 本地配置准备

- 项目菜单「Worktree 本地配置」使用项目内文件树维护原项目 `.worktreeinclude`；显示隐藏文件，支持搜索、跨目录多选和文件夹批量选择。目录选择展开为当时的具体文件，保存前可逐项取消；清单仍只接受明确相对文件路径及注释，不接受 glob、目录条目或链接，后来新增文件不自动批准。清单不是授权，Main 使用独立本机批准（项目 ID、canonical 根及目录身份）准备普通未受控文件，不能扩大 Agent Local 权限。
- `worktree-local-files/selection.ts` 只枚举元数据；Main 解析项目根，拒绝越界，不遍历链接、受保护目录或嵌套仓库，复核父级/目录身份。按需目录最多1000条、递归扫描最多5000条/32层/8秒；选择仍限100文件、单文件4MiB、总计32MiB，超限整次失败而非截断。浏览/搜索不批准；刷新文件树保留草稿，项目/清单快照及搜索变化使旧结果失效。
- `main/lib/worktree-local-files/` 负责校验、批准和独立副本复制；创建 ready 前准备，已有 Worktree 补复制走 checkout 独占队列、owner/空闲/revision 校验，覆盖需目标指纹确认，不持续同步或回写。
- registry 准备凭证是运行配置排除事实源；`session-checkout/runtime-files.ts` 与公共快照在 Git 对象写入前排除配置，也覆盖文件回退、产物列表及 `.domi-local-{UUID}.{tmp,previous}` 异常残留；移除条目不取消已有副本排除，配置变化仍使旧交付计划过期。配置已在 HEAD/index 时 fail closed，不改真实 index 或共享 exclude。
- 回归：`bun test --max-concurrency=4 ./apps/electron/src/main/lib/worktree-local-files/ ./apps/electron/src/main/lib/session-checkout/ ./apps/electron/src/main/ipc/register-worktree-local-files-ipc.test.ts ./apps/electron/src/renderer/atoms/worktree-local-files-atoms.test.ts ./apps/electron/src/renderer/components/agent/worktree-local-files/`。不承诺阻止任意 Shell/手工 Git 的凭据泄漏。

### 数据迁移约束

- 备份包括会话记录与索引、会话工作目录中的文档/图片/.context/产物、Domi `attachments/{sessionId}` 附件、所选 Skills 和配置。仅在会话目录排除明确的依赖、Git 元数据与工具缓存，不按 dist/build/out 名称丢弃交付产物；跳过会话符号链接并返回警告，不跟随外部项目。会话文件和附件随所选会话迁移，导入补齐缺失文件且不覆盖本机同名文件；workspace-data 格式兼容旧包。

- v1/v2 备份导入均须逐项目显式选择新建、合并或跳过，不按源项目 slug、同名项目或本机首个项目自动绑定，不推断跨机器路径。
- 新建项目仅使用用户在当前电脑手动选择的 `projectRootPath`；未选目录时创建 Domi 托管空白项目。合并必须显式指定本机项目，沿用其根目录，不借导入重新绑定已有项目。
- 附加目录和文件默认不关联，只应用用户显式提交的路径映射。导入前完成项目名称、根目录和附加路径校验；校验失败保留预览，允许修正后重试。
- 多项目会话索引、消息和会话工作文件按各自目标项目归属导入；跳过的项目不得回落到其他项目。判断会话工作目录是否已存在时使用纯路径拼接，不能调用会自动创建目录的 getter 后再判断。
- 项目代码由用户在目标电脑准备；平台专用 MCP/Skills 命令、可执行文件和绝对路径由用户调整，不自动转换或安装依赖。
- 导出的大批量文件读取、目录遍历、ZIP 压缩和写出使用异步流程，写出失败必须返回错误，不能让界面一直等待。
- 回归：`bun test ./apps/electron/src/main/lib/migration-export.test.ts ./apps/electron/src/main/lib/migration-boundary.test.ts ./apps/electron/src/main/lib/chat-tools/chat-tool-migration.test.ts ./apps/electron/src/renderer/lib/migration-path-mappings.test.ts`。

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
- Windows CI 快车道每次 push 完成 typecheck、M0 测试、build、runtime dependency sync、未签名打包并实际启动 `out/win-unpacked/Domi.exe` 做 smoke；全量测试基线由每日 schedule 或手动 workflow_dispatch 运行，不阻塞发布节奏。
- 二进制发布范围为 Windows x64 NSIS、Linux x64 AppImage/deb、macOS arm64 未签名（ad-hoc）DMG；macOS 包无 notarization，用户首次打开需右键「打开」，x64 与正式签名待证书与验证环境就绪后补。Release workflow 只能创建 Draft Release，不得自动公开；稳定版本核验后公开为正式 Release，只有 alpha、beta、rc 或明确测试版本才标记为 Pre-release。Release Notes 使用中英双版（先完整中文、分隔线后完整 English），只描述 Domi 自身能力，不引用其他产品名称作为风格或出处。

**修改打包配置时的检查清单：**

1. 确认 esbuild external 列表与 `sync-runtime-deps.ts` 的 runtime roots 一致。
2. 运行 `bun run electron:build` 和 `bun run --cwd apps/electron sync:runtime-deps`。
3. 检查同步后的 Pi runtime 依赖存在，安装树无 `claude-agent-sdk*` / `claude.exe`，且 `@domi/*` workspace symlink 不进入安装包。
4. Windows 运行 electron-builder 后启动 `out/win-unpacked/Domi.exe`；macOS/Linux 按平台分级验证。
5. 不添加自动发布与自动安装通道。

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

版本按变更语义定级，以一次交付或发布为单位统一递增，不因中间提交、checkpoint 或验收后的修正重复加号。同一交付包含多类变更时，按最高影响级别确定目标版本；范围扩大时重新定级，而非在已递增版本上连续加号。

- Bug 修复、小幅优化及不改变功能语义的调整：patch +1。
- 新增用户可见功能或实质性功能增强：minor +1，patch 归零。
- 当前 `0.x` 阶段的不兼容变更：minor +1，并说明兼容性与迁移影响；进入 `1.0.0` 必须基于明确的产品稳定性与兼容性契约决策，不按提交数量自动触发。`1.x` 及以后不兼容变更升 major，minor 与 patch 归零。
- 纯文档、测试或不影响产物的维护：不递增应用版本。
- 根 `package.json` 与 `apps/electron/package.json` 的应用版本必须一致；内部包按自身变更影响定级，不要求无关包跟随应用升版。
- 默认 Skills 仍遵守下方独立版本契约，不因应用版本未变而省略 Skill 升版。

详细示例见 `docs/releasing.md`。引入或更新第三方代码、默认 Skill、字体、图标、模板、原生二进制或补丁时，必须同步核对许可证并更新根目录 `THIRD_PARTY_NOTICES.md`。

### 默认 Skills 版本契约（`apps/electron/default-skills/`）

修改任何 `default-skills/<skill>/` 内容时，**必须同步递增该 Skill `SKILL.md` frontmatter 的 `version` 字段**（patch +1）。

**为什么**：`seedDefaultSkills()` 与 `upgradeDefaultSkillsInWorkspaces()` 通过 semver 比较决定是否将 bundle 中的 Skill 同步到老用户的 `~/.domi/default-skills/` 与 `~/.domi/agent-workspaces/<slug>/skills/`。**version 不变 = 老用户拿不到新内容**。

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
- `side-chat/`：Work 右侧持久侧聊（ZCode 式 fork 模型），同一父会话可多开独立 Pi 子会话（右侧工作区标签条实例 tab `side-chat:{childId}`，入口只在主会话：划选/`/side`/`/btw`，侧聊内不可再开）。创建时用 Pi 原生 branch/fork 继承父会话完整 transcript，再追加一条 UI 隐藏、模型可见的边界指令（继承历史仅供参考，不继续父任务）；fork 失败一律降级为空白子会话，不阻断入口。fork 只服务模型上下文，展示 JSONL 不复制父历史，时间线只含侧聊自己的消息。`sideChatParentSessionId` 为宿主持久用途，普通导航/内容搜索按此用途隐藏子会话但保留全局 runtime 元数据与历史。侧聊是完整会话：正常系统提示词 + 边界附录、完整工具经普通权限审批（面板内 PermissionBanner/AskUserBanner 直接处理）、继承项目指令/Skills/MCP；启动仍必须经过侧聊服务和绑定本轮输入的宿主许可。时间线复用 AgentMessages 全量渲染；输入区复用主消息区同款 RichTextInput + InputToolbarOverflow；草稿与图片按子会话隔离，图片选择/粘贴复用主输入附件读取与预览，Main 校验后以附件引用和 Read 图像结果输入 Pi。主对话划选文本以多引用（最多 8 条、单条 8000、总量 16000、去重）进入下一次发送，序列化复用 `<quoted_context>` 合同并在时间线解析回 chip。收起不取消，停止不删历史，重启不自动续跑；显式「交给主助手」经过原发送/follow-up及审批边界。旧右侧问答仍为 Chat 历史，不与侧聊 Agent ID 混用；旧 `independentReviewId` 仅作兼容识别。回归：`bun test ./apps/electron/src/main/lib/side-chat/ ./apps/electron/src/renderer/components/agent/side-chat/ ./apps/electron/src/renderer/lib/side-chat-selections.test.ts`。
- `pi-execution-controller.ts` / `execution-policy/`：Workflow + Execution Policy 组合、Workspace Boundary、Local Baseline、Shell/Git/Process Network 分类和单次审批。
- `adapters/pi-final-tool-guard.ts`：Pi built-in、产品工具、MCP 与 Trusted Extension 的 session-level 最终授权 seam。
- `rtk/` / `adapters/pi-rtk-output.ts`：默认关闭的 RTK 输出后处理；仅执行 Workflow 下对已确认成功且未截断的有限 Bash 文本运行固定 `pipe --filter`；Bun 无原生 filter，由 Domi 对完整成功测试报告核对计数后仅省略 pass 明细，typecheck 脚本仅省略已知 tsc 回显。原命令、权限与退出码不变。内置 RTK 0.48.0（rtk-manifest.json 固定官方归档/二进制 SHA-256，prepare:rtk 与 beforePack 按目标平台准备）；研究/Plan、WSL、失败/复杂命令和终端不优化。不依赖系统 PATH、不在用户运行时下载、不重写命令、不继承用户 filter/遥测配置，原文写会话工作台 `rtk-output/`（最多 256 份，不自动删除引用），不设最小 1 KiB 门槛，按实际引用路径成本选择净收益；统计仅本次进程估算并区分未支持、无收益、失败及不适用等原因。构建/失败输出仍不优化。回归：`bun test ./apps/electron/src/main/lib/rtk/ ./apps/electron/src/main/lib/adapters/pi-rtk-output.test.ts`；构建资源准备后用 `DOMI_RTK_SMOKE=1 bun test ./apps/electron/src/main/lib/rtk/rtk-real.test.ts` 显式 smoke。
- `adapters/pi-extension-trust.ts` / `pi-extension-resource-loader.ts`：按项目 canonical path + SHA-256 授权，在模块求值前 fail closed。
- `managed-web-access/` / `audit/`：公开 Web 目标、secret、redirect 策略与脱敏 JSONL 审计。
- `adapters/pi-agent-adapter.ts`：唯一 Runtime adapter，桥接 Domi 渠道、Skills、MCP、工具和流式/审计事件。
- `adapters/pi-mcp-tools.ts` / `adapters/pi-builtin-tools.ts`：将用户 MCP 与 Domi 产品能力转换为 Pi custom tools。
- `agent-prompt-builder.ts`：构建 Domi 工作区、Context、Execution Controls、知识维护和协作提示词。
- `agent-permission-service.ts`：承载单次审批 UI 适配。

### 关键约束

- Domi 默认不依赖 Pi 或 Claude Code 的全局用户配置，并继续使用自己的配置根和会话 sidecar。唯一例外是用户显式开启的只读全局能力：Skills 可从 `~/.pi/agent/skills`、`~/.agents/skills`、`~/.claude/skills` 发现；MCP 只读取 `~/.pi/agent/mcp.json` 顶层 `mcpServers`，不跟随 `imports`、不加载外部 packages/extensions。
- Pi external runtime 依赖版本以 `apps/electron/package.json` 为准，升级时必须同时验证 adapter、sync-runtime-deps、打包和 Windows smoke。
- Pi `0.85.1` 原生负责工具结果后的 pre-turn 压缩生命周期、Session 更新、同一 Agent loop 续跑和失败事件；Domi patch 继续负责增强 checkpoint、单次物理摘要请求、最终 Provider Context 投影与精确 token 门禁、最多两次安全尝试和超限 fail-closed。不得恢复 threshold hidden continuation 或双重摘要请求来绕开原生生命周期。
- 不得重新引入 runtime selector、Claude adapter/router、Claude MCP wrapper 或平台 `claude.exe` 依赖。
- Anthropic Provider、Claude 模型/logo、Domi 管理的可写 `AGENTS.md` / Memory、legacy `CLAUDE.md` 兼容输入，以及外部 Claude Skills 只读来源，都必须与 Runtime 删除相互独立。
- 执行模式始终使用当前 Windows 用户权限并明确提示未 OS-sandbox；研究、执行、本次执行和 Plan 生命周期只改变 Workflow/当前 run lease，不能绕过 Isolated→Local 回写/维修/交付事务、target ownership、managed Worktree/workbench integrity、产品确认事务或 Extension Trust。敏感路径名、opaque/parser failure、动态删除、Local Baseline、destructive Git、外部影响、网络和解释器等通用风险在执行模式中用于审计和宿主结构边界，不恢复旧的普通 Policy 审批档位。
- 验收版本持久固定；owner 活跃 managed Worktree 在待验收及固定版本 Preview 期间仍按 Workflow 正常执行，后续修改不进入旧预览，Agent 不直接写 Local。交付新版本须先撤回或完成既有 Preview。旧版未固定快照、已交付／保留／放弃／已清理及其 follow-up 的项目保护独立于 Workflow：手动模式和当前 run lease 不被强制研究覆盖。Controller 通过 `session-target-protection.ts` 保守拦截项目写入和未知操作，Bash 保留只读命令与环境加固；PTY 尚无同等加固，保护期间使用 Bash 诊断而不开放 TerminalRun。项目修改仍走下一轮／撤回验收宿主确认。
- 所有 Shell 判断必须消费同一份 Canonical Shell Analysis；Bash 与 PowerShell 必须使用各自语法解析器，严禁把 PowerShell source 送入 Bash AST。下游不得把已证明为 argv 字面量的文本重新解释为 executable。研究模式只能放行可证明无副作用的命令；执行模式中解析结果用于审计和宿主结构边界，解析失败不得转化为旧式权限档位或编造具体 Git 风险类别。PowerShell 变量求值只能在宿主提供的 managed root 内用于研究模式的安全正向判断。
- Research / Plan First 的 Bash 只读白名单可支持有限的 stdout-only 管道，包括 `curl GET | tar --to-stdout | grep` 上游产物检查；stdout 解包只允许从 stdin 读取归档并显式选择成员，执行前清空 `TAR_OPTIONS`，不得放开落盘解压、外部解压程序、文件列表输入或命令 hook。
- `ExecutionPolicy` 是唯一授权分类 owner，并通过 `allow / require-approval / deny` 强类型 resolution 输出决定；`AgentPermissionService` 及 UI 只负责审批交互和宿主事务，不得恢复 session command whitelist、raw-string classifier 或 allow-always 权限提升。
- Workspace Boundary、Managed Web 和 Extension Trust 是宿主策略，不是 OS/网络沙箱；DNS rebinding check/use 间隙必须在用户文档中如实保留。
- Pi Extension trust 不继承项目、Skill 或 MCP 信任；renderer 不得提交任意路径直接授权。
- `@domi/*` 是 Domi 的 canonical workspace package identity；`DomiPermissionMode`、`DomiEvent` 等 Domi 自有类型使用当前产品命名。只有 `SDKMessage`、`sdkSessionId` 和显式旧数据导入字段等真实持久化/协议兼容名可以保留历史命名。

### 原生图片生成

- `main/lib/image-generation/` 统一解析渠道/旧配置与 OpenAI Images、Gemini 请求；Chat/Work 只保留工具和附件桥接。
- 生图模型独立于主对话模型；`ImageGenerationSelection` 只持久化渠道引用、模型和参数，不包含凭据。普通 API 渠道显式配置图片协议，OAuth/订阅不可自动复用。
- 显式选择随请求固定并进入独立 deferred run，重试/队列不能继承另一条请求的模型；旧工具名保留供历史消息与权限门禁识别，基础使用不要求打开 MCP。
- 不将 `/models` 成功表述成生图可用；不自动付费试生成、不静默跨渠道回退。默认保存会话附件，workspace 输出仍遵守原有路径授权。
