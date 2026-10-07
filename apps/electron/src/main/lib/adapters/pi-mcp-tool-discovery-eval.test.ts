import { expect, test } from 'bun:test'
import { discoverySession, discoveryTool, DISCOVERY_CORE_TOOLS, scriptDiscoveryRun } from './fixtures/pi-tool-discovery-session.ts'

/** UTF-8 JSON 字节是确定性口径；字符/4 只为粗估，不能代替 Provider tokenizer/计费。 */
function declarationSize(tools: readonly unknown[]) {
  const json = JSON.stringify(tools)
  return { utf8Bytes: Buffer.byteLength(json), characterQuarterEstimate: Math.ceil(json.length / 4) }
}

interface ComparisonRow {
  toolCount: number
  mode: 'full' | 'deferred'
  query: string
  initial: ReturnType<typeof declarationSize>
  afterSearch: ReturnType<typeof declarationSize>
  providerRequests: number
  actualToolCalls: number
  foundTarget: boolean
  completed: boolean
}

async function comparison(toolCount: number): Promise<ComparisonRow[]> {
  const targetKeyword = `ticket${String(toolCount - 1).padStart(4, '0')}`
  const targetName = `mcp__helpdesk__lookup_${targetKeyword}`
  const rows: ComparisonRow[] = []
  for (const query of [targetKeyword, `查找 ${targetKeyword}`, '查找工单']) {
    for (const enabled of [false, true]) {
      let actualToolCalls = 0
      const tools = Array.from({ length: toolCount }, (_, index) => {
        const keyword = `ticket${String(index).padStart(4, '0')}`
        return { ...discoveryTool(`mcp__helpdesk__lookup_${keyword}`, `Look up support ticket ${keyword} and return its status.`),
          async execute() { actualToolCalls++; return { content: [{ type: 'text' as const, text: 'resolved' }], details: {} } },
        }
      })
      const { session } = await discoverySession({ tools: [...DISCOVERY_CORE_TOOLS, ...tools], enabled })
      try {
        // 固定脚本预先知道目标和查询；不是测试真实模型推理或自行选词成功率。
        const declarations = scriptDiscoveryRun(session, requests => {
          if (enabled && requests.length === 1) return [{ name: 'tool_search', arguments: { query, limit: 1 } }]
          const callOrdinal = enabled ? 2 : 1
          return requests.length === callOrdinal && requests.at(-1)?.some(tool => tool.name === targetName)
            ? [{ name: targetName, arguments: {} }] : []
        })
        await session.prompt('离线固定目标任务，不调用外部模型')
        const foundTarget = (declarations[enabled ? 1 : 0] ?? []).some(tool => tool.name === targetName)
        const results = session.agent.state.messages.filter(message => message.role === 'toolResult')
        const completed = results.some(result => result.toolName === targetName && !result.isError) && actualToolCalls === 1
        rows.push({ toolCount, mode: enabled ? 'deferred' : 'full', query,
          initial: declarationSize(declarations[0]!), afterSearch: declarationSize(declarations[enabled ? 1 : 0]!),
          providerRequests: declarations.length, actualToolCalls, foundTarget, completed })
      } finally { session.dispose() }
    }
  }
  return rows
}

test('Given 少量/大量离线 MCP 目录 When 固定查询对照 Then 如实统计曝光和额外轮次而不宣称真实模型收益', async () => {
  const rows = [...await comparison(2), ...await comparison(128)]
  for (const row of rows) {
    if (row.mode === 'full') {
      expect(row.providerRequests).toBe(2)
      expect(row.completed).toBe(true)
    } else if (row.query === '查找工单') {
      expect(row.foundTarget).toBe(false)
      expect(row.actualToolCalls).toBe(0)
      expect(row.completed).toBe(false)
      expect(row.providerRequests).toBe(2)
    } else {
      expect(row.foundTarget).toBe(true)
      expect(row.actualToolCalls).toBe(1)
      expect(row.completed).toBe(true)
      expect(row.providerRequests).toBe(3)
    }
  }
  const largeFull = rows.find(row => row.toolCount === 128 && row.mode === 'full')!
  const largeDeferred = rows.find(row => row.toolCount === 128 && row.mode === 'deferred')!
  expect(largeDeferred.initial.utf8Bytes).toBeLessThan(largeFull.initial.utf8Bytes / 10)
  console.log('[Pi tool discovery offline comparison]', JSON.stringify({
    version: '1.0.4', method: 'Provider transcript current tool declaration JSON; six fixed core fixtures; chars/4 is not tokenization',
    limitation: 'Fixed target and query with simulated Provider; does not measure real model reasoning, latency, billing or server connection startup.',
    rows,
  }, null, 2))
})
