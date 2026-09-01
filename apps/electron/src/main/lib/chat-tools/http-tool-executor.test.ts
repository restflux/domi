import { beforeEach, describe, expect, test } from 'bun:test'
import type { ToolCall } from '@domi/core'
import type { ChatToolHttpConfig, ChatToolMeta } from '@domi/shared'
import type { AuditEvent, AuditWriteResult } from '../audit/audit-writer.ts'
import { ManagedWebAccessPolicy } from '../managed-web-access/managed-web-access-policy.ts'
import { ManagedWebAccess } from '../managed-web-access/managed-web-access.ts'
import { executeHttpTool } from './http-tool-executor.ts'

class MemoryAuditWriter {
  readonly events: AuditEvent[] = []

  async record(event: AuditEvent): Promise<AuditWriteResult> {
    this.events.push(event)
    return { written: true }
  }
}

let networkCalls: Array<{ url: string, init?: RequestInit }> = []
const audit = new MemoryAuditWriter()
const managedWebAccess = new ManagedWebAccess({
  policy: new ManagedWebAccessPolicy({ resolver: async () => ['93.184.216.34'] }),
  auditWriter: audit,
  fetchImpl: async (input, init) => {
    networkCalls.push({ url: String(input), init })
    return Response.json({ ok: true })
  },
})

beforeEach(() => {
  networkCalls = []
  audit.events.length = 0
})

function toolCall(arguments_: Record<string, unknown> = {}): ToolCall {
  return { id: 'call-1', name: 'sample-http', arguments: arguments_ }
}

function customTool(httpConfig: ChatToolHttpConfig): ChatToolMeta {
  return {
    id: 'sample-http',
    name: 'Sample HTTP',
    description: 'test seam',
    params: [],
    category: 'custom',
    executorType: 'http',
    httpConfig,
  }
}

