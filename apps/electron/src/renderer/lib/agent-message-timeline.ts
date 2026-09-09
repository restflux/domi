import type { SDKMessage } from '@domi/shared'

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/** 消息对象引用 → 稳定 key 缓存，避免内容相同的消息产生重复 key */
const stableKeyCache = new WeakMap<object, string>()
let stableKeyFallbackCounter = 0

export function getSDKMessageStableKey(message: SDKMessage): string {
  const record = message as Record<string, unknown>
  if (typeof record.uuid === 'string' && record.uuid.length > 0) {
    return `${message.type}:uuid:${record.uuid}`
  }

  // 已缓存的消息对象直接返回，保证跨渲染稳定
  if (stableKeyCache.has(message)) {
    return stableKeyCache.get(message)!
  }

  const parentToolUseId = typeof record.parent_tool_use_id === 'string'
    ? record.parent_tool_use_id
    : ''
  const sessionId = typeof record.session_id === 'string' ? record.session_id : ''

  let key: string

  if (message.type === 'result') {
    const result = record as { subtype?: unknown; terminal_reason?: unknown; result?: unknown }
    key = `result:${sessionId}:${String(result.subtype ?? '')}:${String(result.terminal_reason ?? '')}:${String(result.result ?? '')}:${++stableKeyFallbackCounter}`
  } else if (message.type === 'system') {
    const sys = record as { subtype?: unknown; task_id?: unknown; tool_use_id?: unknown }
    key = `system:${sessionId}:${String(sys.subtype ?? '')}:${String(sys.task_id ?? '')}:${String(sys.tool_use_id ?? '')}:${stableStringify(record)}:${++stableKeyFallbackCounter}`
  } else if ('message' in record) {
    const inner = record.message as { content?: unknown } | undefined
    key = `${message.type}:${sessionId}:${parentToolUseId}:${stableStringify(inner?.content)}:${++stableKeyFallbackCounter}`
  } else {
    key = `${message.type}:${sessionId}:${parentToolUseId}:${stableStringify(record)}:${++stableKeyFallbackCounter}`
  }

  stableKeyCache.set(message, key)
  return key
}

/** 按消息身份合并历史和实时帧；已保存的终态不能被迟到的 partial 覆盖。 */
export function mergeAgentMessageTimeline(persisted: readonly SDKMessage[], live: readonly SDKMessage[]): SDKMessage[] {
  const merged = [...persisted]
  const positions = new Map(merged.map((message, index) => [getSDKMessageStableKey(message), index]))
  for (const message of live) {
    const key = getSDKMessageStableKey(message)
    const index = positions.get(key)
    if (index === undefined) {
      positions.set(key, merged.length)
      merged.push(message)
    } else {
      const previous = merged[index] as SDKMessage & { _partial?: boolean }
      const incoming = message as SDKMessage & { _partial?: boolean }
      if (previous._partial === true || incoming._partial !== true) merged[index] = message
    }
  }
  return merged
}
