import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionEvent, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service.ts'
import type { PiRunAuditRecorder } from '../audit/pi-run-audit.ts'
import { isKnownValidationCommand } from '../execution-policy/shell-command-classifier.ts'
import { displayToolName, normalizePermissionInput } from './pi-message-adapter.ts'
import { bindPiToolDefinitionGuard, canBindPiToolDefinitionGuard, isPiToolDefinitionGuardCurrent } from './pi-tool-definition-guard.ts'

export interface PiToolCallHookContext {
  toolCall: { id: string; name: string }
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
  agent: { beforeToolCall?: PiBeforeToolCallHook<TContext> }
  sessionManager?: ExtensionContext['sessionManager']
  getAllTools?: () => ReadonlyArray<{ name: string }>
  getToolDefinition?: (name: string) => ToolDefinition | undefined
  subscribe?: (listener: (event: AgentSessionEvent) => void) => () => void
  dispose?: () => void
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
  /** 使用公开Pi校验函数投影调用开始时的输入，不能自行复制SDK校验规则。 */
  validateArguments?: (definition: ToolDefinition, args: unknown) => unknown
}

function recordInput(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 不依赖权限UI是否消费signal；晚到的allow不能恢复已取消的调用。 */
async function cancellablePermission(
  request: PiFinalToolAuthorizationRequest,
  authorize: PiFinalToolGuardOptions['authorize'],
): Promise<PermissionResult> {
  const signal = request.options.signal ?? new AbortController().signal
  if (signal.aborted) return { behavior: 'deny', message: '工具调用已取消' }
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<PermissionResult>(resolve => {
    onAbort = () => resolve({ behavior: 'deny', message: '工具调用已取消' })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([authorize(request), cancelled]) }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
}

interface ExecutionIdentity {
  args: unknown
  name: string
  definition: ToolDefinition | undefined
  parentToolCallId?: string
}

interface AuthorizedExecution {
  definition: ToolDefinition
  args: unknown
  signal?: AbortSignal
}

/**
 * 同一个最终授权owner。直接调用在现有前置链审批，公开定义执行边界只消费一次许可；
 * 嵌套调用在Pi完成校验/扩展hooks后独立审批，并使用SDK传入的真实调用级signal。
 * 定义包装只由Pi pipeline调用，不替代ctx.executeTool或SDK的校验/调度算法。
 */
export function installPiFinalToolGuard<TContext extends PiToolCallHookContext>(
  session: PiFinalToolGuardSession<TContext>,
  options: PiFinalToolGuardOptions,
): { dispose(): void; isProtected(definition: ToolDefinition): boolean } {
  const authorized = new Map<string, AuthorizedExecution>()
  const executing = new Map<string, ExecutionIdentity>()
  const protectedDefinitions = new Set<ToolDefinition>()
  const releases: Array<() => void> = []
  const lifecycle = new AbortController()
  let disposed = false

  const authorizeCall = async (
    context: PiToolCallHookContext,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
  ): Promise<PiToolCallHookResult | undefined> => {
    if (disposed || signal?.aborted) return { block: true, reason: '工具调用已取消' }
    const rawInput = recordInput(context.args)
    if (!rawInput) return { block: true, reason: '工具输入不是对象，Execution Policy 已保守拒绝' }
    let snapshot: Record<string, unknown>
    try { snapshot = structuredClone(rawInput) }
    catch { return { block: true, reason: '无法安全核验工具输入，已保守拒绝' } }
    const input = normalizePermissionInput(context.toolCall.name, structuredClone(snapshot))
    const inputSnapshot = structuredClone(input)
    const validation = context.toolCall.name === 'Bash'
      && typeof rawInput.command === 'string' && isKnownValidationCommand(rawInput.command)
    const timingMetadata = {
      toolCallId: context.toolCall.id,
      ...(executing.get(context.toolCall.id)?.parentToolCallId && {
        parentToolCallId: executing.get(context.toolCall.id)?.parentToolCallId,
      }),
      toolName: context.toolCall.name,
      ...(validation && { validation: true as const }),
    }
    void options.auditRecorder?.record({ type: 'authorization_start', ...timingMetadata })
    const recordOutcome = (outcome: 'allow' | 'deny' | 'error'): void => {
      void options.auditRecorder?.record({ type: 'authorization_end', ...timingMetadata, outcome })
    }
    const toolAnnotations = options.resolveToolAnnotations?.(context.toolCall.name)
    let permission: PermissionResult
    try {
      permission = await cancellablePermission({
        toolName: displayToolName(context.toolCall.name, rawInput), input, cwd: options.cwd,
        options: {
          signal: signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal,
          toolUseID: context.toolCall.id,
          toolSource: options.resolveToolSource?.(context.toolCall.name) ?? 'host',
          ...(toolAnnotations && { toolAnnotations }),
        },
      }, options.authorize)
    } catch (error) {
      recordOutcome('error')
      return { block: true, reason: `Execution Policy 评估失败，已保守拒绝: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (permission.behavior === 'deny') {
      recordOutcome('deny')
      return { block: true, reason: permission.message }
    }
    if (disposed || signal?.aborted || !isCurrent() || !isDeepStrictEqual(rawInput, snapshot)
      || !isDeepStrictEqual(input, inputSnapshot)
      || (permission.updatedInput !== undefined && !isDeepStrictEqual(permission.updatedInput, inputSnapshot))) {
      recordOutcome('deny')
      return { block: true, reason: 'Pi final tool guard 无法安全修改工具输入、继续已取消调用或使用已变化的定义，已保守拒绝' }
    }
    recordOutcome('allow')
    return undefined
  }

  const previousBeforeToolCall = session.agent.beforeToolCall
  session.agent.beforeToolCall = async (context, signal) => {
    let argsBeforeHooks: unknown
    try { argsBeforeHooks = structuredClone(context.args) }
    catch { return { block: true, reason: '工具输入无法安全核验，已保守拒绝' } }
    const previousResult = await previousBeforeToolCall?.(context, signal)
    if (previousResult?.block) return previousResult
    if (!isDeepStrictEqual(argsBeforeHooks, context.args)) {
      return { block: true, reason: '前置hook修改已校验的工具输入，已保守拒绝' }
    }
    const definition = session.getToolDefinition?.(context.toolCall.name)
    if (definition) protectDefinition(definition)
    const snapshot = definition && protectedDefinitions.has(definition) ? structuredClone(context.args) : undefined
    const result = await authorizeCall(context, signal, () => !definition || !protectedDefinitions.has(definition)
      || (session.getToolDefinition?.(context.toolCall.name) === definition && session.sessionManager !== undefined
        && isPiToolDefinitionGuardCurrent(definition, session.sessionManager)))
    if (result?.block) return result
    if (definition && protectedDefinitions.has(definition)) {
      if (session.getToolDefinition?.(context.toolCall.name) !== definition || !isDeepStrictEqual(snapshot, context.args)) {
        return { block: true, reason: '最终授权期间工具定义或输入发生变化，已保守拒绝' }
      }
      authorized.set(context.toolCall.id, { definition, args: snapshot, signal })
    }
    return previousResult
  }

  const unsubscribe = session.subscribe?.(event => {
    if (event.type === 'tool_execution_start') {
      const definition = session.getToolDefinition?.(event.toolName)
      if (definition) protectDefinition(definition)
      executing.set(event.toolCallId, {
        args: structuredClone(event.args),
        name: event.toolName,
        definition: session.getToolDefinition?.(event.toolName),
        ...(event.parentToolCallId && { parentToolCallId: event.parentToolCallId }),
      })
    } else if (event.type === 'tool_execution_end') {
      executing.delete(event.toolCallId)
      authorized.delete(event.toolCallId)
    } else if (event.type === 'agent_end') {
      executing.clear()
      authorized.clear()
    }
  })
  function protectDefinition(definition: ToolDefinition): void {
    const manager = session.sessionManager
    if (!manager || protectedDefinitions.has(definition) || !canBindPiToolDefinitionGuard(definition)) return
    const name = definition.name
    const release = bindPiToolDefinitionGuard(definition, manager, execute => async (id, args, signal, update, context) => {
      try {
        const identity = executing.get(id)
        const lease = authorized.get(id)
        if (disposed || signal?.aborted || !identity || identity.name !== name
          || identity.definition !== definition || session.getToolDefinition?.(name) !== definition
          || !isPiToolDefinitionGuardCurrent(definition, manager)) {
          throw new Error('工具调用身份或生命周期无法核验，已保守拒绝')
        }
        if (identity.parentToolCallId) {
          // prepareArguments可能有状态，不重放它；此类定义不能进入只读脚本。
          if (!definition.prepareArguments) {
            if (!options.validateArguments || !isDeepStrictEqual(options.validateArguments(definition, identity.args), args)) {
              throw new Error('前置hook修改已校验的工具输入，已保守拒绝')
            }
          }
          const result = await authorizeCall({ toolCall: { id, name }, args }, signal,
            () => executing.get(id) === identity && session.getToolDefinition?.(name) === definition
              && isPiToolDefinitionGuardCurrent(definition, manager))
          if (result?.block) throw new Error(result.reason)
        } else if (!lease || lease.definition !== definition || lease.signal?.aborted || !isDeepStrictEqual(lease.args, args)) {
          throw new Error('工具调用没有匹配的最终授权，已保守拒绝')
        }
        if (disposed || signal?.aborted || executing.get(id) !== identity
          || session.getToolDefinition?.(name) !== definition || !isPiToolDefinitionGuardCurrent(definition, manager)) {
          throw new Error('最终授权后工具调用已取消或身份发生变化')
        }
        return await execute(id, args, signal, update, context)
      } finally { authorized.delete(id) }
    })
    protectedDefinitions.add(definition)
    releases.push(release)
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    lifecycle.abort()
    unsubscribe?.()
    for (const release of releases) release()
    releases.length = 0
    authorized.clear()
    executing.clear()
  }
  try {
    for (const { name } of session.getAllTools?.() ?? []) {
      const definition = session.getToolDefinition?.(name)
      if (definition) protectDefinition(definition)
    }
  } catch (error) { dispose(); throw error }
  const disposeSession = session.dispose?.bind(session)
  if (disposeSession) session.dispose = () => { dispose(); disposeSession() }
  return { dispose, isProtected: definition => !definition.prepareArguments && options.validateArguments !== undefined
    && protectedDefinitions.has(definition) && session.sessionManager !== undefined
    && isPiToolDefinitionGuardCurrent(definition, session.sessionManager) }
}
