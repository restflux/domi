import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AuditEvent, AuditWriteResult } from './audit/audit-writer.ts'
import { ManagedWebAccessPolicy } from './managed-web-access/managed-web-access-policy.ts'
import { ManagedWebAccess } from './managed-web-access/managed-web-access.ts'

class MemoryAuditWriter {
  readonly events: AuditEvent[] = []

  async record(event: AuditEvent): Promise<AuditWriteResult> {
    this.events.push(event)
    return { written: true }
  }
}

const audit = new MemoryAuditWriter()
const managedWebAccess = new ManagedWebAccess({
  policy: new ManagedWebAccessPolicy({ resolver: async () => ['93.184.216.34'] }),
  auditWriter: audit,
})

mock.module('./chat-tool-config.ts', () => ({
  getChatToolsConfig: () => ({ customTools: [] }),
  getToolCredentials: () => ({ apiKey: 'tavily-test-key' }),
  getToolState: () => ({ enabled: true }),
}))
mock.module('./managed-web-access/managed-web-runtime.ts', () => ({
  getManagedWebAccess: () => managedWebAccess,
}))

let searchWeb: typeof import('./web-search-service.ts').searchWeb
let fetchWebPage: typeof import('./web-search-service.ts').fetchWebPage
const originalFetch = globalThis.fetch
let tavilyCalls: Array<{ url: string, init?: RequestInit }> = []

beforeAll(async () => {
  ({ searchWeb, fetchWebPage } = await import('./web-search-service.ts'))
})

beforeEach(() => {
  tavilyCalls = []
  audit.events.length = 0
  globalThis.fetch = (async (input, init) => {
    tavilyCalls.push({ url: String(input), init })
    return Response.json({ results: [] })
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('Managed Web WebSearch 与 WebFetch 输入策略', () => {
  test('Given WebSearch query 含明显 secret When 搜索 Then fail closed 且 Tavily 未调用、审计不落 secret', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456'

    await expect(searchWeb({ query: `find usage of ${secret}` })).rejects.toMatchObject({
      decision: { decision: 'deny', reason: 'secret_in_request' },
    })

    expect(tavilyCalls).toHaveLength(0)
    expect(audit.events[0]).toMatchObject({
      action: 'web_search.authorize',
      data: {
        target: { hostname: 'api.tavily.com' },
        decision: 'deny',
        reason: 'secret_in_request',
      },
    })
    expect(JSON.stringify(audit.events)).not.toContain(secret)
  })

  test('Given WebSearch query 含凭据赋值 When 搜索 Then 在发送给 Tavily 前拒绝', async () => {
    const secret = 'api_key=livecredential123456789'

    await expect(searchWeb({ query: `debug ${secret}` })).rejects.toMatchObject({
      decision: { decision: 'deny', reason: 'secret_in_request' },
    })

    expect(tavilyCalls).toHaveLength(0)
    expect(JSON.stringify(audit.events)).not.toContain('livecredential123456789')
  })

  test('Given WebFetch prompt 含明显 secret When 抓取 Then fail closed 且 Tavily 未调用、审计不落 secret', async () => {
    const secret = 'sk-abcdefghijklmnop123456'

    await expect(fetchWebPage({
      url: 'https://example.com/public',
      prompt: `summarize with ${secret}`,
    })).rejects.toMatchObject({
      decision: { decision: 'deny', reason: 'secret_in_request' },
    })

    expect(tavilyCalls).toHaveLength(0)
    expect(audit.events[0]).toMatchObject({
      action: 'web_fetch.authorize',
      data: { target: { hostname: 'example.com' }, decision: 'deny', reason: 'secret_in_request' },
    })
    expect(JSON.stringify(audit.events)).not.toContain(secret)
  })

  test('Given 普通搜索词、代码片段与公开 URL When 搜索和抓取 Then 正常调用 Tavily', async () => {
    await searchWeb({ query: 'TypeScript Authorization header example' })
    await fetchWebPage({
      url: 'https://example.com/docs?section=public',
      prompt: 'Explain `const token = process.env.TOKEN` without including credentials',
    })

    expect(tavilyCalls.map((call) => call.url)).toEqual([
      'https://api.tavily.com/search',
      'https://api.tavily.com/extract',
    ])
  })
})
