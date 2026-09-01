import { describe, expect, test } from 'bun:test'
import {
  assertSafeHttpToolConfig,
  hasRequiredHttpToolCredentials,
  listHttpCredentialKeys,
} from './http-tool-credentials.ts'

describe('custom HTTP credential references', () => {
  test('collects unique credential keys and marks tool unavailable until all exist', () => {
    const config = {
      urlTemplate: 'https://example.com/api',
      method: 'POST' as const,
      headers: { Authorization: 'Bearer {{credential.apiKey}}' },
      bodyTemplate: '{"secret":"{{credential.clientSecret}}","again":"{{credential.apiKey}}"}',
    }

    expect(listHttpCredentialKeys(config)).toEqual(['apiKey', 'clientSecret'])
    expect(hasRequiredHttpToolCredentials(config, { apiKey: 'present' })).toBe(false)
    expect(hasRequiredHttpToolCredentials(config, {
      apiKey: 'present',
      clientSecret: 'present',
    })).toBe(true)
  })

  test('plain sensitive headers and URL credentials are invalid configuration', () => {
    expect(() => assertSafeHttpToolConfig({
      urlTemplate: 'https://example.com/api',
      method: 'GET',
      headers: { 'X-API-Key': 'plain-value' },
    })).toThrow('必须使用 {{credential.<key>}} 引用')

    expect(() => assertSafeHttpToolConfig({
      urlTemplate: 'https://user:password@example.com/api',
      method: 'GET',
    })).toThrow('不得包含用户名或密码')
  })

  test('sensitive headers cannot mix credential references with model arguments or another secret', () => {
    expect(() => assertSafeHttpToolConfig({
      urlTemplate: 'https://example.com/api',
      method: 'GET',
      headers: { Authorization: 'Bearer {{credential.apiKey}} {{userToken}}' },
    })).toThrow('不得注入模型参数')

    expect(() => assertSafeHttpToolConfig({
      urlTemplate: 'https://example.com/api',
      method: 'GET',
      headers: { Authorization: 'Bearer {{credential.apiKey}} token=uncontrolledsecret123456789' },
    })).toThrow('credential reference 之外的明文凭据')
  })
})
