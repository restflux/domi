# Pi 上下文压缩架构

## 状态

当前实现使用 Pi 原生 compaction lifecycle。Domi 只在该生命周期的扩展点上补充可验证的 checkpoint 上下文、最终 Provider Context 投影和请求前 token 门禁，不维护第二套隐藏续跑或并行摘要协议。

Domi-owned Context Compactor 是实验能力，默认关闭。设置可选择 `off`、`observe` 或 `enhance`；无法安全构造增强上下文时默认回退 Pi 原生路径，严格模式则取消本次压缩。

## 设计目标

长会话压缩必须同时满足：

1. 保留最近用户纠正、精确路径、ID、失败尝试和下一步；
2. 不把 Renderer 派生状态当作宿主事实；
3. 不修改完整 transcript、`SessionManager` entries 或持久化消息；
4. 不因摘要失败产生不受控的隐藏 continuation；
5. 最终发送给 Provider 的上下文必须经过预算检查。

## 当前流程

```text
Pi pre-turn compaction lifecycle
  → Domi 读取有界 Host Snapshot
  → 校验并生成 pinned facts
  → 投影最近真实用户消息与 retained suffix
  → 计算最终 Provider Context token 预算
  → 安全时发送一次摘要请求
  → 超限时最多进行一次 aggressive retry
  → 失败时按配置回退 Pi 或严格取消
```

Host Snapshot 只允许来自宿主事实源，包括 Session Target、checkout/review 状态、最近验证、可见进度任务和明确用户约束。缺失证据、状态冲突、禁止性的完成声明或预算超限均按 fail-closed 处理。

默认增强预算定义在 `apps/electron/src/main/lib/adapters/pi-context-compactor.ts`：

- 最近用户消息：20,000 tokens；
- pinned facts：2,000 tokens；
- 增强总量：22,000 tokens；
- Host Snapshot 超时：2,000 ms；
- 默认失败策略：`fallback_pi`。

这些值是安全上限，不是保证使用量。Provider-only 投影不会覆盖原始会话记录。

## 关键不变量

- Pi 仍拥有工具结果后的压缩触发、Session 更新和 Agent loop 续跑。
- 一个正常 lifecycle 只发出一次物理摘要请求；仅最终上下文仍不安全时允许一次 aggressive retry。
- 压缩边界后的 token 判断不得复用压缩前的 stale usage。
- recent user、pinned facts 和 retained suffix 共享最终投影预算，不能各自绕过上限。
- checkpoint 不得声称未发生的提交、验收、验证通过或任务完成。
- 错误信息不得暴露完整 prompt、工具输入、环境变量或凭据。

## 验证

主要聚焦命令：

```bash
bun run --cwd apps/electron verify:pi-runtime
bun run --cwd apps/electron eval:compaction-quality
bun test apps/electron/src/main/lib/adapters/pi-context-compactor.test.ts
bun test apps/electron/src/main/lib/adapters/pi-auto-compaction-turn-stop.test.ts
```

质量评估 fixture 只用于确定性回归和显式的 model-backed replay。未经足够样本验证，不应把一次评测延迟外推为生产延迟结论。

## 已知限制

- Domi 的静态 token 估算是请求前保护，不等价于 Provider 的精确计费器。
- pinned facts 的质量依赖宿主事实源完整性；证据不充分时宁可回退或取消。
- `observe` / `enhance` 仍属于实验设置，默认生产行为保持 Pi 原生压缩。
