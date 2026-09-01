import type { ModelPresentationPreset } from '@domi/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

/**
 * 模型可见面的呈现预设。
 *
 * 参考 DeepSeek Harness 的 Minimal preset：它只收窄"模型看到的系统提示词与工具面"，
 * 持久化、沙箱、审批与宿主授权等部署层全部保持不变。Domi 对应语义：
 * - 工具不展示 ≠ 工具不设防；模型直呼被隐藏工具时仍经过 final tool guard。
 * - 过滤必须保留原 ToolDefinition 对象引用，避免破坏 adapter 的 guard 包装
 *   （wrapActiveTools / 文件 checkpoint wrapper）与并行分类。
 */

/** harness Minimal 同款固定系统提示词；评测控制变量不注入任何 Domi 行为规则。 */
export const MINIMAL_PRESET_SYSTEM_PROMPT = 'You are a helpful software engineer assistant.'

/**
 * Minimal 预设的模型可见工具面：单一编辑器 + 持久化 Bash。
 * 对齐 harness 的 str_replace_editor + bash 组合；Domi 没有 str_replace_editor，
 * Edit 承载读写改入口，文件读取可经 Bash（cat/head 等）完成。
 */
export const MINIMAL_PRESET_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'edit'])

/** 按呈现预设过滤模型可见工具面；standard 原样返回。 */
export function filterToolsForModelPresentation(
  tools: readonly ToolDefinition[],
  preset: ModelPresentationPreset,
): ToolDefinition[] {
  if (preset !== 'minimal') return [...tools]
  return tools.filter((tool) => MINIMAL_PRESET_TOOL_NAMES.has(tool.name))
}

/** 按呈现预设解析追加到 SDK preset 之后的系统提示词；minimal 返回固定句。 */
export function resolveModelPresentationSystemPrompt(
  preset: ModelPresentationPreset,
  standardPrompt: string,
): string {
  return preset === 'minimal' ? MINIMAL_PRESET_SYSTEM_PROMPT : standardPrompt
}
