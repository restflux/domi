import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('chat-service provider usage wiring', () => {
  test('counts every actual streamSSE call, including the forced final continuation', () => {
    const source = readFileSync(resolve(import.meta.dir, 'chat-service.ts'), 'utf8')
    const requestIncrements = source.match(/accumulatedUsage = addChatProviderRequest\(accumulatedUsage\)/g) ?? []
    const streamCalls = source.match(/await streamSSE\(\{/g) ?? []
    const usageMerges = source.match(/accumulatedUsage = mergeChatProviderUsage\(accumulatedUsage,/g) ?? []

    expect(streamCalls).toHaveLength(2)
    expect(requestIncrements).toHaveLength(streamCalls.length)
    expect(usageMerges).toHaveLength(streamCalls.length)
    expect(source).toContain('providerRequestCount: accumulatedUsage.providerRequestCount')
    expect(source).toContain("providerRequestCountAccuracy: 'exact'")
  })
})
