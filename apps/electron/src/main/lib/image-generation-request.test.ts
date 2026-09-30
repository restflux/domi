import { describe, expect, mock, test } from 'bun:test'

let defaultSelection: { channelId: string; modelId: string } | undefined
mock.module('./image-generation/config', () => ({
  resolveImageGenerationSelection: (selection?: { channelId: string; modelId: string }) => selection ?? defaultSelection,
  resolveImageGenerationConfig: () => ({ apiKey: 'test-key', baseUrl: 'https://example.com/v1', model: 'gpt-image-2', protocol: 'openai-images' }),
}))

const { resolveRequestImageGeneration } = await import('./image-generation-request')

describe('本轮生图请求配置', () => {
  test('普通消息没有生图意图时不回退全局默认模型', () => {
    defaultSelection = { channelId: 'default', modelId: 'gpt-image-2' }
    expect(resolveRequestImageGeneration(undefined)).toBeUndefined()
  })

  test('明确生图请求可以使用全局默认模型', () => {
    defaultSelection = { channelId: 'default', modelId: 'gpt-image-2' }
    expect(resolveRequestImageGeneration(undefined, true)).toEqual(defaultSelection)
  })

  test('显式选择但没有本轮生图意图也不获得授权', () => {
    expect(resolveRequestImageGeneration({ channelId: 'selected', modelId: 'gpt-image-2' })).toBeUndefined()
  })
})
