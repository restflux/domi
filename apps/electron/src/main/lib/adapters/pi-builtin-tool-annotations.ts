import type { AgentToolAnnotationsMap } from '../agent-tool-annotations.ts'

const PI_BUILTIN_READ_ONLY_TOOL_NAMES = new Set([
  'WebSearch',
  'WebFetch',
  'mcp__automation__list_automations',
  'mcp__automation__get_automation',
  'mcp__planning__list_todos',
  'mcp__planning__get_todo',
  'mcp__planning__list_calendar_events',
  'mcp__planning__get_calendar_event',
  'mcp__planning__list_groups',
  'mcp__planning__list_tags',
  'mcp__planning__list_active_reminders',
  'mcp__collaboration__list_available_agent_models',
  'mcp__collaboration__wait_for_delegations',
  'mcp__collaboration__list_delegations',
  'mcp__collaboration__get_delegation_results',
  // 会话内可见进度只更新 Domi 的运行状态，不写项目、Local 或用户规划数据。
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TodoRead',
  'TerminalList',
  'TerminalRead',
])

export function buildPiBuiltinToolAnnotations(toolNames: readonly string[]): AgentToolAnnotationsMap {
  const annotations: AgentToolAnnotationsMap = {}
  for (const toolName of toolNames) {
    if (toolName === 'VisionRelay') {
      annotations[toolName] = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    } else if (toolName === 'TerminalInterrupt') {
      annotations[toolName] = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    } else if (toolName === 'TerminalClose') {
      annotations[toolName] = { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    } else if (toolName === 'mcp__gpt_image__imagegen' || toolName === 'mcp__nano_banana__generate_image') {
      annotations[toolName] = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    } else if (toolName === 'BrowserSnapshot' || toolName === 'BrowserExtract') {
      annotations[toolName] = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    } else if (toolName === 'BrowserClick' || toolName === 'BrowserType') {
      annotations[toolName] = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    } else if (toolName.startsWith('Browser')) {
      annotations[toolName] = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    } else if (toolName === 'PlanFocusedValidation') {
      annotations[toolName] = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    } else if (toolName === 'RequestNextWorktreeIteration' || toolName === 'RequestWorktreePreviewRevision') {
      annotations[toolName] = { readOnlyHint: true, destructiveHint: false, idempotentHint: false }
    } else if (toolName === 'ReadyForReview') {
      annotations[toolName] = { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    } else if (toolName === 'ApplyWorktree' || toolName === 'FinishWorktree' || toolName === 'RequestLocalMaintenance' || toolName === 'RequestGitPushSessionTrust' || toolName === 'GitPushWithSessionTrust') {
      annotations[toolName] = { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    } else if (toolName === 'LocalMaintenanceStatus') {
      annotations[toolName] = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    } else if (toolName.startsWith('LocalMaintenance') || toolName === 'CompleteLocalMaintenance') {
      annotations[toolName] = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    } else if (PI_BUILTIN_READ_ONLY_TOOL_NAMES.has(toolName)) {
      annotations[toolName] = { readOnlyHint: true }
    }
  }
  return annotations
}
