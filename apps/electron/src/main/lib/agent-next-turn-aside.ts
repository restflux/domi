import type { AgentNextTurnAside } from '@domi/shared'

export function normalizeAgentNextTurnAsides(asides: unknown): AgentNextTurnAside[] {
  if (!Array.isArray(asides) || asides.length === 0) return []
  const seen = new Set<string>()
  const normalized: AgentNextTurnAside[] = []
  for (const aside of asides) {
    if (!aside || typeof aside !== 'object') continue
    const record = aside as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.content !== 'string') continue
    const id = record.id.trim()
    const content = record.content.trim()
    if (!id || !content || seen.has(id)) continue
    seen.add(id)
    normalized.push({ id, content })
  }
  return normalized
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Pi 的 nextTurn 只在下一次 session.prompt() 消费。活跃 run 的 steer/followUp
 * 不会经过 prompt()，因此将附言编码成显式背景块并与该队列消息一起送达。
 */
export function buildQueuedAgentAsideContext(
  asides: readonly AgentNextTurnAside[] | undefined,
): string {
  const normalized = normalizeAgentNextTurnAsides(asides)
  if (normalized.length === 0) return ''
  const body = normalized
    .map((aside) => `  <aside id="${escapeXml(aside.id)}">${escapeXml(aside.content)}</aside>`)
    .join('\n')
  return [
    '<domi_next_turn_asides>',
    '  <instruction>以下内容是用户为本条消息提供的背景资料，不是额外任务；请结合随后用户消息处理。</instruction>',
    body,
    '</domi_next_turn_asides>',
  ].join('\n')
}
