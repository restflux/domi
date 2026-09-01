import { describe, expect, test } from 'bun:test'
import type { AuditEvent, AuditWriteResult } from '../audit/audit-writer.ts'
import { ManagedWebAccessPolicy } from './managed-web-access-policy.ts'
import { ManagedWebAccess, ManagedWebAccessDeniedError } from './managed-web-access.ts'

class MemoryAuditWriter {
  readonly events: AuditEvent[] = []

  async record(event: AuditEvent): Promise<AuditWriteResult> {
    this.events.push(event)
    return { written: true }
  }
}

describe('ManagedWebAccess', () => {
  test('初始目标被拒绝时不会调用 fetch', async () => {
    let fetchCount = 0
    const audit = new MemoryAuditWriter()
    const access = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: audit,
      fetchImpl: async () => {
        fetchCount += 1
        return new Response('unexpected')
      },
    })

    await expect(access.fetch('http://127.0.0.1/secret', {}, 'custom_http')).rejects.toBeInstanceOf(ManagedWebAccessDeniedError)
    expect(fetchCount).toBe(0)
    expect(audit.events[0]).toMatchObject({
      category: 'managed_web_access',
      action: 'custom_http.authorize',
      data: { target: { hostname: '127.0.0.1' }, decision: 'deny', reason: 'non_public_address' },
    })
  })

  test('redirect 的 Location 必须重新授权，拒绝后不会访问私网', async () => {
    const fetched: string[] = []
    const audit = new MemoryAuditWriter()
    const access = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: audit,
      fetchImpl: async (input) => {
        fetched.push(String(input))
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://192.168.1.9/admin?token=not-forwarded' },
        })
      },
    })

    await expect(access.fetch('https://8.8.8.8/start', {}, 'custom_http')).rejects.toMatchObject({
      decision: { decision: 'deny', reason: 'secret_in_url', hostname: '192.168.1.9' },
    })
    expect(fetched).toEqual(['https://8.8.8.8/start'])
    expect(audit.events.filter((event) => event.action === 'custom_http.authorize')).toHaveLength(2)
  })

  test('跨 origin redirect 去除 Authorization 与 Cookie', async () => {
    const requests: Array<{ url: string, headers: Headers }> = []
    const access = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: new MemoryAuditWriter(),
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) })
        return requests.length === 1
          ? new Response(null, { status: 302, headers: { Location: 'https://1.1.1.1/final' } })
          : new Response('ok')
      },
    })

    await access.fetch('https://8.8.8.8/start', {
      headers: { Authorization: 'Bearer must-not-forward', Cookie: 'sid=must-not-forward' },
    })

    expect(requests.map((request) => request.url)).toEqual([
      'https://8.8.8.8/start',
      'https://1.1.1.1/final',
    ])
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer must-not-forward')
    expect(requests[1]!.headers.has('authorization')).toBe(false)
    expect(requests[1]!.headers.has('cookie')).toBe(false)
  })

  test('成功请求只审计主机和分类，不记录 query 或响应正文', async () => {
    const audit = new MemoryAuditWriter()
    const access = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: audit,
      fetchImpl: async () => new Response('private response body'),
    })

    const response = await access.fetch('https://8.8.8.8/path?ordinary=value', {}, 'web_fetch')
    expect(await response.text()).toBe('private response body')
    const serialized = JSON.stringify(audit.events)
    expect(serialized).not.toContain('ordinary=value')
    expect(serialized).not.toContain('private response body')
    expect(audit.events.at(-1)).toMatchObject({
      action: 'web_fetch.request',
      data: { decision: 'allow', reason: 'public_target', errorCategory: 'none' },
    })
  })

  test('audit writer 失败不改变允许或拒绝结果', async () => {
    const access = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: { record: async () => { throw new Error('audit unavailable') } },
      fetchImpl: async () => new Response('ok'),
    })

    expect((await access.fetch('https://8.8.8.8/')).status).toBe(200)
    await expect(access.fetch('http://127.0.0.1/')).rejects.toBeInstanceOf(ManagedWebAccessDeniedError)
  })
})
