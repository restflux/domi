import { describe, expect, test } from 'bun:test'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { installPiFinalToolGuard } from './pi-final-tool-guard.ts'
import { buildPiMcpTools, disposePiMcpConnections } from './pi-mcp-tools.ts'
import { httpMcpServer } from './fixtures/pi-mcp-http-server.ts'
import { mcpTool } from './fixtures/pi-mcp-memory-server.ts'

const MODEL: Model<'openai-completions'> = {
  id: 'mcp-test', name: 'MCP local test', provider: 'domi-mcp-test', api: 'openai-completions',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  contextWindow: 100_000, maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function assistant(toolName?: string): AssistantMessage {
  return {
    role: 'assistant', api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
    content: toolName ? [{ type: 'toolCall', id: 'mcp-call', name: toolName, arguments: {} }] : [{ type: 'text', text: '完成' }],
    stopReason: toolName ? 'toolUse' : 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
}

describe('原生 MCP 与宿主最终授权', () => {
  for (const allowed of [false, true]) {
    test(`Given 已注册原生 MCP 工具 When 最终授权${allowed ? '允许' : '拒绝'} Then 真实 Session ${allowed ? '仅调用一次并保留错误与结构化详情' : '不提交服务器调用'}`, async () => {
      const server = httpMcpServer({ callResult: {
        content: [{ type: 'text', text: 'server failure' }], isError: true, structuredContent: { code: 'expected_failure' },
      } })
      const bridge = await buildPiMcpTools({ remote: { type: 'http', url: server.url } })
      const cwd = process.cwd()
      const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } })
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
      })
      modelRuntime.registerProvider(MODEL.provider, { api: MODEL.api, baseUrl: MODEL.baseUrl, apiKey: 'test-only', models: [MODEL] })
      const loader = new DefaultResourceLoader({
        cwd, agentDir: cwd, settingsManager: settings, noExtensions: true, disabledBuiltinExtensions: ['mcp'],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      })
      await loader.reload()
      const { session } = await createAgentSession({
        cwd, agentDir: cwd, model: MODEL, modelRuntime, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd), settingsManager: settings,
        tools: bridge.tools.map(tool => tool.name), customTools: bridge.tools,
      })
      try {
        await session.bindExtensions({})
        expect(session.agent.state.tools.map(tool => tool.name)).toEqual(['mcp__remote__inspect'])
        const authorized: string[] = []
        installPiFinalToolGuard(session, {
          cwd, resolveToolSource: () => 'mcp', resolveToolAnnotations: name => bridge.toolAnnotations[name],
          authorize: async request => {
            authorized.push(request.toolName)
            return allowed ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'test policy denied' }
          },
        })
        let requests = 0
        session.agent.streamFunction = () => {
          const stream = createAssistantMessageEventStream()
          const message = assistant(requests++ === 0 ? bridge.tools[0]!.name : undefined)
          stream.end(message)
          return stream
        }
        await session.prompt('本地测试，不调用外部模型')
        expect(authorized).toEqual(['mcp__remote__inspect'])
        expect(server.messages.filter(message => 'method' in message && message.method === 'tools/call')).toHaveLength(allowed ? 1 : 0)
        const results = session.agent.state.messages.filter(message => message.role === 'toolResult')
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ isError: true })
        if (allowed) expect(results[0]).toMatchObject({ details: { structuredContent: { code: 'expected_failure' }, isError: true } })
      } finally {
        session.dispose()
        await disposePiMcpConnections()
        server.server.stop(true)
      }
    })
  }

  test('Given 外部服务器声明只读和保留名 When 构建 Then 仍需原有信任且保留名/规范化碰撞不覆盖产品工具', async () => {
    const server = httpMcpServer({ tools: [
      { ...mcpTool('inspect'), annotations: { readOnlyHint: true } }, mcpTool('reserved'), mcpTool('a-b'), mcpTool('a_b'),
    ] })
    try {
      const result = await buildPiMcpTools({ remote: { type: 'http', url: server.url } }, new Set(['mcp__remote__reserved']))
      expect(result.tools.map(tool => tool.name)).toEqual(['mcp__remote__inspect', 'mcp__remote__a_b'])
      expect(result.toolAnnotations).toEqual({})
      const trusted = await buildPiMcpTools({ remote: { type: 'http', url: server.url, trustReadOnlyAnnotations: true } })
      expect(trusted.toolAnnotations.mcp__remote__inspect).toMatchObject({ readOnlyHint: true })
    } finally { await disposePiMcpConnections(); server.server.stop(true) }
  })
})
