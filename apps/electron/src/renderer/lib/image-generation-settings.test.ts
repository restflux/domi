import { afterEach, describe, expect, test } from 'bun:test'
import type { ImageGenerationSelection } from '@domi/shared'
import { persistImageSelection, type ImageGenerationSessionSettings } from './image-generation-settings'

const originalWindow = globalThis.window

afterEach(() => { globalThis.window = originalWindow })

describe('按会话持久化生图选择', () => {
  test('Given Chat 与 Work 同时修改选择 When 写入 settings.json Then 保留两个独立 scope 且不覆盖默认值或聊天模型', async () => {
    let settings: ImageGenerationSessionSettings & { imageGeneration: ImageGenerationSelection; agentModelId: string } = {
      imageGeneration: { channelId: 'default', modelId: 'default-image' }, agentModelId: 'chat-model',
    }
    globalThis.window = { electronAPI: {
      getSettings: async () => ({ ...settings }),
      updateSettings: async (update: ImageGenerationSessionSettings) => { settings = { ...settings, ...update }; return settings },
    } } as unknown as Window & typeof globalThis
    await Promise.all([
      persistImageSelection('chat:a', { channelId: 'a', modelId: 'image-a', quality: 'high' }),
      persistImageSelection('work:b', { channelId: 'b', modelId: 'image-b' }),
    ])
    expect(settings.imageGenerationSelections).toEqual({ 'chat:a': { channelId: 'a', modelId: 'image-a', quality: 'high' }, 'work:b': { channelId: 'b', modelId: 'image-b' } })
    expect(settings.agentModelId).toBe('chat-model')
    expect(settings.imageGeneration.modelId).toBe('default-image')
    await persistImageSelection('chat:a', null)
    expect(settings.imageGenerationSelections?.['chat:a']).toBeNull()
    expect(settings.imageGenerationSelections?.['work:b']?.modelId).toBe('image-b')
  })
  test('Given 一次写盘失败 When 之后重新保存 Then 后续请求不被失败的队列阻塞', async () => {
    let fail = true
    let saved: ImageGenerationSessionSettings = {}
    globalThis.window = { electronAPI: {
      getSettings: async () => saved,
      updateSettings: async (update: ImageGenerationSessionSettings) => { if (fail) { fail = false; throw new Error('write failed') }; saved = update; return saved },
    } } as unknown as Window & typeof globalThis
    await expect(persistImageSelection('work:a', null)).rejects.toThrow('write failed')
    await persistImageSelection('work:a', { channelId: 'a', modelId: 'image-a' })
    expect(saved.imageGenerationSelections?.['work:a']?.modelId).toBe('image-a')
  })
})
