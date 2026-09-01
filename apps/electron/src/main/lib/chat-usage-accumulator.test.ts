import { describe, expect, test } from 'bun:test'
import {
  addChatProviderRequest,
  createChatUsageAccumulator,
  mergeChatProviderUsage,
} from './chat-usage-accumulator'

describe('chat usage accumulator', () => {
  test('counts every streamSSE invocation while summing only provider-reported usage', () => {
    let usage = createChatUsageAccumulator()
    usage = addChatProviderRequest(usage)
    usage = mergeChatProviderUsage(usage, {
      type: 'usage',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheCreationTokens: 5,
    })
    usage = addChatProviderRequest(usage)
    usage = mergeChatProviderUsage(usage, {
      type: 'usage',
      inputTokens: 120,
      outputTokens: 20,
      cacheReadTokens: 90,
    })
    usage = addChatProviderRequest(usage)

    expect(usage).toEqual({
      providerRequestCount: 3,
      inputTokens: 220,
      outputTokens: 30,
      cacheReadTokens: 170,
      cacheCreationTokens: 5,
      hasProviderUsage: true,
    })
  })

  test('retains an exact request count when a provider response omits usage', () => {
    const usage = addChatProviderRequest(createChatUsageAccumulator())

    expect(usage.providerRequestCount).toBe(1)
    expect(usage.hasProviderUsage).toBe(false)
  })
})
