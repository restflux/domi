import { describe, expect, test } from 'bun:test'
import type { Channel, ImageGenerationSelection } from '@domi/shared'
import { getImageChannels, parseImageCommand, resolveImageSelection } from './image-generation-selection'
import { createAgentQueuedMessage, restoreQueuedMessageToFront } from './agent-message-queue'

function channel(id: string, provider: Channel['provider'] = 'openai'): Channel {
  return { id, name: id, provider, baseUrl: 'https://example.com', apiKey: 'test-only', enabled: true, models: [], imageGeneration: { protocol: 'openai-images', models: ['gpt-image-2'] }, createdAt: 1, updatedAt: 1 }
}

describe('原生生图选择', () => {
  test('Given 仅生图渠道和订阅渠道 When 列出选择 Then 仅普通启用的 API 渠道可选', () => {
    expect(getImageChannels([channel('image-only'), channel('oauth', 'openai-codex'), { ...channel('off'), enabled: false }, { ...channel('empty'), imageGeneration: null }]).map((item) => item.id)).toEqual(['image-only'])
  })
  test('Given 独立模型和参数 When 默认仍有效 Then 返回选择副本且不混用聊天模型', () => {
    const selected: ImageGenerationSelection = { channelId: 'a', modelId: 'gpt-image-2', numberOfImages: 3, quality: 'high' }
    const resolved = resolveImageSelection([channel('a')], selected)
    expect(resolved).toEqual(selected)
    expect(resolved).not.toBe(selected)
  })
  test('Given 已选渠道已删除 When 开启生图 Then 不静默改用另一供应商', () => {
    expect(resolveImageSelection([channel('b')], { channelId: 'a', modelId: 'old' })).toBeNull()
    expect(resolveImageSelection([channel('b')])).toEqual({ channelId: 'b', modelId: 'gpt-image-2' })
    expect(resolveImageSelection([])).toBeNull()
  })
  test('Given /image 命令 When 提交 Then 不把命令送入模型，普通文本保持不变', () => {
    expect(parseImageCommand('/image  一只猫')).toEqual({ requested: true, text: '一只猫' })
    expect(parseImageCommand('/image')).toEqual({ requested: true, text: '' })
    expect(parseImageCommand('/images abc')).toEqual({ requested: false, text: '/images abc' })
    expect(parseImageCommand('介绍 /image 命令').requested).toBe(false)
  })
  test('Given 已排队请求 When 输入框修改模型或队列失败恢复 Then 保留原选择快照', () => {
    const imageGeneration: ImageGenerationSelection = { channelId: 'a', modelId: 'gpt-image-2', numberOfImages: 2 }
    const message = createAgentQueuedMessage('猫', 'queue-1', 1, null, { kind: 'followUp', imageGeneration })
    imageGeneration.modelId = 'another-model'
    expect(message.imageGeneration?.modelId).toBe('gpt-image-2')
    expect(restoreQueuedMessageToFront([], message)[0]?.imageGeneration).toEqual({ channelId: 'a', modelId: 'gpt-image-2', numberOfImages: 2 })
  })
})
