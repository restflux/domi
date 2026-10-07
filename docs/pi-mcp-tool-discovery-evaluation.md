# Pi 1.0.4 MCP 工具按需发现：内部验证

## 结论与使用范围

保留默认全量曝光，不建议当前面向全体用户启用。大量、英文可检索的 MCP 目录有明显的声明体积收益；工具少时原生搜索工具本身增加声明开销，并增加一次模拟 Provider 往返。纯中文查询在 Pi 1.0.4 的原生 BM25 中不能检索。

本轮交付的是内部显式 opt-in 的最小 SDK 验证接口，不是新的设置项或默认产品功能。`PiAgentQueryOptions.mcpToolDiscovery` 未传或为 `false` 时，现有路径保持全量曝光。没有新增依赖、协议实现、凭据存储或第二套 MCP 配置；应用版本保持 0.38.1。

## 接入合同

- `pi-mcp-tool-discovery.ts` 接收 adapter 已经异步加载的公开 `createToolSearchExtension()` 和 `getCurrentTools()`，没有生产 Pi 静态值导入。
- 仅对 Domi 工具来源映射标记为 `mcp` 的现有 custom tools 设置 `deferred` 和 namespace；名称、schema、execute、结果与图片桥接不变。核心、交互、压缩、终止和交付工具保持常驻。
- Domi-owned inline factory 向原生搜索提供限定的 MCP 目录；其他扩展的 deferred 工具不会被本试验搜索。`tool_search` 同名冲突拒绝初始化，以定义对象身份确认所有权，不凭名称赋予宿主身份。
- 搜索通过原有最终门禁与审计，只加载模型可见定义。真实 MCP 调用仍单独授权，不将发现当作允许执行，也不信任未获显式授权的 readonly annotations。
- 搜索、排序和 transcript 中的工具声明变化由 Pi 实现。Domi 不复制 BM25、私有恢复算法或额外持久化格式。
- 现有 `noTools: 'builtin'` 会向公开 SDK 提供显式初始工具集合，因而重建 Session 时不会自动恢复之前的 MCP loadout。本切片通过公开 `buildSessionProjection()` / `getCurrentTools()` 读取已声明的 MCP 名称，并通过公开 `setActiveToolsByName()` 补齐；不从历史调用猜测加载状态。
- 重启与公开 `SessionManager.forkFrom()` 继承加载定义和历史引用。模型切换不清空定义。关闭实验恢复所有当前 MCP；内部 `exposeAllMcpTools()` 可在无匹配时回退，保留其他活跃工具，不提供模型可调用的权限提升入口。
- 仅延迟定义曝光，不延迟服务器连接、初始化或 `tools/list`。不能据此宣称启动更快。

## 可复现的离线对照

运行：

```bash
bun test ./apps/electron/src/main/lib/adapters/pi-mcp-tool-discovery-eval.test.ts
```

使用 2 / 128 个合成 MCP 工具和 6 个固定核心工具 fixture，真实 Pi Session、原生发现与 transcript 投影，Provider 完全模拟。下表统计 Provider transcript 中**当前工具声明 JSON**的 UTF-8 字节；不包含系统提示、消息历史、历史工具声明增量或协议包装，不能视作完整请求大小或总计费 token。

| MCP 数量 | 全量初始声明 | 按需初始声明 | 按需加载 1 个后 | 初始声明差异 | 完成固定英文任务的请求数（全量 → 按需） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2 | 1,462 B | 1,618 B | 1,848 B | 增加 10.7% | 2 → 3 |
| 128 | 30,442 B | 1,618 B | 1,848 B | 减少 94.7% | 2 → 3 |

同时输出 `ceil(JSON 字符数 / 4)` 的粗估：2 工具全量约 366、128 工具全量约 7,611，按需初始约 405、加载后约 462。**不是 tokenizer 计数或计费依据**，不同语言、模型和 Provider 的实际 token 会不同。

两种目录各验证 3 个固定查询：

| 查询 | 原生按需目标命中 / 模拟任务完成 | 说明 |
| --- | --- | --- |
| `ticket0001` / `ticket0127` | 2/2 | 精确英文目标关键词 |
| `查找 ticket0001` / `查找 ticket0127` | 2/2 | 命中来自英文部分，不是中文语义检索 |
| `查找工单` | 0/2 | 纯中文分词为空，未调用真实工具 |

按需路径合计命中并完成 4/6；全量路径的模拟 Provider 预先知道目标工具，完成 6/6。这是**固定查询/固定目标的协议与检索验证**，不是模型自主选词、真实任务成功率、延迟、费用或性能实验。没有用户远程服务、真实凭据或付费模型调用。实际上下文仍可能保留工具声明历史，加载更多工具后体积收益会降低。

## 回归与限制

行为回归覆盖：默认全量、仅用户 MCP 延迟曝光、多个工具加载、下一次 Provider 请求定义一致、发现零实际调用、发现拒绝/取消、MCP 单独拒绝与允许、未信任 readonly、结构化/error/图片结果、中英文查询与中文原始名称、无匹配/非法参数及安全回退、外部 deferred 工具排除、同名归属冲突、原生 projection、文件重启、fork、历史工具结果、模型切换与关闭实验。

现有 MCP 名称规范化、保留名与碰撞、连接生命周期、SSE 兼容和逐工具权限回归继续运行。没有重写这些行为。原生 16 MiB 单消息/event 限制仍在，不因本轮定义发现而消除。

本地加载 smoke 只验证 Electron 内置 Node 对 CommonJS 切片与 Pi ESM 原生 factory 的加载及离线调用，不等同于安装包 GUI 启动。当前 macOS arm64 无法验收 Windows fast package；不关闭用户运行中的 Domi 绕过单实例锁。

建议后续只对工具多且具备稳定英文元数据/查询的特定目录进行受控真实模型实验，先验证模型是否会正确生成查询以及多一轮的实际成本。中文目录和少量工具继续使用全量路径。本轮不增加自动阈值、自研中文检索或默认启用开关。

## 本轮验证记录

- 新增发现/真实 Session/离线对照共 17 项；完整 adapter 与 ESM/runtime verifier 单测合计 **403 pass / 0 fail**（57 文件，1,459 断言，其中 adapter 391 项、verifier 12 项）。
- 根 6 workspace typecheck、`build:main` 和完整 `electron:build` 通过；保留现有 Vite chunk 体积提示。最后补齐初始化归属冲突时的本次 Session 释放后，受影响发现/MCP/权限/projection/loader 回归重新通过 56 项，Electron typecheck 与最终主进程构建再次通过。
- 锁定安装未改变 manifest/锁文件；root 与同步后八个 Pi/Chord 包均为 1.0.4。runtime sync 143 个依赖，跳过 58 个未安装 optional；既有 verifier 的 13 个关键文件 root/synced 一致。
- 最终 `main.cjs` ESM 检查通过：保留 3 个必要 dynamic import，无 Pi ESM 静态 require。
- Electron 43.2.0 / Node 24.18.0 run-as-node 从同步目录加载 Pi ESM 和临时 CommonJS 生产切片，离线发现→加载→调用通过（3 个 Provider 请求、1 次本地 sentinel 执行）；临时 bundle 已清理。这不是 GUI 或远程 MCP smoke。
- 一轮限时只读权限/持久化审查未发现可证实 Blocking/High，独立相关回归 28 pass / 0 fail。未重审或修改宿主授权架构。
