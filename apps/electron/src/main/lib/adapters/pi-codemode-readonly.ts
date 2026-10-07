import { Type } from 'typebox'
import { describeReadonlyCodemode } from './pi-codemode-description.ts'
import type { AgentSession, InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'

export const PI_READONLY_CODEMODE_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  memoryLimitBytes: 32 * 1024 * 1024,
  scriptChars: 64 * 1024,
  calls: 32,
  concurrency: 4,
  toolResultBytes: 64 * 1024,
  deliveredBytes: 64 * 1024,
})
const READONLY_NAMES = new Set(['read', 'grep', 'find'])

interface CodemodeRuntime {
  defineTool: typeof import('@earendil-works/pi-coding-agent').defineTool
  CodemodeSandbox?: typeof import('@earendil-works/pi-codemode').CodemodeSandbox
  renderToolSignature?: typeof import('@earendil-works/pi-codemode').renderToolSignature
}
interface CodemodeOptions { enabled?: boolean; tools: ToolDefinition[]; ownedTools: ToolDefinition[] }
interface ExecutionGuard { isProtected(definition: ToolDefinition): boolean }
export interface PiReadonlyCodemode {
  extensionFactories: InlineExtension[]
  initialize(session: AgentSession, guard: ExecutionGuard): void
  isOwnedTool(session: AgentSession, name: string): boolean
}

/** 会话显式opt-in；目录/执行按宿主持有的定义对象限制，不依赖名称或annotations授信。 */
export function preparePiReadonlyCodemode(runtime: CodemodeRuntime, options: CodemodeOptions): PiReadonlyCodemode {
  let session: AgentSession | undefined
  let guard: ExecutionGuard | undefined
  let ownedDefinition: object | undefined
  const owned = options.ownedTools.filter(definition => READONLY_NAMES.has(definition.name) && options.tools.includes(definition))
  const enabled = options.enabled === true
  if (enabled && (owned.length === 0 || options.tools.some(tool => tool.name === 'codemode'))) {
    throw new Error('Codemode只读目录为空或保留工具名称冲突')
  }
  const assertOwned = (definition: ToolDefinition): void => {
    if (!session || session.getToolDefinition(definition.name) !== definition || !guard?.isProtected(definition)) {
      throw new Error('Codemode只读定义的身份或最终执行门禁无法核验')
    }
  }
  const isOwnedTool = (current: AgentSession, name: string): boolean => enabled && name === 'codemode'
    && ownedDefinition !== undefined && current.getToolDefinition(name) === ownedDefinition

  const extensionFactories: InlineExtension[] = enabled ? [{
    name: 'domi-readonly-codemode', hidden: true,
    factory(pi) {
      const Sandbox = runtime.CodemodeSandbox
      const renderSignature = runtime.renderToolSignature
      if (!Sandbox || !renderSignature) throw new Error('Codemode原生Sandbox或工具声明尚未加载')
      const description = describeReadonlyCodemode(owned, renderSignature, PI_READONLY_CODEMODE_LIMITS)
      const definition = runtime.defineTool({
        name: 'codemode', label: 'codemode', exposure: 'model-only', defaultActive: true,
        description,
        parameters: Type.Object({ code: Type.String({ maxLength: PI_READONLY_CODEMODE_LIMITS.scriptChars,
          description: '只读JavaScript；通过tools调用目录中的工具并返回简短汇总' }) }),
        async execute(_id, { code }, signal, _update, ctx) {
          if (!ctx || !session || !guard) throw new Error('Codemode尚未完成宿主安全初始化')
          for (const definition of owned) assertOwned(definition)
          const budget = new AbortController()
          const scopeSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal
          let calls = 0
          let concurrent = 0
          const sandbox = new Sandbox({
            timeoutMs: PI_READONLY_CODEMODE_LIMITS.timeoutMs,
            memoryLimitBytes: PI_READONLY_CODEMODE_LIMITS.memoryLimitBytes,
            tools: owned.map(definition => ({
              name: definition.name, description: definition.description,
              inputSchema: Object.fromEntries<unknown>(Object.entries(definition.parameters)),
              outputSchema: { type: 'string' },
              async execute(args, child) {
                assertOwned(definition)
                if (child.signal.aborted || scopeSignal.aborted) throw new Error('Codemode子调用已取消')
                if (++calls > PI_READONLY_CODEMODE_LIMITS.calls || concurrent >= PI_READONLY_CODEMODE_LIMITS.concurrency) {
                  budget.abort()
                  throw new Error('Codemode调用或并发预算超限')
                }
                concurrent++
                try {
                  // 只使用公开pipeline；定义包装取得真实child signal并单独最终授权。
                  const outcome = await ctx.executeTool(definition.name, args, { signal: child.signal })
                  if (outcome.isError) throw new Error('只读子调用失败或被拒绝')
                  assertOwned(definition)
                  if (outcome.result.content.some(block => block.type !== 'text')) throw new Error('Codemode仅接收文本子结果')
                  const text = outcome.result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
                  if (Buffer.byteLength(text) > PI_READONLY_CODEMODE_LIMITS.toolResultBytes) {
                    budget.abort()
                    throw new Error('Codemode子结果超过文本预算')
                  }
                  return text
                } finally { concurrent-- }
              },
            })),
          })
          try {
            // 不解析模型@options，不forward store，也不写截断/图片临时文件。
            const result = await sandbox.execute(code, { signal: scopeSignal, timeoutMs: PI_READONLY_CODEMODE_LIMITS.timeoutMs })
            if (result.output.some(item => item.type !== 'text')) throw new Error('Codemode仅交付文本输出')
            const payload = result.ok
              ? { ok: true, value: result.value, output: result.output, calls: result.calls }
              : { ok: false, error: { kind: result.error.kind, message: result.error.message }, output: [], calls: result.calls }
            const text = JSON.stringify(payload)
            if (Buffer.byteLength(text) > PI_READONLY_CODEMODE_LIMITS.deliveredBytes) throw new Error('Codemode交付输出超过文本预算')
            return { content: [{ type: 'text' as const, text }], details: {}, isError: !result.ok }
          } finally { budget.abort(); await sandbox.close() }
        },
      })
      ownedDefinition = definition
      pi.registerTool(definition)
    },
  }] : []
  return {
    extensionFactories, isOwnedTool,
    initialize(current, currentGuard) {
      if (!enabled) return
      if (!isOwnedTool(current, 'codemode')) throw new Error('Codemode保留工具归属冲突')
      session = current
      guard = currentGuard
      for (const definition of owned) assertOwned(definition)
      current.setActiveToolsByName([...new Set([...current.getActiveToolNames(), 'codemode'])])
    },
  }
}
