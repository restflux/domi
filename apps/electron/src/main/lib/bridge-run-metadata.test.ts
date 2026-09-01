import { describe, expect, test } from 'bun:test'
import type { AgentThinkingLevel, Channel } from '@domi/shared'
import type { AppSettings } from '../../types'
import {
  appendBridgeRunMetadata,
  applyResolvedBridgeModel,
  formatBridgeProcessingMessage,
  formatBridgeRunMetadataCompact,
  formatBridgeRuntimeStatusLines,
  formatBridgeThinkingLevel,
  resolveBridgeRunMetadataWithDependencies,
  type BridgeRunMetadata,
  type BridgeRunMetadataDependencies,
} from './bridge-run-metadata'

const metadata: BridgeRunMetadata = {
  channelName: 'OpenAI',
  modelId: 'gpt-5.6-sol',
  modelName: 'GPT 5.6 Sol',
  modelValid: true,
  thinkingLevel: 'high',
}

const settings = {
  agentThinking: { type: 'adaptive' },
  agentEffort: 'medium',
} as AppSettings

const channel: Channel = {
  id: 'channel-1',
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://example.com',
  apiKey: 'encrypted',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  models: [{ id: 'custom-reasoner', name: 'Custom Reasoner', enabled: true }],
}

function dependencies(overrides: Partial<BridgeRunMetadataDependencies> = {}): BridgeRunMetadataDependencies {
  return {
    getChannel: () => channel,
    resolveReasoningCapability: async () => ({
      source: 'provider-metadata',
      levels: ['off', 'low', 'high'],
      defaultLevel: 'low',
    }),
    resolveThinkingLevel: (_settings, sessionMeta, _provider, _modelId, capability) => {
      const requested = sessionMeta?.reasoningLevel ?? sessionMeta?.openAIThinkingLevel
      if (requested && capability?.levels.includes(requested)) return requested
      return capability?.defaultLevel ?? requested ?? 'medium'
    },
    ...overrides,
  }
}

describe('IM Bridge 运行元信息解析', () => {
  test('Given 会话显式推理档位 When 解析运行元信息 Then 使用会话档位和模型展示名', async () => {
    const result = await resolveBridgeRunMetadataWithDependencies({
      channelId: channel.id,
      modelId: 'custom-reasoner',
      sessionMeta: { reasoningLevel: 'high' },
      settings,
    }, dependencies())

    expect(result).toEqual({
      channelName: 'OpenAI',
      modelId: 'custom-reasoner',
      modelName: 'Custom Reasoner',
      modelValid: true,
      thinkingLevel: 'high',
    })
  })

  test('Given 历史会话推理字段 When 解析运行元信息 Then 兼容 openAIThinkingLevel', async () => {
    const result = await resolveBridgeRunMetadataWithDependencies({
      channelId: channel.id,
      modelId: 'custom-reasoner',
      sessionMeta: { openAIThinkingLevel: 'low' },
      settings,
    }, dependencies())

    expect(result.thinkingLevel).toBe('low')
  })

  test('Given 无会话档位且供应商提供默认档位 When 解析 Then 使用模型能力默认值', async () => {
    const result = await resolveBridgeRunMetadataWithDependencies({
      channelId: channel.id,
      modelId: 'custom-reasoner',
      settings,
    }, dependencies())

    expect(result.thinkingLevel).toBe('low')
  })

  test('Given 能力目录解析失败 When 解析 Then 回退会话档位且不阻断', async () => {
    const result = await resolveBridgeRunMetadataWithDependencies({
      channelId: channel.id,
      modelId: 'custom-reasoner',
      sessionMeta: { reasoningLevel: 'xhigh' },
      settings,
    }, dependencies({
      resolveReasoningCapability: async () => { throw new Error('catalog unavailable') },
      resolveThinkingLevel: (_settings, sessionMeta) => sessionMeta?.reasoningLevel ?? 'medium',
    }))

    expect(result.thinkingLevel).toBe('xhigh')
    expect(result.modelName).toBe('Custom Reasoner')
  })
})

describe('IM Bridge 运行元信息格式化', () => {
  test.each([
    ['off', 'Off'],
    ['minimal', 'Minimal'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'XHigh'],
    ['max', 'Max'],
  ] as const)('Given 推理档位 %s When 格式化 Then 显示 %s', (level, label) => {
    expect(formatBridgeThinkingLevel(level as AgentThinkingLevel)).toBe(label)
  })

  test('Given 运行元信息 When 构建处理中提示 Then 同时显示模型和推理强度', () => {
    expect(formatBridgeProcessingMessage('Domi', '微信会话', metadata)).toBe(
      'Domi → 微信会话: ⏳ Agent 处理中...\n模型 GPT 5.6 Sol · 推理 High',
    )
  })

  test('Given runtime 确认不同模型 When 更新元信息 Then 最终展示实际模型 ID', () => {
    expect(applyResolvedBridgeModel(metadata, 'gpt-5.6-sol-202608')).toMatchObject({
      modelId: 'gpt-5.6-sol-202608',
      modelName: 'gpt-5.6-sol-202608',
      thinkingLevel: 'high',
    })
  })

  test('Given Agent 最终文本 When 追加元信息 Then 使用独立紧凑行', () => {
    expect(appendBridgeRunMetadata('已完成。', metadata)).toBe(
      '已完成。\n\n— 模型 GPT 5.6 Sol · 推理 High',
    )
  })

  test('Given 有效模型 When 构建纯文本和 Markdown 状态 Then 都显示推理强度', () => {
    expect(formatBridgeRuntimeStatusLines(metadata)).toEqual([
      '模型: OpenAI / GPT 5.6 Sol',
      '推理强度: High',
    ])
    expect(formatBridgeRuntimeStatusLines(metadata, true)).toEqual([
      '**模型**: OpenAI / GPT 5.6 Sol',
      '**推理强度**: High',
    ])
  })

  test('Given 已失效模型 When 构建状态 Then 明确标记但仍保留推理档位', () => {
    expect(formatBridgeRuntimeStatusLines({ ...metadata, modelValid: false })).toEqual([
      '模型: OpenAI / GPT 5.6 Sol（已失效）',
      '推理强度: High',
    ])
  })

  test('Given 运行元信息 When 构建紧凑格式 Then 不包含推理正文', () => {
    expect(formatBridgeRunMetadataCompact(metadata)).toBe('模型 GPT 5.6 Sol · 推理 High')
  })
})
