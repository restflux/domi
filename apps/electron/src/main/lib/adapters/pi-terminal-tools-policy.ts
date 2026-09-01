export function shouldExposeTerminalTools(input: {
  triggeredBy?: 'user' | 'automation' | 'delegation'
  sourceAutomationId?: string
  sourceDelegationId?: string
}): boolean {
  return input.triggeredBy === 'user' && !input.sourceAutomationId && !input.sourceDelegationId
}
