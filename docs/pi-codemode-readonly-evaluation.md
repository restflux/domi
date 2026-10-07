# Pi 1.0.4 Codemode 只读可行性验证

## 结论

**本轮验证完成后不注册生产 Codemode，也不增加内部 opt-in 或设置入口。** 这不是继续修 SDK/MCP 迁移，而是新能力是否满足 Domi 边界的独立评估。应用仍为 `0.38.1`，八个 Pi/Chord 包固定 `1.0.4`；manifest、锁文件、最小 pi-ai patch及已有默认关闭实验不变。

公开 VM 能支持批量读取、筛选和汇总，且提供 worker、取消、内存和超时能力。但直接接入原生 factory 不能满足本轮最重要的前提：每个子调用独立经过 Domi 当前的最终授权。本轮不另建权限路径、不复制解释器或 SDK 私有算法来掩盖缺口。

## 真实 Session 复现的阻塞

### 1. Pi hooks 不等于 Domi 最终门禁

测试使用公开 `createAgentSession()`、`createCodemodeExtension({ models: false })`、模拟 Provider、无副作用本地哨兵，以及真实 `installPiFinalToolGuard()`。

- 直接发起 `Read`：最终门禁收到请求并拒绝，哨兵执行 **0 次**。
- 最终门禁只允许父 `codemode`，策略仍拒绝 `Read`；脚本调用 `tools.Read({})`：最终门禁只收到父请求，子哨兵执行 **1 次**。
- 加上生产使用的 `installPiToolExecutionScheduler()` 后，该缺口仍复现。
- Pi extension 的 `tool_call` hook 能看到子调用和父 ID，也能将其阻断为 **0 次**；这仅证明 Pi 自身 pipeline 有 hooks，不能证明已经消费 Domi 的 Execution Policy/最终授权。

根因：1.0.4 的嵌套路径调用 Session 自己的工具 hooks，而 Domi 当前包装的是 `session.agent.beforeToolCall`。不能把父调用许可当作全部子调用的许可。

测试保留 `test.failing` 安全前提：**子 Read 被拒绝时实际执行必须为零**。原始红灯日志位于会话 Context 的 `pi-codemode-red.log`。此测试未放宽原断言；Bun 将预期失败计为通过，不代表安全目标已实现。另一个严格证据测试同时断言直接调用 0 次、嵌套调用 1 次以及授权请求列表，以防出现无关异常被误当作有效证据。升级或调整最终门禁后必须重新评估并解除预期失败，不能直接启用。

### 2. 原生 factory 没有定义身份白名单选项

`createCodemodeExtension()` 的公开选项是 `mode`、`inlineBudget`、`models`，没有单独的可调用工具过滤器。

- `models: false` 经实际脚本验证能够移除 `models`；本轮未调用 Classifier、图片模型或付费 Provider。
- `inlineBudget: 0` 仅缩减模型可见描述，不限制 `tools`、`ALL_TOOLS` 或实际执行。只使用同名哨兵的测试中，Bash、Write、WebSearch、MCP、交付/终止、压缩、工具搜索及外部 deferred 工具仍可从脚本调用。没有执行这些真实产品能力。
- `direct` 在活跃时可被嵌套调用；`codemode`/`deferred` 可调用；`model-only` 保持直接定义但不可嵌套，`hidden` 不可达。这说明公开 exposure 是有效机制，但不能仅靠原生 factory 自动限定本轮目录。
- 所有权不能由 `Read` 名称或 `readOnlyHint` 证明。测试专用 `codemode_probe` 用自己持有的定义对象集合与 `getToolDefinition()` 精确匹配来过滤公开 Sandbox 的目录，外部同名 Read 哨兵不可见且执行 0 次。**此 probe 仍有子调用最终授权缺口，不是生产实现。**

没有通过修改全部外部工具的 exposure、引入第二套工具系统或补一个父级“全部批准”来接入。

