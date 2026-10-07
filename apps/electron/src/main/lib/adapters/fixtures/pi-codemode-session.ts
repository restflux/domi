import { createCodemodeExtension, defineTool } from '@earendil-works/pi-coding-agent'
import type { AgentSession, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { Type } from 'typebox'
import { discoverySession } from './pi-tool-discovery-session.ts'

export async function nativeCodemodeSession(options: Parameters<typeof discoverySession>[0]) {
  const runtime = await discoverySession({ ...options, enabled: false,
    factories: [createCodemodeExtension({ models: false, inlineBudget: 0 }), ...(options.factories ?? [])] })
  runtime.session.setActiveToolsByName([...runtime.session.getActiveToolNames(), 'codemode'])
  return runtime
}

export function codemodeCall(code: string, name = 'codemode') {
  // 只约束本地测试脚本；这是模型输入，不代表原生 factory 的宿主硬限制。
  return { name, arguments: { code: `// @options: {"timeout_ms":5000}\n${code}` } }
}

export function codemodeResults(session: AgentSession) {
  return session.agent.state.messages.filter(message => message.role === 'toolResult')
}

export function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }) {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * 仅测试公开 Sandbox 的有界执行能力，不是可接入生产的扩展。
 * executeTool 仍有最终门禁缺口；这里绝不补另一条授权路径来掩盖它。
 */
export function sandboxProbe(owned: ReadonlySet<ToolDefinition>, limits = { timeoutMs: 2000, memoryLimitBytes: 32 * 1024 * 1024 }) {
  let session: AgentSession | undefined
  const factory: ExtensionFactory = pi => {
    pi.registerTool(defineTool({
      name: 'codemode_probe', label: 'codemode_probe', description: 'Offline sandbox probe', exposure: 'model-only',
      parameters: Type.Object({ code: Type.String() }),
      async execute(_id, { code }, signal, _update, ctx) {
        if (!ctx || !session) throw new Error('公开 Session context 尚未绑定')
        // 必须同时匹配本地持有的定义对象；名称/annotations 不提供所有权。
        const tools = ctx.tools.filter(tool => {
          const definition = session?.getToolDefinition(tool.name)
          return definition !== undefined && owned.has(definition)
        }).map(tool => ({
          name: tool.name, description: tool.description,
          async execute(args: unknown, { signal: childSignal }: { signal: AbortSignal }) {
            const outcome = await ctx.executeTool(tool.name, args, { signal: childSignal })
            if (outcome.isError) throw new Error(resultText(outcome.result))
            return resultText(outcome.result)
          },
        }))
        const sandbox = new CodemodeSandbox({ tools, ...limits })
        try {
          const result = await sandbox.execute(code, { signal })
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {}, isError: !result.ok }
        } finally { await sandbox.close() }
      },
    }))
  }
  return { factory, bind(value: AgentSession) { session = value } }
}
