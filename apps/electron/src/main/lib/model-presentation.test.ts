import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  filterToolsForModelPresentation,
  MINIMAL_PRESET_SYSTEM_PROMPT,
  resolveModelPresentationSystemPrompt,
} from './model-presentation'

function tool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
    execute: async () => ({ content: [], details: undefined }),
  }
}

describe('Model presentation preset filter', () => {
  const representativeTools = [
    tool('read'),
    tool('bash'),
    tool('edit'),
    tool('write'),
    tool('grep'),
    tool('find'),
    tool('ls'),
    tool('TaskCreate'),
    tool('CompactContext'),
    tool('custom-extension'),
  ]

  test('Given standard preset When filtering Then returns every tool unchanged', () => {
    const filtered = filterToolsForModelPresentation(representativeTools, 'standard')
    expect(filtered).toEqual(representativeTools)
  })

  test('Given minimal preset When filtering Then keeps only bash and edit', () => {
    const filtered = filterToolsForModelPresentation(representativeTools, 'minimal')
    expect(filtered.map((definition) => definition.name)).toEqual(['bash', 'edit'])
  })

  test('Given minimal preset When filtering Then preserves original definition references', () => {
    // 过滤只收窄模型可见面；保留对象引用确保 adapter 的 guard 包装
    //（wrapActiveTools / 文件 checkpoint wrapper）不会因复制而失效。
    const filtered = filterToolsForModelPresentation(representativeTools, 'minimal')
    expect(filtered[0]).toBe(representativeTools[1])
    expect(filtered[1]).toBe(representativeTools[2])
  })

  test('Given minimal preset When filtering an empty list Then returns empty list', () => {
    expect(filterToolsForModelPresentation([], 'minimal')).toEqual([])
  })
})

describe('Model presentation system prompt', () => {
  test('Given minimal preset Then resolves to the fixed harness-parity prompt', () => {
    const standard = '完整 Domi 行为规则与上下文'
    expect(resolveModelPresentationSystemPrompt('minimal', standard))
      .toBe(MINIMAL_PRESET_SYSTEM_PROMPT)
  })

  test('Given standard preset Then keeps the standard prompt untouched', () => {
    const standard = '完整 Domi 行为规则与上下文'
    expect(resolveModelPresentationSystemPrompt('standard', standard)).toBe(standard)
  })
})
