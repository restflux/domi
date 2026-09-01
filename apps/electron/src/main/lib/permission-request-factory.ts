import { randomUUID } from 'node:crypto'
import type { DangerLevel, PermissionRequest } from '@domi/shared'
import type { CanUseToolOptions } from './agent-permission-types.ts'
import { normalizeAgentCommitMessage } from './agent-commit-message.ts'

function buildDescription(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return typeof input.command === 'string'
        ? `执行命令: ${input.command.slice(0, 200)}`
        : '执行 Bash 命令'
    case 'Write':
      return typeof input.file_path === 'string' ? `写入文件: ${input.file_path}` : '写入文件'
    case 'Edit':
      return typeof input.file_path === 'string' ? `编辑文件: ${input.file_path}` : '编辑文件'
    case 'NotebookEdit':
      return typeof input.notebook_path === 'string'
        ? `编辑 Notebook: ${input.notebook_path}`
        : '编辑 Notebook'
    case 'Task':
      return typeof input.description === 'string' ? `启动子任务: ${input.description}` : '启动子任务'
    case 'REPL':
      return typeof input.description === 'string' ? `执行 REPL: ${input.description}` : '执行 REPL 代码'
    case 'Workflow':
      return typeof input.name === 'string' ? `运行工作流: ${input.name}` : '运行工作流'
    case 'ScheduleWakeup':
      return typeof input.reason === 'string' ? `安排会话唤醒: ${input.reason}` : '安排会话唤醒'
    case 'Monitor':
      return typeof input.description === 'string' ? `启动监控任务: ${input.description}` : '启动监控任务'
    case 'PushNotification':
      return typeof input.message === 'string' ? `发送通知: ${input.message}` : '发送通知'
    default:
      return `使用工具: ${toolName}`
  }
}

export function buildPermissionRequest(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
  overrides: {
    dangerLevel?: DangerLevel
    allowAlways?: boolean
    sessionCapability?: PermissionRequest['sessionCapability']
  } = {},
): PermissionRequest {
  const toolInput = toolName === 'FinishWorktree' && typeof input.commitMessage === 'string'
    ? { ...input, commitMessage: normalizeAgentCommitMessage(input.commitMessage) }
    : input
  return {
    requestId: randomUUID(),
    createdAt: Date.now(),
    sessionId,
    toolName,
    toolInput,
    description: buildDescription(toolName, input),
    ...(toolName === 'Bash' && typeof input.command === 'string' && { command: input.command }),
    dangerLevel: overrides.dangerLevel ?? 'normal',
    ...(overrides.allowAlways !== undefined && { allowAlways: overrides.allowAlways }),
    ...(overrides.sessionCapability && { sessionCapability: overrides.sessionCapability }),
    decisionReason: options.decisionReason,
    decisionReasonType: options.decisionReasonType,
    classifierApprovable: options.classifierApprovable,
    policy: options.policy,
    sdkDisplayName: options.displayName,
    sdkTitle: options.title,
    sdkDescription: options.description,
  }
}

export function acceptBoundedProductInput(
  request: PermissionRequest,
  behavior: 'allow' | 'deny',
  updatedInput?: Record<string, unknown>,
): Record<string, unknown> {
  const retention = updatedInput?.retention
  const validRetention = retention === 'cleanup'
    || retention === 'retain_24h'
    || retention === 'retain_3d'
    || retention === 'retain_manual'
  const updatedKeys = updatedInput ? Object.keys(updatedInput) : []
  return behavior === 'allow'
    && request.toolName === 'FinishWorktree'
    && updatedInput
    && updatedKeys.length === 2
    && updatedKeys.every((key) => key === 'commitMessage' || key === 'retention')
    && typeof updatedInput.commitMessage === 'string'
    && updatedInput.commitMessage.trim().length > 0
    && updatedInput.commitMessage.length <= 500
    && validRetention
    ? { commitMessage: normalizeAgentCommitMessage(updatedInput.commitMessage), retention }
    : request.toolInput
}
