const COUNTERS = ['eventCount', 'textDeltaChars', 'itemDoneTextChars', 'terminalTextChars', 'recoveredTextBlocks', 'parsedTextChars'] as const

export interface PiResponsesDiagnostics {
  eventCount: number
  textDeltaChars: number
  itemDoneTextChars: number
  terminalTextChars: number
  recoveredTextBlocks: number
  parsedTextChars: number
}

/** SDK patch 的诊断字段只按固定白名单投影，严禁透传正文或任意附加字段。 */
export function readPiResponsesDiagnostics(message: unknown): PiResponsesDiagnostics | undefined {
  if (!message || typeof message !== 'object') return undefined
  const raw = (message as Record<string, unknown>).domiResponsesDiagnostics
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const result = {} as PiResponsesDiagnostics
  for (const key of COUNTERS) {
    const value = record[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
    result[key] = value
  }
  return result
}
