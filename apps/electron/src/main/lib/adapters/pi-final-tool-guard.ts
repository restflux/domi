import { isDeepStrictEqual } from 'node:util'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service.ts'
import type { PiRunAuditRecorder } from '../audit/pi-run-audit.ts'
import { isKnownValidationCommand } from '../execution-policy/shell-command-classifier.ts'
import { displayToolName, normalizePermissionInput } from './pi-message-adapter.ts'

export interface PiToolCallHookContext {
  toolCall: {
    id: string
    name: string
  }
  args: unknown
}

export interface PiToolCallHookResult {
  block?: boolean
  reason?: string
}

export type PiBeforeToolCallHook<TContext extends PiToolCallHookContext = PiToolCallHookContext> = (
  context: TContext,
  signal?: AbortSignal,
) => Promise<PiToolCallHookResult | undefined>

export interface PiFinalToolGuardSession<TContext extends PiToolCallHookContext = PiToolCallHookContext> {
  agent: {
    beforeToolCall?: PiBeforeToolCallHook<TContext>
  }
}

export interface PiFinalToolAuthorizationRequest {
  toolName: string
  input: Record<string, unknown>
  options: CanUseToolOptions
  cwd: string
}

export interface PiFinalToolGuardOptions {
  cwd: string
  authorize: (request: PiFinalToolAuthorizationRequest) => Promise<PermissionResult>
  resolveToolSource?: (toolName: string) => NonNullable<CanUseToolOptions['toolSource']>
  resolveToolAnnotations?: (toolName: string) => CanUseToolOptions['toolAnnotations']
  auditRecorder?: PiRunAuditRecorder
}

function recordInput(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 安装在 Pi session Agent 上的最终工具门禁。
 *
 * Hook 顺序由安装顺序明确组合：Pi Extension hook → CompactContext 单独调用门禁 → 本门禁。
 * 任一前置 hook block 后不会再请求授权。Pi 0.82.1 的 beforeToolCall 不能替换 args，
 * 因此授权适配器若返回不同 updatedInput 必须 fail closed。
 */
export function installPiFinalToolGuard<TContext extends PiToolCallHookContext>(
  session: PiFinalToolGuardSession<TContext>,
  options: PiFinalToolGuardOptions,
): void {
  const previousBeforeToolCall = session.agent.beforeToolCall
  session.agent.beforeToolCall = async (
    context: TContext,
    signal?: AbortSignal,
  ): Promise<PiToolCallHookResult | undefined> => {
    const previousResult = await previousBeforeToolCall?.(context, signal)
    if (previousResult?.block) return previousResult

    const rawInput = recordInput(context.args)
    if (!rawInput) {
      return { block: true, reason: '工具输入不是对象，Execution Policy 已保守拒绝' }
    }

    const input = normalizePermissionInput(context.toolCall.name, rawInput)
    const validation = context.toolCall.name === 'Bash'
      && typeof rawInput.command === 'string'
      && isKnownValidationCommand(rawInput.command)
    const timingMetadata = {
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      ...(validation && { validation: true as const }),
    }
    void options.auditRecorder?.record({ type: 'authorization_start', ...timingMetadata })
    const recordAuthorizationOutcome = (outcome: 'allow' | 'deny' | 'error'): void => {
      void options.auditRecorder?.record({ type: 'authorization_end', ...timingMetadata, outcome })
    }

    const effectiveSignal = signal ?? new AbortController().signal
    const toolAnnotations = options.resolveToolAnnotations?.(context.toolCall.name)
    let permission: PermissionResult
    try {
      permission = await options.authorize({
        toolName: displayToolName(context.toolCall.name, rawInput),
        input,
        cwd: options.cwd,
        options: {
          signal: effectiveSignal,
          toolUseID: context.toolCall.id,
          toolSource: options.resolveToolSource?.(context.toolCall.name) ?? 'host',
          ...(toolAnnotations && { toolAnnotations }),
        },
      })
    } catch (error) {
      recordAuthorizationOutcome('error')
      const message = error instanceof Error ? error.message : String(error)
      return { block: true, reason: `Execution Policy 评估失败，已保守拒绝: ${message}` }
    }

    if (permission.behavior === 'deny') {
      recordAuthorizationOutcome('deny')
      return { block: true, reason: permission.message }
    }
    if (permission.updatedInput !== undefined && !isDeepStrictEqual(permission.updatedInput, input)) {
      recordAuthorizationOutcome('deny')
      return { block: true, reason: 'Pi final tool guard 无法安全修改工具输入，已保守拒绝' }
    }
    recordAuthorizationOutcome('allow')
    return previousResult
  }
}
