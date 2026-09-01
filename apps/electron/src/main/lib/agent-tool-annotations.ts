export interface AgentToolAnnotations {
  /** MCP-compatible hint: invoking the tool does not modify state. */
  readOnlyHint?: boolean
  /** MCP-compatible hint: invoking the tool may perform destructive updates. */
  destructiveHint?: boolean
  /** MCP-compatible hint: repeated calls with the same input have no additional effect. */
  idempotentHint?: boolean
  /** MCP-compatible hint: the tool may interact with an open-ended external environment. */
  openWorldHint?: boolean
}

export type AgentToolAnnotationsMap = Record<string, AgentToolAnnotations>

/**
 * Normalize untrusted tool metadata to the small boolean-only capability surface
 * consumed by Domi's final authorization layer.
 */
export function normalizeAgentToolAnnotations(value: unknown): AgentToolAnnotations | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const annotations: AgentToolAnnotations = {}
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof source[key] === 'boolean') annotations[key] = source[key]
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined
}
