import { describe, expect, test } from 'bun:test'
import type { Channel, ProviderType } from '@domi/shared'
import { collectVisionRelayModelOptions } from './vision-relay-model-options'

const channels: Channel[] = [{
  id: 'channel-1', name: 'Mixed', provider: 'openai', baseUrl: 'https://api.example', apiKey: 'encrypted', enabled: true,
  createdAt: 1, updatedAt: 1,
  models: [
    { id: 'vision-model', name: 'Vision', enabled: true },
    { id: 'text-model', name: 'Text', enabled: true },
    { id: 'disabled-vision', name: 'Disabled', enabled: false },
  ],
}]

describe('Vision Relay target model options', () => {
  test('returns only enabled models confirmed to support image input', async () => {
    const result = await collectVisionRelayModelOptions(channels, async (_provider: ProviderType, modelId) => (
      modelId.includes('vision') ? 'supported' : 'unsupported'
    ))
    expect(result).toEqual([{
      channelId: 'channel-1', channelName: 'Mixed', provider: 'openai',
      modelId: 'vision-model', modelName: 'Vision',
    }])
  })

  test('unknown capability fails closed', async () => {
    expect(await collectVisionRelayModelOptions(channels, async () => 'unknown')).toEqual([])
  })
})
