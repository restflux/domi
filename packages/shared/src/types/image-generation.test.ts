import { describe, expect, test } from 'bun:test'
import { getImageGenerationQualities } from './image-generation'

describe('生图模型质量能力', () => {
  test('2.5 两种模型及官方快照提供额外质量档位', () => {
    for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08']) {
      expect(getImageGenerationQualities(model)).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    }
  })
  test('旧模型和未知模型不会误用 2.5 质量参数', () => {
    expect(getImageGenerationQualities('gpt-image-2')).toEqual(['auto', 'low', 'medium', 'high'])
    expect(getImageGenerationQualities('gemini-3.1-flash-image')).toEqual(['auto'])
    expect(getImageGenerationQualities('custom-image')).toEqual(['auto'])
    expect(getImageGenerationQualities('gpt-image-2.5-flare-experimental')).not.toContain('max')
  })
})
