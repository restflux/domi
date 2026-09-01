import { describe, expect, test } from 'bun:test'
import type { ChannelModel } from '@domi/shared'
import { mergeFetchedChannelModels } from './channel-model-merge'

describe('供应商模型清单合并', () => {
  test('preserves enabled state and temporary adaptation while accepting fresh provider metadata', () => {
    const previous: ChannelModel[] = [{
      id: 'ox-alpha-free',
      name: 'Old name',
      enabled: true,
      temporaryAdaptation: { contextWindow: 1_000_000, reasoningLevels: ['low', 'high', 'max'] },
      providerMetadata: { contextWindow: 100 },
    }]
    const fetched: ChannelModel[] = [{
      id: 'ox-alpha-free',
      name: 'Ox Alpha Free',
      enabled: true,
      source: 'fetched',
      providerMetadata: { contextWindow: 2_000_000 },
    }]

    expect(mergeFetchedChannelModels({ previous, fetched, provider: 'opencode-go-openai' })).toEqual([{
      id: 'ox-alpha-free',
      name: 'Ox Alpha Free',
      enabled: true,
      source: 'fetched',
      providerMetadata: { contextWindow: 2_000_000 },
      temporaryAdaptation: { contextWindow: 1_000_000, reasoningLevels: ['low', 'high', 'max'] },
    }])
  })

  test('keeps adapted models omitted by supplier and drops stale ordinary fetched models', () => {
    const previous: ChannelModel[] = [
      { id: 'adapted', name: 'Adapted', enabled: true, source: 'fetched', temporaryAdaptation: { maxTokens: 10 } },
      { id: 'stale', name: 'Stale', enabled: true, source: 'fetched' },
      { id: 'manual', name: 'Manual', enabled: true, source: 'manual' },
    ]
    expect(mergeFetchedChannelModels({ previous, fetched: [], provider: 'custom' }).map((model) => model.id))
      .toEqual(['adapted', 'manual'])
  })

  test('adds built-in Ox Alpha adaptation when the supplier discovers it for the first time', () => {
    const [model] = mergeFetchedChannelModels({
      previous: [],
      fetched: [{ id: 'ox-alpha-free', name: 'ox-alpha-free', enabled: true, source: 'fetched' }],
      provider: 'opencode-go-openai',
    })
    expect(model?.enabled).toBe(false)
    expect(model?.temporaryAdaptation).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      reasoningLevels: ['low', 'high', 'max'],
    })
  })
})
