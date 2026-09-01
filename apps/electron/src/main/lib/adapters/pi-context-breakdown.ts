import type { AgentContextBreakdown } from '@domi/shared'
import { estimateTokenCount } from '../agent-tool-token-estimator'

const SKILL_CATALOG_MARKER = '\n\nThe following skills provide specialized instructions for specific tasks.'
const SKILL_CATALOG_END = '</available_skills>'
const EXPANDED_SKILL_PATTERN = /<skill\b[\s\S]*?<\/skill>\s*/gi

interface PiContextBreakdownInput {
  systemPrompt: string
  messages: readonly unknown[]
  tools: readonly unknown[]
  toolSources?: Record<string, string | undefined>
  estimateMessageTokens?: (message: unknown) => number
  capturedAt?: number
}

function splitSkillCatalog(systemPrompt: string): { systemPrompt: string; skillCatalog: string } {
  const listIndex = systemPrompt.indexOf('<available_skills>')
  if (listIndex < 0) return { systemPrompt, skillCatalog: '' }
  const markerIndex = systemPrompt.lastIndexOf(SKILL_CATALOG_MARKER, listIndex)
  const catalogStart = markerIndex >= 0 ? markerIndex : listIndex
  const endIndex = systemPrompt.indexOf(SKILL_CATALOG_END, listIndex)
  if (endIndex < 0) return { systemPrompt, skillCatalog: '' }
  const catalogEnd = endIndex + SKILL_CATALOG_END.length
  return {
    systemPrompt: `${systemPrompt.slice(0, catalogStart)}${systemPrompt.slice(catalogEnd)}`,
    skillCatalog: systemPrompt.slice(catalogStart, catalogEnd),
  }
}

function stripExpandedSkills(text: string): { text: string; skillText: string } {
  const skillBlocks: string[] = []
  const remaining = text.replace(EXPANDED_SKILL_PATTERN, (block) => {
    skillBlocks.push(block)
    return ''
  })
  return { text: remaining, skillText: skillBlocks.join('\n') }
}

function splitMessageSkills(message: unknown): { message: unknown; skillText: string } {
  if (!message || typeof message !== 'object') return { message, skillText: '' }
  const record = message as Record<string, unknown>
  if (record.role !== 'user') return { message, skillText: '' }

  if (typeof record.content === 'string') {
    const split = stripExpandedSkills(record.content)
    return { message: { ...record, content: split.text }, skillText: split.skillText }
  }
  if (!Array.isArray(record.content)) return { message, skillText: '' }

  const skillBlocks: string[] = []
  const content = record.content.map((block) => {
    if (!block || typeof block !== 'object') return block
    const contentBlock = block as Record<string, unknown>
    if (contentBlock.type !== 'text' || typeof contentBlock.text !== 'string') return block
    const split = stripExpandedSkills(contentBlock.text)
    if (split.skillText) skillBlocks.push(split.skillText)
    return { ...contentBlock, text: split.text }
  })
  return {
    message: { ...record, content },
    skillText: skillBlocks.join('\n'),
  }
}

function sanitizeForEstimate(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => sanitizeForEstimate(item, seen))
  const record = value as Record<string, unknown>
  if (record.type === 'image') {
    return { ...record, data: '[image]', content: '[image]', source: '[image]' }
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    key === 'data' && typeof child === 'string' && child.length > 1_000
      ? '[binary]'
      : sanitizeForEstimate(child, seen),
  ]))
}

function estimateMessage(message: unknown, estimator?: (message: unknown) => number): number {
  if (estimator) {
    try {
      return Math.max(0, estimator(message))
    } catch {
      // 第三方 message 形状不受 Domi 控制；失败时回退到安全字符估算。
    }
  }
  try {
    return estimateTokenCount(JSON.stringify(sanitizeForEstimate(message)))
  } catch {
    return 0
  }
}

function toolName(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object') return undefined
  const name = (tool as Record<string, unknown>).name
  return typeof name === 'string' ? name : undefined
}

function estimateTool(tool: unknown): number {
  try {
    return estimateTokenCount(JSON.stringify(tool))
  } catch {
    return 0
  }
}

function isMcpTool(name: string | undefined, source: string | undefined): boolean {
  if (source) return source === 'mcp' || source === 'builtin-mcp'
  return name?.startsWith('mcp__') === true
}

/**
 * 按 Pi 实际 provider request 的 systemPrompt/messages/tools 结构估算上下文构成。
 * 这里只生成相对权重；renderer 会按供应商返回的真实 inputTokens 归一化展示。
 */
export function buildPiContextBreakdown({
  systemPrompt,
  messages,
  tools,
  toolSources,
  estimateMessageTokens,
  capturedAt = Date.now(),
}: PiContextBreakdownInput): AgentContextBreakdown {
  const splitPrompt = splitSkillCatalog(systemPrompt)
  let expandedSkillTokens = 0
  let conversation = 0
  for (const originalMessage of messages) {
    const split = splitMessageSkills(originalMessage)
    expandedSkillTokens += estimateTokenCount(split.skillText)
    conversation += estimateMessage(split.message, estimateMessageTokens)
  }

  let mcp = 0
  let productTools = 0
  for (const tool of tools) {
    const name = toolName(tool)
    const estimated = estimateTool(tool)
    if (isMcpTool(name, name ? toolSources?.[name] : undefined)) mcp += estimated
    else productTools += estimated
  }

  return {
    capturedAt,
    system: estimateTokenCount(splitPrompt.systemPrompt),
    skills: estimateTokenCount(splitPrompt.skillCatalog) + expandedSkillTokens,
    mcp,
    tools: productTools,
    conversation,
  }
}
