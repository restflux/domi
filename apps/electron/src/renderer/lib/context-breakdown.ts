import type { AgentContextBreakdown } from '@domi/shared'

export type ContextBreakdownKey = Exclude<keyof AgentContextBreakdown, 'capturedAt'>

export interface NormalizedContextBreakdownItem {
  key: ContextBreakdownKey
  label: string
  tokens: number
  ratio: number
}

const CONTEXT_BREAKDOWN_LABELS: Record<ContextBreakdownKey, string> = {
  system: '系统提示词',
  skills: 'Skills',
  mcp: 'MCP',
  tools: '内置工具',
  conversation: '对话历史',
}

const CONTEXT_BREAKDOWN_ORDER: ContextBreakdownKey[] = [
  'system',
  'skills',
  'mcp',
  'tools',
  'conversation',
]

/**
 * 供应商只返回总输入 Token，不返回逐来源明细。这里保留请求结构的估算比例，
 * 再用最大余数法归一化到真实 inputTokens，确保分类之和与当前上下文占用一致。
 */
export function normalizeContextBreakdown(
  breakdown: AgentContextBreakdown | undefined,
  inputTokens: number | undefined,
): NormalizedContextBreakdownItem[] | undefined {
  if (!breakdown || inputTokens == null || !Number.isFinite(inputTokens) || inputTokens <= 0) return undefined

  const weights = CONTEXT_BREAKDOWN_ORDER.map((key) => {
    const raw = breakdown[key]
    return Number.isFinite(raw) && raw > 0 ? raw : 0
  })
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  if (totalWeight <= 0) return undefined

  const allocations = weights.map((weight, index) => {
    const exact = (weight / totalWeight) * inputTokens
    return { index, floor: Math.floor(exact), fraction: exact - Math.floor(exact) }
  })
  let remainder = inputTokens - allocations.reduce((sum, item) => sum + item.floor, 0)
  const remainderOrder = [...allocations].sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let index = 0; remainder > 0; index = (index + 1) % remainderOrder.length) {
    remainderOrder[index]!.floor += 1
    remainder -= 1
  }

  return CONTEXT_BREAKDOWN_ORDER.map((key, index) => {
    const tokens = allocations[index]!.floor
    return { key, label: CONTEXT_BREAKDOWN_LABELS[key], tokens, ratio: tokens / inputTokens }
  }).sort((a, b) => b.tokens - a.tokens || CONTEXT_BREAKDOWN_ORDER.indexOf(a.key) - CONTEXT_BREAKDOWN_ORDER.indexOf(b.key))
}
