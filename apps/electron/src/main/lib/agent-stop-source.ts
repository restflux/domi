export const AGENT_STOP_SOURCES = [
  'renderer-stop-control',
  'renderer-ask-user-dismiss',
  'renderer-plan-dismiss',
  'renderer-permission-dismiss',
  'renderer-queue-abort',
  'bridge-command',
  'feishu-command',
  'collaboration-timeout',
  'collaboration-user',
  'work-activity-panel',
  'session-tree-navigation',
  'unknown',
] as const

export type AgentStopSource = typeof AGENT_STOP_SOURCES[number]

export function normalizeAgentStopSource(value: unknown): AgentStopSource {
  return typeof value === 'string' && (AGENT_STOP_SOURCES as readonly string[]).includes(value)
    ? value as AgentStopSource
    : 'unknown'
}
