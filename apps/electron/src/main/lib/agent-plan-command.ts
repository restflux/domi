import type { AgentWorkflow } from '@domi/shared'

export type AgentPlanCommand =
  | { matched: false }
  | { matched: true; task?: string; promptMessage: string }

const PLAN_COMMAND_PATTERN = /^\/plan(?=$|\s)([\s\S]*)$/u
const LEADING_USER_CONTEXT_BLOCK_PATTERN = /^\s*<(attached_files|quoted_file|quoted_context)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/u

/**
 * 识别用户正文开头的 `/plan`，同时保留 AgentView 在正文前附加的附件/引用协议块。
 * transcript 仍保存原始命令；promptMessage 只移除可见命令标记，避免模型把 `/plan`
 * 当作普通任务文本。命令必须位于真实用户正文开头，不能从引用或附件内容中触发。
 */
export function parseAgentPlanCommand(text: string): AgentPlanCommand {
  let bodyOffset = 0
  let remaining = text
  while (true) {
    const match = remaining.match(LEADING_USER_CONTEXT_BLOCK_PATTERN)
    if (!match) break
    bodyOffset += match[0].length
    remaining = remaining.slice(match[0].length)
  }

  const leadingWhitespace = remaining.match(/^\s*/u)?.[0] ?? ''
  const commandStart = bodyOffset + leadingWhitespace.length
  const commandText = text.slice(commandStart)
  const match = commandText.match(PLAN_COMMAND_PATTERN)
  if (!match) return { matched: false }

  const task = match[1]?.trim()
  const promptTask = task || '用户输入了 /plan，但没有提供要规划的具体任务。请简短提示用户在 /plan 后补充任务；不要提交空计划。'
  return {
    matched: true,
    ...(task ? { task } : {}),
    promptMessage: `${text.slice(0, commandStart)}${promptTask}`,
  }
}

/** `/plan` 只覆盖当前 run；持久 workflow 继续保持研究或执行。 */
export function isAgentPlanCommand(text: string): boolean {
  return parseAgentPlanCommand(text).matched
}

/** `/plan` 必须创建独立 run，不能作为 steering/follow-up 混入已有任务。 */
export function assertAgentPlanCommandMayBeQueued(text: string): void {
  if (isAgentPlanCommand(text)) {
    throw new Error('/plan 只能在会话空闲时启动新任务，请等待当前任务结束后发送')
  }
}

export function resolveAgentPlanCommandWorkflow(
  requestedWorkflow: AgentWorkflow,
  planCommand: boolean,
): { runWorkflow: AgentWorkflow; persistentWorkflow: Exclude<AgentWorkflow, 'plan-first'> } {
  const persistentWorkflow = requestedWorkflow === 'plan-first' ? 'read-only' : requestedWorkflow
  return {
    runWorkflow: planCommand ? 'plan-first' : persistentWorkflow,
    persistentWorkflow,
  }
}