### 3. 宿主硬限制不能由模型 options 代替

公开 `CodemodeSandbox` 能由宿主传入 `timeoutMs`、`memoryLimitBytes` 和有限工具表。测试实测 CPU 死循环被硬 deadline 结束、超额分配报内存错误、超额 `text()` 输出失败、预取消零启动、结束/关闭取消 pending callbacks，关闭一个实例不影响另一个。

这些是**测试专用 Sandbox**的能力，不应归因于原生 factory 的可配置合同：1.0.4 factory 的公开 options 没有宿主硬 deadline/内存参数。脚本可用 `// @options:` 提交 `timeout_ms`/`max_output_tokens`，解析会接受很大值；省略 options 没有宿主可证明的固定 script deadline。原生 executor 的 VM 256 MiB上限与输出 helpers上限不能代替完整宿主预算。

测试只证明指定范围内的 worker/VM限制和协作式取消；不把 VM 当作整个 Electron、外部工具或 OS 的沙箱，也不保证取消能中断不消费 signal 的任意 host I/O。

原生 globals 也不只有读取：`store()` 在无子工具调用时能产生 `codemode-store` Session custom entry。源码合同还包括输出截断落临时文件及图片输出保存。这些不能仅凭“只曝光 Read/Grep/Glob”就称为完全无副作用的宿主路径；本轮未接入这些生产存储/图片行为。

## 授权、审计与持久化证据

- 子调用参数仍经 Pi 校验；非法 enum 参数不能执行，`Promise.allSettled` 的成功调用不重放。注意 SDK 会转换部分可转换参数，数字转字符串本身不等于校验缺失。
- 父被最终门禁拒绝时子调用零执行；但父获准后的逐子最终授权不成立。
- Pi `tool_call`/`tool_execution_*` 内存事件保留 `<parent>/<n>` 与 `parentToolCallId`，实际子调用 result 也会出现在内存事件中。
- 原生 JSONL只保存父 `toolResult` 及 `nestedCalls` 的有界摘要，不保存独立子结果全文。测试读取磁盘文件、重启、fork、模型切换均验证这一点；不将内存 result 或父摘要称为完整历史。
- 1.0.4 实测 257 次子哨兵调用只保存 256 条摘要，并标记 `complete: false`。参数及错误文字也有原生上限。
- 当前 `recordPiAgentAuditEvent()` 只转交子自身 ID/工具/结果状态，未转交 `parentToolCallId`。最终 timing 数据又独立哈希工具 ID，不能从中恢复完整父子关联。测试将 timing 写入自己的临时 JSONL再读取核对；没有新增生产 audit schema或存储。
- `sandboxProbe` 所有调用使用公开 `ctx.executeTool()`，没有直接执行 Agent `tool.execute()`；plain Sandbox callbacks仅用于 VM资源哨兵，不是 Domi 工具/Workspace/权限验证。

## 有界离线对照

同一固定任务：读取测试自己创建的 2 或 12 个 JSON 文件，每文件 32 行，筛选 active 行、按 ID 去重、统计 sourceRows和失败数。读取用 Domi 核心同款公开 `createReadToolDefinition()`，只允许固定临时文件；没有用户远程服务、真实凭据或计费模型。

| 文件/状态 | 普通并行工具返回 content JSON | 原生 Codemode测试返回 content JSON | 实际成功读取 | 模拟 Provider请求 |
|---|---:|---:|---:|---:|
| 2，全部存在 | 35,729 B | 176 B | 两者均 2 | 两者均 2 |
| 12，全部存在 | 214,369 B | 177 B | 两者均 12 | 两者均 2 |
| 12，其中 1 个缺失 | 196,667 B | 177 B | 两者均 11，无重放 | 两者均 2 |

成功场景结果正确且完整；缺文件时两者均正确报告部分结果和一个失败，不将部分完成称作完整成功。原生脚本只是把大量原始正文替换为小摘要，主要价值是**返回内容控制**；相对 Domi 已有并行读取基线，不减少这一固定任务的请求轮次。

