# Pi 1.0.4 Codemode：只读评估与默认关闭接入

## 当前结论（第 9 轮）

生产代码已接入 **Domi-owned、内部显式 opt-in、默认关闭** 的只读切片，不是开启 Pi 的全目录 Codemode factory。`PiAgentQueryOptions.readonlyCodemode === true` 才注册；没有设置页、默认启用或 Pi CLI/global 配置。普通核心工具仍常驻。第 9 轮开发基线为 `0.38.3`；冲突合并后沿用 Local 已有的 `0.39.0`，Pi/Chord 固定 `1.0.4`。本内部验证不额外升应用版本，保留 Local 已有的 retryNow patch。

第 8 轮阻塞已经真实 RED → GREEN：仅父获准、子 Read 被拒绝时，直接和嵌套实际执行均为 **0 次**。原 `test.failing` 已解除，断言没有放宽。原生全目录 factory 仍只用于对照测试：它没有宿主定义身份白名单或固定硬预算，而且包含 store/图片/截断文件行为，不应直接启用。

当前建议仍是**保持默认关闭**。固定本地摘要任务显示返回内容控制的价值，但没有真实模型、GUI 或 Windows 验收，不能据此全量启用。

## 最终授权责任边界

旧缺口：Pi 1.0.4 的 `ctx.executeTool()` 走 Session 的嵌套 pipeline，而旧 Domi 只包装 `agent.beforeToolCall`。直接拒绝 Read 为 0 次，父 Codemode 获准后子 Read 却执行 1 次；批次调度并不能补齐授权。

本轮沿公开定义执行入口收敛同一个授权 owner：

- 直接路径保留 Pi/受信扩展前置链，然后独立授权，执行入口消费一次匹配许可；不重复审批。
- 嵌套路径仍由公开 `ctx.executeTool()` 进行 SDK 校验、hooks 和执行，再在同一入口独立授权。父许可不传递，不由宿主另起 `tool.execute()` 调度器。
- 前置 hook 已拒绝时，子调用不再请求授权、不执行。输入漂移、定义变化、无法安全应用的不同 `updatedInput` 和权限异常均 fail closed。
- 公开 `tool_execution_start` 记录实际定义、原参数及父 ID；公开 `validateToolArguments()` 核对转换后的参数，不复制 SDK 校验算法。带 `prepareArguments` 的定义不进入首期脚本，以免重放有状态准备步骤。
- 审批消费实际 call-level signal 与 guard 生命周期；取消后晚到的 allow 不能恢复执行或借给下一调用。
- 共享定义按 `ctx.sessionManager` 对象分流 owner，不按名称、session ID 字符串或推算子 ID 绑定。结束、dispose 和安装失败释放本轮 owner/许可/订阅/等待状态。
- 可保护定义的 `execute` 槽不可重定义；普通替换会使其失效，`defineProperty` 不能撤掉入口。dispose 只撤 owner，不恢复执行槽。未变化定义可以给下一个 Session 重新绑定。

**范围限制：** 冻结/不可重定义的外部定义保留原普通直接路径，但 `isProtected()` 为 false，不能进入脚本。不把该机制宣称为所有外部冻结定义的嵌套授权保证，也不把受信 Node 扩展当作 OS 沙箱。持有函数的闭包与 SDK/受信扩展本身仍是受信宿主代码。

## 目录与真实执行双重限制

首期实际 SDK 名称是 `read / grep / find`，对应 Read/Grep/Glob 概念。候选来自本轮 Domi 创建的 builtin 对象，并要求它们仍在呈现工具集合中；最小呈现预设若移除了这些对象，显式 opt-in 会保守失败，不擅自重新曝光。

初始化及每次子调用同时核对：

1. 名称属于固定三项；
2. 对象确实属于调用方持有集合；
3. `getToolDefinition(name)` 仍返回同一对象；
4. 最终门禁仍保护该定义、没有有状态 `prepareArguments`。

`readOnlyHint` 或外部同名声明不证明所有权。SDK 优先保留 customTools 的同名场景，只有精确宿主对象仍胜出才可用；外部哨兵零执行。若真实定义不同则拒绝。`codemode` 保留名冲突直接拒绝。

Sandbox 不注入 models/Classifier。Bash、写入、网络工具、MCP、外部 Extension、交付/终止、压缩、工具搜索及交互工具均不进入脚本目录；普通直接路径保持原样。子调用继续逐个经过原 Execution Policy、Workspace/Session Target、annotations 信任与审计，不新增授权系统或父级批量授权。

## 宿主预算与取消

使用公开 `CodemodeSandbox`，不复制 VM/worker 或解释器：

| 项目 | 固定上限 |
|---|---:|
| 单次脚本 deadline | 5 秒 |
| VM 内存 | 32 MiB |
| 脚本字符数 | 64 KiB 字符 |
| 子调用数 | 32 |
| 同时在途子调用 | 4 |
| 单子调用文本 / 最终交付 UTF-8 文本 | 各 64 KiB |

不解析模型 `// @options:` 来提高预算。超额调用/并发会取消本轮 Sandbox；真实重叠回归证明最多四项在途、结束后释放，不把快速完成的十二项误算为十二并发。固定 CPU 循环被 deadline 结束，超额 VM 分配报内存错误，后续实例仍能返回 42。

宿主交付字节限额在原生结果收集之后检查；SDK 自身还有输出收集限额。32 MiB 不代表整个 Electron/host I/O 内存限制，64 KiB 不代表 VM 内部从未收集更大结果。取消依赖 host 工具消费 signal，不能保证强行中断任意不协作 I/O。

