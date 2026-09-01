import type { ContextWindowSource } from '../types/agent'
import type { ProviderType } from '../types/channel'

/**
 * 模型上下文窗口推断 — 单一 source of truth。
 *
 * 1M 上下文已随各家模型转正为默认能力（Anthropic 于 2026-03 对 Opus 4.6 /
 * Sonnet 4.6 起 GA，无需 context-1m beta header；Sonnet 5 / Opus 4.7+ 延续），
 * 故不再下发任何 beta。前端推断、后端用量统计和运行时模型目录必须共用
 * 同一份判定，避免出现 UI 与实际上下文窗口不一致。
 */

/** 默认上下文窗口（无法识别模型时使用） */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** 1M 上下文窗口 */
export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000

/** ChatGPT Codex 当前目录中的 GPT-5.x 上下文窗口。 */
export const CODEX_GPT_54_55_CONTEXT_WINDOW = 272_000
export const CODEX_GPT_54_MINI_CONTEXT_WINDOW = 272_000
export const CODEX_GPT_56_CONTEXT_WINDOW = 272_000

/** 上下文窗口来源优先级：更权威的值可以向下修正低优先级推断。 */
export const CONTEXT_WINDOW_SOURCE_PRIORITY: Record<ContextWindowSource, number> = {
  name_fallback: 1,
  temporary_adaptation: 2,
  provider_catalog: 3,
  provider_metadata: 4,
  runtime: 5,
}

interface SDKResultContextWindowInput {
  modelUsage?: Record<string, { contextWindow?: number }>
  _channelModelId?: string
  _channelProvider?: ProviderType
  _contextWindow?: number
  _contextWindowSource?: ContextWindowSource
}

export interface ResolvedSDKResultContextWindow {
  contextWindow: number
  source: ContextWindowSource
}

/**
 * 统一解析 SDK result 中代表当前会话的上下文窗口。
 *
 * 多模型调用取最大窗口；同值时保留更权威来源。result 未携带窗口时才按
 * 渠道模型名推断，避免 renderer、历史恢复和 automation 使用不同规则。
 */
export function resolveSDKResultContextWindow(
  result: SDKResultContextWindowInput,
): ResolvedSDKResultContextWindow | undefined {
  // 主进程持久化的本轮直接值最权威，也覆盖 Pi result 不生成 modelUsage 的场景。
  if (result._contextWindow != null) {
    return {
      contextWindow: result._contextWindow,
      source: result._contextWindowSource ?? 'runtime',
    }
  }

  const entries = result.modelUsage ? Object.entries(result.modelUsage) : []
  const mainModelEntry = result._channelModelId
    ? entries.find(([modelId]) => modelId.toLowerCase() === result._channelModelId?.toLowerCase())
    : undefined
  if (mainModelEntry) {
    const [modelId, info] = mainModelEntry
    const contextWindow = info?.contextWindow ?? (result._channelProvider
      ? inferAgentSdkContextWindow(modelId, result._channelProvider)
      : inferContextWindow(modelId))
    if (contextWindow != null) {
      return {
        contextWindow,
        source: info?.contextWindow == null ? 'name_fallback' : result._contextWindowSource ?? 'runtime',
      }
    }
  }

  // 缺少主模型标识时，只在 SDK 明确上报的 entry 中取最大值；名称 fallback 不能
  // 仅因数值更大而覆盖另一个模型的明确 runtime/catalog 值。
  let reported: ResolvedSDKResultContextWindow | undefined
  for (const [, info] of entries) {
    if (info?.contextWindow == null) continue
    const source = result._contextWindowSource ?? 'runtime'
    if (
      reported == null
      || info.contextWindow > reported.contextWindow
      || (
        info.contextWindow === reported.contextWindow
        && CONTEXT_WINDOW_SOURCE_PRIORITY[source] > CONTEXT_WINDOW_SOURCE_PRIORITY[reported.source]
      )
    ) {
      reported = { contextWindow: info.contextWindow, source }
    }
  }
  if (reported) return reported

  const contextWindow = result._channelProvider
    ? inferAgentSdkContextWindow(result._channelModelId, result._channelProvider)
    : inferContextWindow(result._channelModelId)
  return contextWindow == null
    ? undefined
    : { contextWindow, source: 'name_fallback' }
}

/**
 * 为 GPT-5.x 模型返回保守的名称推断窗口。
 *
 * 这里只作为 provider catalog / runtime 没有窗口信息时的 fallback。不同渠道即使
 * 使用同名模型，也可能拥有不同限制，因此调用方不得用该推断值覆盖目录或运行时值。
 */
