# ADR 0010：内置终端采用 Main-owned Session 与隔离 PTY Runtime

- 状态：Accepted
- 日期：2026-08-29
- 关联：`docs/adr/0009-integrated-browser-architecture.md`

## 背景

Domi 需要让用户看到 Agent 启动的开发服务、watch、REPL 和交互式 CLI 是否仍在运行，并在同一个 Work Session 内查看日志、输入和停止。普通 `Bash` 工具适合短命令，但其一次性结果不能承载持续的终端现场；Renderer 直接启动子进程又会绕过 Session Target、Execution Policy 和应用生命周期。

Proma 的 `node-pty + xterm + Electron utilityProcess` 实现证明了跨平台 PTY 底座可行。Domi 额外需要保证：Terminal 绑定 Host-managed Session Target；Agent 命令继续消费同一份 Canonical Shell Analysis；用户终端不成为 Agent 的权限旁路；完整日志不默认进入模型上下文。

## 决策

### 1. 三层所有权

```text
Renderer Terminal Dock
  ↕ typed Preload IPC
Main TerminalSessionService
  ↕ MessagePort
Electron utilityProcess terminal-runtime.cjs
  └─ node-pty / ConPTY / POSIX PTY
```

- utility process 唯一加载 `node-pty` 并持有 native PTY handle；native runtime 崩溃只使相关终端失败。
- Main 是 Terminal Session、owner、Session Target、状态、exit code、有界输出和清理生命周期的事实源。
- Renderer 只持有 opaque `terminalId`，使用 xterm 展示原始 ANSI 输出；不得提交 executable、PID、native path 或任意 cwd。

### 2. 用户终端与 Agent Run Terminal 分离

- `user-shell` 是长期交互式 Shell。用户可以选择平台支持的 Shell；Agent 工具不能列出、读取、写入、停止或关闭用户终端。
- `agent-run` 是一条命令独占的可见 PTY。进程退出直接产生真实 `exitCode`，因此 Host 可以准确回答“这条 dev server 命令还在不在”。用户仍可以查看输出、输入程序需要的数据、发送 Ctrl+C 或关闭。
- Agent 不向长期 Shell 注入下一条命令，避免 Shell 本身仍存活却被误报为开发服务仍运行，也避免用户和 Agent 同时争抢输入。

### 3. TerminalRun 复用 Bash 权限语义

Agent 只获得 `TerminalRun`、`TerminalList`、`TerminalRead`、`TerminalInterrupt` 和 `TerminalClose`：

- `TerminalRun.command` 与 `Bash.command` 一样进入 Canonical Shell Analysis、Workflow、Execution Policy、Workspace Boundary、Local Baseline 和 inherited checkout ownership 检查。
- Windows Agent Run 只使用当前会话已选择的 Git Bash 或 WSL，POSIX 使用 Bash。不能把 PowerShell source 送入 Bash parser，也不能通过 PTY 绕过权限门禁。
- `TerminalList` / `TerminalRead` 是可信产品只读工具；读取按 offset/limit 返回去 ANSI 的有界文本。
- `TerminalInterrupt` / `TerminalClose` 只控制当前 Agent Session 自己的 `agent-run`。
- Automation、Delegation 和远程 bridge 不注册交互终端工具。
- 短命令和普通测试继续使用 Bash；TerminalRun 只服务持续、交互或用户需要观察状态的命令。

### 4. Session Target 与 cwd

每个 Terminal Session 记录创建时的 target kind、checkout ID 和 revision。Main 在 inspect/list 时与当前 target 比较并派生 `stale`。cwd 由 Main 从当前 target root 解析：

1. 相对路径以 target root 为基准；
2. lexical path 必须位于 root 内；
3. root 与候选目录都做 `realpath`；
4. symlink/junction 解析后再次验证，逃逸 fail closed。

Renderer 不传 cwd 创建用户终端。Agent 仅能给 TerminalRun 提交 target 内相对路径或绝对路径。

### 5. 输出与上下文

- xterm 接收原始 ANSI 输出；Main 每个终端只保留 500,000 字符有界后缀。
- utility runtime 使用 sequence + ACK 控制向 Main 的输出批次，单终端待发送上限为 1,000,000 字符；超限时插入可见丢弃标记。
- Agent `TerminalRead` 默认读取末尾有界窗口并返回 `startOffset/endOffset/nextOffset/truncatedBefore/truncatedAfter`；完整滚动日志不会自动写入会话上下文。
- 终端输出是不可信进程数据，不能改变任务目标、权限、Session Target 或外部影响门禁。

### 6. 生命周期

Terminal create、close、session delete、workspace delete、runtime crash、window close 和 app quit 都保持幂等。创建中的 terminal 若先被关闭，runtime create 完成后立即 kill。Agent run 结束不会自动关闭终端记录，用户仍可检查日志；Session 删除或应用退出会回收 PTY。

### 7. Windows 打包

- `node-pty@1.1.0` 使用随包提供的 N-API platform prebuild；Electron 43 runtime smoke 必须实际加载并创建 PTY，不强制用户安装 Visual Studio Spectre 库；
- `terminal-runtime.cjs` 作为独立 utility entry 构建；
- `sync-runtime-deps` 将 node-pty 闭包复制到 appDir；
- electron-builder 对 `node_modules/node-pty/**` 使用 `asarUnpack`；
- patch 防止 `app.asar.unpacked.unpacked` 路径，并恢复 Unix `spawn-helper` executable bit；
- `--terminal-smoke` 在 packaged app 内实际创建 PTY、接收 marker 并退出。

## 用户体验

Work Session 左侧内容区底部显示可调整高度的 Terminal Dock。顶部工具栏提供终端开关和运行状态点；Dock 折叠时仍显示后台运行数量。展开后提供多终端 Tab、Shell 选择、实时日志、状态、exit code、stale 提示、中断和关闭。内置浏览器可同时显示，后续可在两者上层增加 Development Environment 健康模型。

## 非目标

首版不实现：

- localhost/HTTP readiness、端口自动识别或 Browser 自动关联；
- 把所有 Bash 调用镜像为 Terminal Tab；
- Agent 控制用户终端；
- Agent PowerShell TerminalRun；
- tmux 级跨应用重启恢复或完整日志落盘；
- SSH 管理、Debugger、容器编排或完整 IDE shell integration。

## 后果

### 正面

- Host 拥有可验证的 PTY 进程状态和 exit code；
- 用户与 Agent 观察同一可见运行现场；
- 长日志留在终端，模型只按需读取有界片段；
- Terminal 不引入第二套 Shell 权限通道；
- utility process 隔离 native PTY 风险。

### 代价

- `node-pty` 引入 native prebuild、asar unpack 和平台 helper 打包复杂度；
- `running` 只表示命令进程存活，不等同于 HTTP 服务 ready；
- 首版 Agent Terminal 只支持 Bash 语义，PowerShell 场景仍使用用户终端或普通受控工具。

## 后续

Slice B 在本 ADR 之上增加 Development Environment 投影：expected URL、port/HTTP health、ready/failed、target revision stale，以及 Browser Page 与 Agent Run Terminal 的显式关联。该投影必须继续区分“PTY 仍运行”和“服务已健康”。