describe('custom HTTP Managed Web 输入策略', () => {
  test('Given 敏感 header When 执行自定义 HTTP Then fail closed 且网络未调用、审计不落 header value', async () => {
    for (const [name, value] of [
      ['Authorization', 'Bearer opaque-custom-credential'],
      ['Cookie', 'sid=opaque-custom-cookie'],
      ['X-API-Key', 'opaque-custom-api-key'],
    ] as const) {
      const result = await executeHttpTool(toolCall(), customTool({
        urlTemplate: 'https://example.com/api',
        method: 'GET',
        headers: { [name]: value },
      }), managedWebAccess)

      expect(result).toMatchObject({ isError: true, content: 'HTTP 请求失败: 访问被拒绝 (secret_in_request)' })
      expect(JSON.stringify(audit.events)).not.toContain(value)
    }

    expect(networkCalls).toHaveLength(0)
    expect(audit.events).toHaveLength(3)
    expect(audit.events.every((event) => (
      event.action === 'custom_http.authorize'
      && event.data?.decision === 'deny'
      && event.data?.reason === 'secret_in_request'
    ))).toBe(true)
  })

  test('Given string body 含明显 secret When 执行自定义 HTTP Then fail closed 且网络未调用、审计不落 body', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const result = await executeHttpTool(toolCall({ secret }), customTool({
      urlTemplate: 'https://example.com/api',
      method: 'POST',
      bodyTemplate: '{"note":"{{secret}}"}',
    }), managedWebAccess)

    expect(result).toMatchObject({ isError: true, content: 'HTTP 请求失败: 访问被拒绝 (secret_in_request)' })
    expect(networkCalls).toHaveLength(0)
    expect(JSON.stringify(audit.events)).not.toContain(secret)
  })

  test('Given string body 含凭据赋值 When 执行自定义 HTTP Then 在网络调用前拒绝', async () => {
    const secret = 'token=livecredential123456789'
    const result = await executeHttpTool(toolCall({ secret }), customTool({
      urlTemplate: 'https://example.com/api',
      method: 'POST',
      bodyTemplate: '{"value":"{{secret}}"}',
    }), managedWebAccess)

    expect(result).toMatchObject({ isError: true, content: 'HTTP 请求失败: 访问被拒绝 (secret_in_request)' })
    expect(networkCalls).toHaveLength(0)
    expect(JSON.stringify(audit.events)).not.toContain('livecredential123456789')
  })

  test('Given 普通 header 与代码片段 body When 执行自定义 HTTP Then 请求正常通过', async () => {
    const result = await executeHttpTool(toolCall({ snippet: 'const token = process.env.TOKEN' }), customTool({
      urlTemplate: 'https://example.com/api?section=public',
      method: 'POST',
      headers: { 'X-Trace-Mode': 'example' },
      bodyTemplate: '{"snippet":"{{snippet}}"}',
    }), managedWebAccess)

    expect(result).toMatchObject({ content: '{\n  "ok": true\n}' })
    expect(networkCalls).toHaveLength(1)
  })

  test('Given credential reference in header When credential exists Then runtime injects it without audit leakage', async () => {
    const secret = 'opaque-custom-credential-123456'
    const result = await executeHttpTool(toolCall(), customTool({
      urlTemplate: 'https://example.com/api',
      method: 'GET',
      headers: { Authorization: 'Bearer {{credential.apiKey}}' },
    }), managedWebAccess, { apiKey: secret })

    expect(result.isError).toBeUndefined()
    expect(networkCalls).toHaveLength(1)
    expect(new Headers(networkCalls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${secret}`)
    expect(JSON.stringify(audit.events)).not.toContain(secret)
  })

  test('Given credential reference plus model argument in sensitive header When executing Then model value cannot use the trust channel', async () => {
    const result = await executeHttpTool(toolCall({ suffix: 'token=uncontrolledsecret123456789' }), customTool({
      urlTemplate: 'https://example.com/api',
      method: 'GET',
      headers: { Authorization: 'Bearer {{credential.apiKey}} {{suffix}}' },
    }), managedWebAccess, { apiKey: 'controlled' })

    expect(result).toMatchObject({ isError: true, content: 'HTTP 请求失败: 访问被拒绝 (secret_in_request)' })
    expect(networkCalls).toHaveLength(0)
  })

  test('Given credential reference in body When credential exists Then only controlled value bypasses secret scan', async () => {
    const secret = 'sk-controlledcredential123456789'
    const result = await executeHttpTool(toolCall({ note: 'public' }), customTool({
      urlTemplate: 'https://example.com/api',
      method: 'POST',
      bodyTemplate: '{"apiKey":"{{credential.apiKey}}","note":"{{note}}"}',
    }), managedWebAccess, { apiKey: secret })

    expect(result.isError).toBeUndefined()
    expect(networkCalls).toHaveLength(1)
    expect(String(networkCalls[0]?.init?.body)).toContain(secret)
    expect(JSON.stringify(audit.events)).not.toContain(secret)
  })

  test('Given credential body plus secret model argument When executing Then uncontrolled secret still fails closed', async () => {
    const result = await executeHttpTool(toolCall({ note: 'token=uncontrolledsecret123456789' }), customTool({
      urlTemplate: 'https://example.com/api',
      method: 'POST',
      bodyTemplate: '{"apiKey":"{{credential.apiKey}}","note":"{{note}}"}',
    }), managedWebAccess, { apiKey: 'short' })

    expect(result).toMatchObject({ isError: true, content: 'HTTP 请求失败: 访问被拒绝 (secret_in_request)' })
    expect(networkCalls).toHaveLength(0)
  })

  test('Given missing referenced credential When executing Then fail before network without exposing config', async () => {
    const result = await executeHttpTool(toolCall(), customTool({
      urlTemplate: 'https://example.com/api',
      method: 'GET',
      headers: { 'X-API-Key': '{{credential.apiKey}}' },
    }), managedWebAccess, {})

    expect(result).toMatchObject({ isError: true, content: 'HTTP 请求失败: 缺少凭据: apiKey' })
    expect(networkCalls).toHaveLength(0)
  })

  test('Given credential reference in URL from manually edited config When executing Then policy denies before network', async () => {
    const secret = 'opaque-url-credential'
    const result = await executeHttpTool(toolCall(), customTool({
      urlTemplate: 'https://example.com/api?api_key={{credential.apiKey}}',
      method: 'GET',
    }), managedWebAccess, { apiKey: secret })

    expect(result).toMatchObject({ isError: true, content: 'HTTP 请求失败: 访问被拒绝 (secret_in_url)' })
    expect(networkCalls).toHaveLength(0)
    expect(JSON.stringify(audit.events)).not.toContain(secret)
  })

  test('Given controlled Authorization When redirect crosses origin Then credential is not forwarded', async () => {
    const requests: Array<{ url: string, headers: Headers }> = []
    const redirectAccess = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: audit,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) })
        return requests.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://1.1.1.1/final' } })
          : Response.json({ ok: true })
      },
    })
    const result = await executeHttpTool(toolCall(), customTool({
      urlTemplate: 'https://8.8.8.8/start',
      method: 'GET',
      headers: { Authorization: 'Bearer {{credential.apiKey}}' },
    }), redirectAccess, { apiKey: 'opaque-controlled-redirect-credential' })

    expect(result.isError).toBeUndefined()
    expect(requests[0]?.headers.has('authorization')).toBe(true)
    expect(requests[1]?.headers.has('authorization')).toBe(false)
  })

  test('Given controlled custom credential header When redirect crosses origin Then every injected header is stripped', async () => {
    const requests: Array<{ url: string, headers: Headers }> = []
    const redirectAccess = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: audit,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) })
        return requests.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://1.1.1.1/final' } })
          : Response.json({ ok: true })
      },
    })
    const result = await executeHttpTool(toolCall(), customTool({
      urlTemplate: 'https://8.8.8.8/start',
      method: 'GET',
      headers: { 'X-Service-Credential': '{{credential.apiKey}}' },
    }), redirectAccess, { apiKey: 'opaque-controlled-redirect-credential' })

    expect(result.isError).toBeUndefined()
    expect(requests[0]?.headers.has('x-service-credential')).toBe(true)
    expect(requests[1]?.headers.has('x-service-credential')).toBe(false)
  })

  test('Given controlled credential body When 307 redirect crosses origin Then request fails before forwarding body', async () => {
    const requests: Array<{ url: string, body: BodyInit | null | undefined }> = []
    const redirectAccess = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: audit,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), body: init?.body })
        return new Response(null, { status: 307, headers: { location: 'https://1.1.1.1/final' } })
      },
    })
    const secret = 'opaque-controlled-body-credential'
    const result = await executeHttpTool(toolCall(), customTool({
      urlTemplate: 'https://8.8.8.8/start',
      method: 'POST',
      bodyTemplate: '{"apiKey":"{{credential.apiKey}}"}',
    }), redirectAccess, { apiKey: secret })

    expect(result).toMatchObject({ isError: true, content: 'HTTP 请求失败: 访问被拒绝 (secret_in_request)' })
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(audit.events)).not.toContain(secret)
  })
})