export function inferCodexAlignedGPT5ContextWindow(modelId: string | undefined): number | undefined {
  const model = modelId?.toLowerCase().replace(/\[1m\]$/i, '')
  switch (model) {
    case 'gpt-5.4-mini': return CODEX_GPT_54_MINI_CONTEXT_WINDOW
    case 'gpt-5.4':
    case 'gpt-5.5': return CODEX_GPT_54_55_CONTEXT_WINDOW
    case 'gpt-5.6':
    case 'gpt-5.6-sol':
    case 'gpt-5.6-terra':
    case 'gpt-5.6-luna': return CODEX_GPT_56_CONTEXT_WINDOW
    default: return undefined
  }
}

/** 已确认支持 1M 上下文的模型家族。 */
const AGENT_SDK_1M_CONTEXT_RULES = {
  // Claude 系列
  claude: [
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-fable-5',
  ],
  // DeepSeek
  deepseek: ['deepseek-v4'],
  // 智谱 GLM
  glm: ['glm-5.2'],
  // 小米 MiMo
  mimo: ['mimo-v2.5'],
  // MiniMax
  minimax: ['minimax-m3'],
  // Kimi
  kimi: ['k3'],
  // 通义千问
  qwen: [
    'qwen3.8',
    'qwen3.7',
    'qwen3.6-plus',
    'qwen3.6-flash',
    'qwen3.5-plus',
    'qwen3.5-flash',
    'qwen3-coder-plus',
  ],
} as const

const AGENT_SDK_1M_CONTEXT_DISPLAY_RULES = Object.values(AGENT_SDK_1M_CONTEXT_RULES).flat()
const EXACT_CONTEXT_RULES = new Set(['k3', 'kimi-k3'])

function matchesContextRule(model: string, pattern: string): boolean {
  if (EXACT_CONTEXT_RULES.has(pattern)) {
    return model === pattern || model.startsWith(`${pattern}[`)
  }
  return model.includes(pattern)
}

/**
 * 上下文窗口配置表。已确认 1M 能力的模型加在上方规则中并自动复用。
 *
 * 匹配规则：modelId.toLowerCase() 包含 pattern 即命中（substring match）。
 * exclude 列表优先级最高：命中 exclude 的模型始终返回 DEFAULT_CONTEXT_WINDOW。
 *
 * 参考：https://docs.anthropic.com/en/docs/build-with-claude/context-windows
 */
const CONTEXT_WINDOW_CONFIG = {
  /** 始终使用默认窗口的模型特征（优先级高于 rules） */
  exclude: ['haiku'],

  /** 1M 上下文模型匹配规则 */
  rules: [
    ...AGENT_SDK_1M_CONTEXT_DISPLAY_RULES,
    // OpenAI 协议渠道（如 OpenCode Go）使用该真实模型 ID。
    'kimi-k3',
    // 已废弃的 MiMo V2 Pro 仅保留历史显示推断，不主动启用 SDK 1M 变体
    'mimo-v2-pro',
  ] as const,
} as const

/**
 * 判断模型是否支持 1M context window（现为各模型默认能力，无需 beta header）。
 */
export function supports1MContext(modelId: string): boolean {
  if (!modelId) return false
  const m = modelId.toLowerCase()
  if (CONTEXT_WINDOW_CONFIG.exclude.some((p) => m.includes(p))) return false
  return CONTEXT_WINDOW_CONFIG.rules.some((p) => matchesContextRule(m, p))
}

/**
 * 按模型名推断 contextWindow（token 数）。
 *
 * SDK 流式过程中不返回此字段，只有 result 消息的 modelUsage 才带（且部分渠道不返回）。
 * 本函数提供一个按模型家族的 fallback，保证进度环永远有分母可用。
 */
export function inferContextWindow(model?: string): number | undefined {
  if (!model) return undefined
  const codexAlignedWindow = inferCodexAlignedGPT5ContextWindow(model)
  if (codexAlignedWindow !== undefined) return codexAlignedWindow
  if (supports1MContext(model)) return ONE_MILLION_CONTEXT_WINDOW
  return DEFAULT_CONTEXT_WINDOW
}

/** 按 Agent 运行时使用的模型名推断 contextWindow。保留函数名以兼容既有内部协议。 */
export function inferAgentSdkContextWindow(modelId: string | undefined, _provider: ProviderType): number | undefined {
  return inferContextWindow(modelId)
}