仅接收文本子结果和文本输出；图片结果保守报错。`storeWrites` 不转交 Session，不保存图片/截断临时文件；测试证明 `store()` 不产生 `codemode-store` custom entry。每次关闭本轮持有的 Sandbox，不清理其他 Session、用户 Domi 或已有资源。

## 批次、审计与历史

- 真实 Session 加生产批次调度验证普通 Read → Codemode（含成功/失败并行子 Read）→ 普通 Write 正常结束，没有父等子、子又等父结束的循环等待。失败不重放已完成读取。
- 最终 timing 使用现有 JSONL seam，新增 `parentToolCorrelationId`；父和子沿同一既有 hash 规则关联。授权等待和执行两类事件都有关联，不保存原工具 ID、参数、正文、结果或凭据，不新增数据库/并行日志。
- SDK 原始内存事件仍携实际父子 ID/结果，原生 JSONL 仍只有父 `toolResult` 和 bounded `nestedCalls`。**没有独立子结果全文历史**，新增 timing 关联不改变这个边界。
- 原生摘要上限仍为 256 调用、单调用参数 8 KiB/总参数 32 KiB、错误文字 500 字符；原生测试 257 次调用保存 256 项并标记 `complete:false`。生产切片更早限制为 32 调用。
- 真实磁盘、重启、fork、模型切换回归保留父摘要并重新初始化当前定义/门禁；旧许可不恢复，新执行独立授权。终止/交互核心定义仍可见，子秘密正文未由父返回时不进入完整子历史。

## 有界离线对照

同一测试持有的 2 或 12 个 JSON 文件，每文件 32 行：读取、筛选 active 行、按 ID 去重、统计 sourceRows/失败。普通并行工具、原生测试 factory、Domi 默认关闭切片各运行一次；脚本分批四项，不连接用户远程服务、不用真实凭据或计费模型。

普通并行返回 content JSON 的历史稳定口径约为 35,729 B（2 文件）、214,369 B（12 文件）、196,667 B（12 文件缺一项）；原生测试摘要约 176/177/177 B。**Domi 实际切片还返回 bounded 执行诊断，不能套用原生纯摘要数字**；本次约 294/1,016/1,024 B，粗估 74/254/256 个字符四分之一单位。精确数据见 `pi-codemode-i9-comparison.log`，时间/临时路径会导致小幅变化。

三条路径均正确完成成功场景，缺文件时各成功读取 11 项、报告部分结果、不重放；均为两次模拟 Provider 请求。主要价值是减少大量正文进入返回 content，不减少这个固定任务的请求轮次。

只计 `toolResult.content` JSON UTF-8 字节；字符数÷4是粗估，不是 tokenizer/Provider 用量。不含脚本/参数、工具定义、系统提示、完整历史或 nestedCalls，不能称为完整上下文/账单下降。脚本预先知道文件/算法，普通路径摘要由测试代码计算；不证明真实推理、速度、费用或自主选工具成功率。

## 运行时与验证口径

`pi-codemode@1.0.4` 升为 Electron exact direct runtime root，并加入 build/watch external 与 runtime sync。沿异步 dynamic import 读取公开 Sandbox/validation；main ESM verifier 禁止八个 Pi/Chord ESM 包及子路径静态 require，要求保留五个关键 dynamic import。没有改 exports、SDK patch 或全局凭据。

QuickJS 为已锁 `quickjs-wasi@3.6.2`；Pi/QuickJS/QuickJS-NG 许可副本沿用第 8 轮，第三方说明更新实际内部用途。没有复制解释器，不声称复现 WASM 源码构建或完整 SBOM。

验证结果以本轮交付卡记录为准，旧第 8 轮日志不作为新快照验收：

- 新只读切片、权限输入/身份/取消/共享定义、真实磁盘恢复及父子审计行为测试；原授权 expected failure 已真实转绿。
- 完整 adapter/恢复/ESM/runtime 回归、权限/审计回归、根六 workspace typecheck、主进程及完整 Electron build、runtime sync/verifier、diff 检查。
- 本轮未签名 macOS arm64 目录包及 synced/ASAR 公开 worker/WASM smoke；资源一致、实际运行和 GUI 验收是不同证据。
- 唯一一轮 600 秒预算的独立只读审查受渠道 `429 credential_concurrency_exceeded` 限制，未返回有效结论；**不能算审查通过**，未重新委派或循环续审。父会话行为验证仍完成。

当前环境 macOS arm64。没有关闭用户 Domi、替换安装或绕过单实例锁；Windows fast package/worker/进程树、完整 GUI、签名与真实安装验收未覆盖。run-as-node 的打包二进制 harness 不是 GUI/安装授权验收。

## 第 8 轮历史结论

第 8 轮应用基线 0.38.1，仅交评估/测试/许可材料，不注册生产工具。23 项新 suite 中一项原始授权目标为 expected failure；完整 426 项（含该 expected failure）与审计 21 项通过，不能把它当作当时安全目标已满足。其一次独立审查达到 600 秒后停止，未返回有效结论。

当时已核对 13 个既有关键 runtime 文件以及额外 14 个 Codemode/QuickJS JS 和一个 WASM 的 root/synced/ASAR 字节，并用 Electron 43.2.0 / Node 24.18.0 公共 Sandbox 运行 `[1,3]`、CPU deadline 与后续 42。这些是历史加载证据，不替代本轮新快照与生产切片验证。
