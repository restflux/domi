import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { buildPiMcpTools, disposePiMcpConnections } from './pi-mcp-tools.ts'
import { httpMcpServer } from './fixtures/pi-mcp-http-server.ts'
import { mcpTool } from './fixtures/pi-mcp-memory-server.ts'
import { discoverySession, discoveryTool, DISCOVERY_CORE_TOOLS, DISCOVERY_MODEL, scriptDiscoveryRun } from './fixtures/pi-tool-discovery-session.ts'

const MCP = ['mcp__docs__search', 'mcp__docs__fetch'].map(name => discoveryTool(name, 'Search documents and fetch documents'))
const TOOLS = [...DISCOVERY_CORE_TOOLS, ...MCP]
const search = (query: string, limit = 1) => ({ name: 'tool_search', arguments: { query, limit } })
const names = (tools: ReadonlyArray<{ name: string }>) => tools.map(tool => tool.name)

function toolResults(session: Awaited<ReturnType<typeof discoverySession>>['session']) {
  return session.agent.state.messages.filter(message => message.role === 'toolResult')
}

describe('Pi 原生 MCP 发现真实 Session', () => {
  test('Given 默认关闭 When Provider 请求 Then 全量 MCP 和核心工具常驻，不出现发现工具', async () => {
    const { session } = await discoverySession({ tools: TOOLS })
    try {
      const requests = scriptDiscoveryRun(session, [])
      await session.prompt('离线测试')
      expect(names(requests[0]!)).toEqual(names(TOOLS))
    } finally { session.dispose() }
  })

  test('Given opt-in When 搜索/加载多个工具 Then 下一次请求拥有定义、搜索不执行工具且核心常驻', async () => {
    let actualCalls = 0
    const tools = TOOLS.map(tool => tool.name.startsWith('mcp__') ? { ...tool,
      async execute() { actualCalls++; return { content: [{ type: 'text' as const, text: 'ok' }], details: {} } },
    } : tool)
    const { session, plan, authorized } = await discoverySession({ tools, enabled: true })
    try {
      const requests = scriptDiscoveryRun(session, [[search('documents', 2)]])
      await session.prompt('离线测试')
      expect(names(requests[0]!)).toEqual(['tool_search', ...names(DISCOVERY_CORE_TOOLS)])
      expect(names(requests[1]!)).toEqual(['tool_search', ...names(DISCOVERY_CORE_TOOLS), ...names(MCP)])
      expect(actualCalls).toBe(0)
      expect(toolResults(session)[0]).toMatchObject({ details: { loaded: names(MCP) }, isError: false })
      expect(authorized.map(request => [request.toolName, request.options.toolSource])).toEqual([['tool_search', 'host']])
      expect(plan.isOwnedTool(session, 'tool_search')).toBe(true)
      expect(names(getCurrentTools(session.sessionManager.buildSessionProjection().messages))).toEqual(names(requests[1]!))
    } finally { session.dispose() }
  })

  for (const allowed of [false, true]) {
    test(`Given 本地 MCP 和未信任 readonly When 发现后授权${allowed ? '允许' : '拒绝'} Then ${allowed ? '调用一次并保持结构化/图片结果' : '零服务器调用'}`, async () => {
      const server = httpMcpServer({ tools: [{ ...mcpTool('inspect'), description: 'Inspect documents', annotations: { readOnlyHint: true } }],
        callResult: { content: [{ type: 'text', text: 'completed' }, { type: 'image', mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }],
          structuredContent: { count: 1 }, isError: true } })
      let session: Awaited<ReturnType<typeof discoverySession>>['session'] | undefined
      try {
        const bridge = await buildPiMcpTools({ local: { type: 'http', url: server.url } })
        expect(bridge.toolAnnotations).toEqual({})
        const runtime = await discoverySession({ tools: [...DISCOVERY_CORE_TOOLS, ...bridge.tools], enabled: true,
          authorize: request => request.toolName === 'tool_search' || allowed })
        session = runtime.session
        const requests = scriptDiscoveryRun(session, [[search('inspect')], [{ name: bridge.tools[0]!.name, arguments: {} }]])
        await session.prompt('模拟模型，只调用本地测试服务')
        expect(names(requests[0]!)).not.toContain(bridge.tools[0]!.name)
        expect(names(requests[1]!)).toContain(bridge.tools[0]!.name)
        expect(runtime.authorized.map(request => request.options.toolSource)).toEqual(['host', 'mcp'])
        expect(server.messages.filter(message => 'method' in message && message.method === 'tools/call')).toHaveLength(allowed ? 1 : 0)
        const result = toolResults(session)[1]
        expect(result).toMatchObject({ toolName: bridge.tools[0]!.name, isError: true })
        if (allowed) {
          expect(result).toMatchObject({ details: { structuredContent: { count: 1 } } })
          expect(result?.content.some(block => block.type === 'image')).toBe(true)
        }
        for (const request of requests) for (const core of DISCOVERY_CORE_TOOLS) expect(names(request)).toContain(core.name)
      } finally { session?.dispose(); await disposePiMcpConnections(); server.server.stop(true) }
    })
  }

  test('Given 发现授权拒绝 When 搜索 Then 不加载定义也不调用 MCP', async () => {
    const { session } = await discoverySession({ tools: TOOLS, enabled: true, authorize: () => false })
    try {
      const requests = scriptDiscoveryRun(session, [[search('documents')]])
      await session.prompt('离线测试')
      expect(names(requests[1]!)).toEqual(names(requests[0]!))
      expect(toolResults(session)[0]).toMatchObject({ toolName: 'tool_search', isError: true })
    } finally { session.dispose() }
  })

  test('Given 授权期间用户取消 When 恢复授权 Then 不加载 MCP 定义', async () => {
    let session: Awaited<ReturnType<typeof discoverySession>>['session'] | undefined
    const runtime = await discoverySession({ tools: TOOLS, enabled: true, authorize: async () => {
      if (!session) throw new Error('Session 尚未赋值')
      // 不等待 abort 的 idle promise，避免阻塞当前 beforeToolCall。
      void session.abort()
      return true
    } })
    session = runtime.session
    try {
      scriptDiscoveryRun(session, [[search('documents')]])
      await session.prompt('离线取消')
      expect(session.getActiveToolNames().filter(name => name.startsWith('mcp__'))).toEqual([])
    } finally { session.dispose() }
  })

  test('Given 空/非法查询 When 搜索失败 Then 原定义不变、后续英文搜索可继续', async () => {
    const { session } = await discoverySession({ tools: TOOLS, enabled: true })
    try {
      const requests = scriptDiscoveryRun(session, [[search(' ')], [search('documents', 0)], [search('documents')]])
      await session.prompt('离线错误恢复')
      expect(toolResults(session).map(result => result.isError)).toEqual([true, true, false])
      expect(names(requests[1]!)).toEqual(names(requests[0]!))
      expect(names(requests[2]!)).toEqual(names(requests[0]!))
      expect(names(requests[3]!)).toContain(MCP[0]!.name)
    } finally { session.dispose() }
  })

  test('Given 纯中文/中英混合/无匹配 When 原生 BM25 Then 暴露实际限制且宿主可回退全量', async () => {
    const { session, plan } = await discoverySession({ tools: TOOLS, enabled: true })
    try {
      const requests = scriptDiscoveryRun(session, [[search('查找文档')], [search('查找 documents')], [search('zzzzunknown')]])
      await session.prompt('离线中英文')
      expect(toolResults(session).map(result => result.details)).toEqual([{ loaded: [] }, { loaded: [MCP[0]!.name] }, { loaded: [] }])
      expect(names(requests[1]!)).toEqual(names(requests[0]!))
      expect(names(requests[3]!)).toEqual(names(requests[2]!))
      plan.exposeAllMcpTools(session)
      expect(session.getActiveToolNames()).toEqual(['tool_search', ...names(DISCOVERY_CORE_TOOLS), ...names(MCP)])
    } finally { session.dispose() }
  })

  test('Given 中文描述和中文原始名称 When 桥接并发现 Then 保留原名称归属且不伪造中文检索支持', async () => {
    const server = httpMcpServer({ tools: [{ ...mcpTool('查找文档'), description: '查找项目资料' },
      { ...mcpTool('searchDocs'), description: '查找项目资料' }] })
    let session: Awaited<ReturnType<typeof discoverySession>>['session'] | undefined
    try {
      const bridge = await buildPiMcpTools({ docs: { type: 'http', url: server.url } })
      expect(names(bridge.tools)).toEqual(['mcp__docs__unnamed', 'mcp__docs__searchDocs'])
      session = (await discoverySession({ tools: [...DISCOVERY_CORE_TOOLS, ...bridge.tools], enabled: true })).session
      scriptDiscoveryRun(session, [[search('查找项目资料')], [search('searchDocs')], [{ name: 'mcp__docs__searchDocs', arguments: {} }]])
      await session.prompt('离线中文目录')
      expect(toolResults(session)[0]).toMatchObject({ details: { loaded: [] } })
      expect(toolResults(session)[1]).toMatchObject({ details: { loaded: ['mcp__docs__searchDocs'] } })
      expect(server.messages.filter(message => 'method' in message && message.method === 'tools/call'))
        .toMatchObject([{ params: { name: 'searchDocs', arguments: {} } }])
    } finally { session?.dispose(); await disposePiMcpConnections(); server.server.stop(true) }
  })

  test('Given 其他扩展 deferred 工具 When 搜索同关键词 Then 不纳入 MCP 发现目录', async () => {
    const foreign: ExtensionFactory = pi => { pi.registerTool({ ...discoveryTool('foreign_search', 'Search documents'), exposure: 'deferred' }) }
    const { session } = await discoverySession({ tools: TOOLS, enabled: true, factories: [foreign] })
    try {
      scriptDiscoveryRun(session, [[search('documents', 20)]])
      await session.prompt('离线范围')
      expect(session.getAllTools().some(tool => tool.name === 'foreign_search')).toBe(true)
      expect(session.getActiveToolNames()).not.toContain('foreign_search')
      expect(toolResults(session)[0]).toMatchObject({ details: { loaded: names(MCP) } })
    } finally { session.dispose() }
  })

  test('Given 同名外部 extension When 注册 Then 不静默获得 Domi 发现工具身份', async () => {
    const foreign: ExtensionFactory = pi => { pi.registerTool(discoveryTool('tool_search')) }
    await expect(discoverySession({ tools: TOOLS, enabled: true, factories: [foreign] })).rejects.toThrow('tool_search')
  })

  test('Given 已加载 transcript When 重启/fork/模型切换 Then 保持定义和历史引用，关闭实验恢复全量', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'domi-tool-discovery-'))
    const sessions: Awaited<ReturnType<typeof discoverySession>>['session'][] = []
    try {
      const manager = SessionManager.create(process.cwd(), directory)
      const initial = await discoverySession({ tools: TOOLS, enabled: true, manager })
      sessions.push(initial.session)
      scriptDiscoveryRun(initial.session, [[search('documents')], [{ name: MCP[0]!.name, arguments: {} }]])
      await initial.session.prompt('保存发现状态')
      const file = initial.session.sessionFile
      if (!file) throw new Error('未保存原生 Session 文件')
      const loaded = initial.session.getActiveToolNames()
      initial.session.dispose()
      for (const restoredManager of [SessionManager.open(file, directory), SessionManager.forkFrom(file, process.cwd(), directory)]) {
        const restored = await discoverySession({ tools: TOOLS, enabled: true, manager: restoredManager })
        sessions.push(restored.session)
        expect(restored.session.getActiveToolNames()).toEqual(loaded)
        expect(restored.session.agent.state.messages.filter(message => message.role === 'toolResult').map(message => message.toolName))
          .toEqual(['tool_search', MCP[0]!.name])
        const model = { ...DISCOVERY_MODEL, id: 'discovery-switched', name: 'Offline switched model' }
        restored.modelRuntime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-placeholder', models: [model] })
        await restored.session.setModel(model)
        const requests = scriptDiscoveryRun(restored.session, [])
        await restored.session.prompt('模型切换后继续')
        expect(names(requests[0]!)).toEqual(loaded)
        expect(names(getCurrentTools(restored.session.sessionManager.buildSessionProjection().messages))).toEqual(loaded)
      }
      const disabled = await discoverySession({ tools: TOOLS, manager: SessionManager.open(file, directory) })
      sessions.push(disabled.session)
      const requests = scriptDiscoveryRun(disabled.session, [])
      await disabled.session.prompt('关闭实验后继续')
      expect(new Set(names(requests[0]!))).toEqual(new Set(names(TOOLS)))
      expect(names(requests[0]!)).not.toContain('tool_search')
    } finally { for (const session of sessions) session.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })
})