口径/限制：

- 只计当前 `toolResult.content` 的 JSON UTF-8字节，不含工具定义、脚本/参数、系统提示、Session历史或 `nestedCalls`，不能称为整个请求/token/账单减少。
- `ceil(JSON字符数/4)` 粗估：12文件普通约 53,593，脚本约 45；不是 tokenizer或Provider用量。临时路径、错误文本、wall time等可能导致少量字节差异。
- 固定脚本预先知道文件和算法；普通路径的摘要由测试代码计算，不是评测真实模型推理。原生 factory仅在测试中使用，其授权缺口未被“收益”抵消。
- 不推断真实速度、费用、自由选工具成功率或所有任务收益，也不以串行工具基线夸大轮次优势。

## 运行时、资源与许可证

本轮锁定安装并同步runtime；八个 Pi/Chord 包为1.0.4，QuickJS依赖为已锁定的 `quickjs-wasi@3.6.2`。沿现有同步闭包检查资源，不新增 runtime root、生产静态Pi值导入或require，不改变 exports/build external/权限配置。

需要核对的资源包括 Pi Codemode公开入口、默认 worker及相邻 runtime模块、QuickJS `.wasm`；可适用时检查 macOS目录包/ASAR的保留与实际加载。资源存在、字节一致和实际 worker执行属于不同证据，不能彼此代替。

许可：Pi为MIT；quickjs-wasi为MIT（Vercel）；其QuickJS-NG来源同为MIT。补充第三方使用说明和许可证副本，未复制VM/worker实现。QuickJS-NG副本来自其上游公开LICENSE；未声称复现WASM的源码构建或完整SBOM。

## 验证与启用建议

本轮验证：

- 新增三个suite共 **23项**，其中22项正常契约/证据通过，1项上述安全目标为明确的预期失败。完整adapter及ESM/runtime测试 **426 pass / 0 fail**（425项正常通过 + 1项预期失败，不代表安全目标已实现）；审计模块 **21 pass / 0 fail**。
- 根六workspace typecheck、主进程/Electron build、runtime sync/verifier、`main.cjs` ESM通过。同步143个依赖、跳过58个未安装optional；13个已有关键文件root/synced/ASAR一致；无Pi静态require，保留3个必要dynamic import。构建仅有既有Vite大chunk提示。
- 未签名macOS arm64目录包完成；额外比对Pi Codemode与quickjs-wasi的 **14个JS文件 + QuickJS WASM**，root/synced/ASAR字节一致，公开exports不漂移，ASAR main与最终build一致。不是整个闭包或完整SBOM验收。
- Electron **43.2.0 / Node 24.18.0** 的run-as-node分别在同步目录、打包ASAR运行公开Sandbox：4次本地哨兵调用正确筛选出 `[1,3]`，CPU循环被硬deadline终止，后续worker返回42，实例关闭完成。打包二进制仅作Node运行时harness；没有启动Domi完整GUI/IPC、真实用户工具或在安装环境验证授权。临时smoke入口已清理。
- 仅一轮600秒独立只读审查达到时限自动停止，**未返回有效结论**；不将其称为审查通过，也未追加循环审查。安全/历史结论依据上面的父会话严格复现。
- macOS环境未执行Windows fast package/启动/worker实机、完整GUI或签名/安装验收；未关闭用户Domi或替换现有安装。

**建议继续不启用。** 若后续确有批量本地摘要需求，前置条件是：公开执行pipeline可以消费Domi同一个最终授权责任边界；每个调用保留取消和最终门禁顺序；目录与实际执行按宿主持有定义身份限制；宿主硬预算可证明；父子审计与有界历史合同明确。那会是一项单独的权限/生命周期适配任务，不能仅取消本轮expected failure或打开factory就上线。
