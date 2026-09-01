/**
 * 规范化 Agent 生成或用户在确认中编辑的最终 Commit Message。
 *
 * 该边界不尝试替 Agent 推断累计 diff 的语义，只移除重复堆叠产生的完全相同 bullet，
 * 并保留标题与 bullet 的原始顺序，使主要功能仍由上游累计总结规则决定。
 */
export function normalizeAgentCommitMessage(value: string): string {
  const lines = value.trim().replace(/\r\n?/g, '\n').split('\n')
  const seenBullets = new Set<string>()
  const normalized: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^-\s+\S/.test(trimmed)) {
      const bullet = trimmed.replace(/^-\s+/, '- ')
      if (seenBullets.has(bullet)) continue
      seenBullets.add(bullet)
      normalized.push(bullet)
      continue
    }
    normalized.push(line.trimEnd())
  }
  while (normalized.length > 0 && !normalized[0]?.trim()) normalized.shift()
  while (normalized.length > 0 && !normalized.at(-1)?.trim()) normalized.pop()
  return normalized.join('\n')
}
