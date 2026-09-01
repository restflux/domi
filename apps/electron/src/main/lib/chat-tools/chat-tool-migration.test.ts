import { describe, expect, test } from 'bun:test'
import { sanitizeChatToolsForMigration } from './chat-tool-migration.ts'

describe('Chat tool migration credential boundary', () => {
  test('share export strips every credential while preserving safe references', () => {
    const exported = sanitizeChatToolsForMigration({
      toolCredentials: {
        'web-search': { apiKey: 'builtin-secret' },
        'custom-safe': { apiKey: 'custom-secret' },
      },
      customTools: [{
        id: 'custom-safe',
        executorType: 'http',
        httpConfig: {
          urlTemplate: 'https://example.com/api',
          method: 'GET',
          headers: { Authorization: 'Bearer {{credential.apiKey}}' },
        },
      }],
    }, 'share')

    expect(exported.toolCredentials).toEqual({})
    expect(JSON.stringify(exported)).not.toContain('builtin-secret')
    expect(JSON.stringify(exported)).not.toContain('custom-secret')
    expect(JSON.stringify(exported)).toContain('{{credential.apiKey}}')
  })

  test('personal backup keeps existing builtin settings but never exports custom HTTP credential values', () => {
    const exported = sanitizeChatToolsForMigration({
      toolCredentials: {
        'web-search': { apiKey: 'builtin-secret' },
        'custom-safe': { apiKey: 'custom-secret' },
      },
      customTools: [{
        id: 'custom-safe',
        executorType: 'http',
        httpConfig: {
          urlTemplate: 'https://example.com/api',
          method: 'GET',
          headers: { 'X-API-Key': '{{credential.apiKey}}' },
        },
      }],
    }, 'personal')

    expect(exported.toolCredentials).toEqual({ 'web-search': { apiKey: 'builtin-secret' } })
    expect(JSON.stringify(exported)).not.toContain('custom-secret')
  })

  test('unsafe legacy HTTP metadata loses httpConfig before export or import', () => {
    const sanitized = sanitizeChatToolsForMigration({
      toolCredentials: { 'custom-legacy': { apiKey: 'runtime-secret' } },
      customTools: [{
        id: 'custom-legacy',
        name: 'Legacy',
        executorType: 'http',
        httpConfig: {
          urlTemplate: 'https://example.com/api',
          method: 'GET',
          headers: { Authorization: 'Bearer legacy-secret-value' },
        },
      }],
    }, 'personal')

    expect(sanitized.toolCredentials).toEqual({})
    expect(sanitized.customTools).toEqual([{ id: 'custom-legacy', name: 'Legacy', executorType: 'http' }])
    expect(JSON.stringify(sanitized)).not.toContain('legacy-secret-value')
    expect(JSON.stringify(sanitized)).not.toContain('runtime-secret')
  })
})
