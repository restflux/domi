import { describe, expect, test } from 'bun:test'
import type { Channel, ImageGenerationSelection } from '@domi/shared'
import { createImageGenerationResolver } from './config-core'

const selection: ImageGenerationSelection = { channelId: 'image-channel', modelId: 'gpt-image-2' }
const channel: Channel = {
  id: selection.channelId, name: '图片', provider: 'openai', enabled: true,
  baseUrl: 'https://api.openai.com/v1', apiKey: 'encrypted', models: [], createdAt: 0, updatedAt: 0,
  imageGeneration: { protocol: 'openai-images', models: ['gpt-image-2', 'gpt-image-2.5-flare'] },
}
function resolver(overrides: Partial<Channel> = {}) {
  let decryptions = 0
  const service = createImageGenerationResolver({
    getDefaultSelection: () => undefined,
    getChannel: () => ({ ...channel, ...overrides }),
    decryptKey: () => { decryptions++; return 'channel-key' },
    getLegacyCredentials: () => ({ apiKey: 'legacy-key' }),
  })
  return { ...service, decryptions: () => decryptions }
}

describe('生图渠道安全边界', () => {
  test('排队后渠道连接变化时拒绝旧快照，不将参考图发送给新的端点', () => {
    const service = resolver({ updatedAt: 2 })
    expect(() => service.resolveConfig('gpt-image', { ...selection, channelUpdatedAt: 1 })).toThrow('配置已变化')
    expect(service.decryptions()).toBe(0)
  })
  test('Given 显式选择 OpenAI When 调用 Gemini 工具 Then 拒绝而不回退旧凭据', () => {
    const service = resolver()
    expect(() => service.resolveConfig('nano-banana', selection)).toThrow('不匹配')
    expect(service.decryptions()).toBe(0)
  })
  test('Given 新模型 max 质量 When 解析 Then 保留参数但旧模型拒绝', () => {
    const service = resolver()
    expect(service.resolveConfig('gpt-image', { ...selection, modelId: 'gpt-image-2.5-flare', quality: 'max', numberOfImages: 2 })).toMatchObject({ model: 'gpt-image-2.5-flare', quality: 'max', numberOfImages: 2, apiKey: 'channel-key' })
    expect(() => service.resolveConfig('gpt-image', { ...selection, quality: 'max' })).toThrow('quality')
  })
  test('Given 没有默认或显式选择 When 解析 Then 只读旧凭据并保留旧模型默认值', () => {
    const service = resolver()
    expect(service.resolveConfig('gpt-image')).toMatchObject({ apiKey: 'legacy-key', model: 'gpt-image-2' })
    expect(service.resolveConfig('nano-banana')).toMatchObject({ apiKey: 'legacy-key', model: 'gemini-3.1-flash-image-preview' })
    expect(service.decryptions()).toBe(0)
  })
  test('Given 自定义渠道未配置图片根地址或聊天URL When 解析 Then 拒绝', () => {
    expect(() => resolver({ provider: 'custom' }).resolveConfig('gpt-image', selection)).toThrow('根地址')
    expect(() => resolver({ baseUrl: 'https://example.com/v1/chat/completions' }).resolveConfig('gpt-image', selection)).toThrow('根地址')
  })
  test('Given 设置默认选择 When 解析 Then 返回白名单拷贝且无效默认不回退', () => {
    const original = { ...selection, apiKey: 'must-not-copy' }
    const service = createImageGenerationResolver({ getDefaultSelection: () => original, getChannel: () => channel, decryptKey: () => 'key', getLegacyCredentials: () => ({ apiKey: 'legacy' }) })
    const resolved = service.resolveSelection()
    expect(resolved).toEqual({ ...selection, channelUpdatedAt: 0 })
    expect(resolved).not.toBe(original)
    original.modelId = 'not-configured'
    expect(() => service.resolveConfig('gpt-image')).toThrow()
    expect(service.isAvailable('gpt-image')).toBe(false)
  })
  test('Given OAuth 或订阅渠道即使显式声明生图 When 解析 Then 解密前拒绝', () => {
    for (const provider of ['openai-codex', 'kimi-coding', 'anthropic'] as const) {
      const service = resolver({ provider })
      expect(() => service.resolveConfig('gpt-image', selection)).toThrow()
      expect(service.decryptions()).toBe(0)
    }
  })
})
