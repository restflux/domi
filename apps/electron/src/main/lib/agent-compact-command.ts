export interface AgentCompactCommand {
  matched: boolean
  instructions?: string
}

const COMPACT_COMMAND = '/compact'

/**
 * Parse the explicit /compact control command without treating similarly named
 * commands (for example, /compactness) as compaction requests.
 *
 * The command name is intentionally case-sensitive. Whitespace surrounding the
 * complete input and the instruction body is ignored, while whitespace inside
 * a multi-line instruction is preserved.
 */
export function parseAgentCompactCommand(text: string): AgentCompactCommand {
  const normalized = text.trim()
  if (normalized === COMPACT_COMMAND) return { matched: true }

  if (!normalized.startsWith(COMPACT_COMMAND)) return { matched: false }

  const delimiter = normalized[COMPACT_COMMAND.length]
  if (delimiter == null || !/\s/u.test(delimiter)) return { matched: false }

  const instructions = normalized.slice(COMPACT_COMMAND.length).trim()
  return instructions.length > 0
    ? { matched: true, instructions }
    : { matched: true }
}

/** Node-free predicate for consumers that only need command recognition. */
export function isAgentCompactCommand(text: string): boolean {
  return parseAgentCompactCommand(text).matched
}
