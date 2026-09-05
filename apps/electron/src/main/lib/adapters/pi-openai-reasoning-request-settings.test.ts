import { describe, expect, test } from 'bun:test'
import { injectOpenAIReasoningLevel } from './pi-openai-reasoning-request-settings'

describe('远端模型思考档位请求映射', () => {
  test('Given 新模型不在名称 profile 中 When 目录映射 Max Then Responses 发送真实 effort', () => {
    expect(injectOpenAIReasoningLevel({ model: 'gpt-6-astra' }, {
      thinkingLevel: 'max', thinkingLevelMap: { high: 'high', max: 'max' },
    })).toEqual({ model: 'gpt-6-astra', reasoning: { effort: 'max' } })
  })
  test('Given 目录将 Max 映射为 xhigh When 构造请求 Then 不沿用旧家族的 Max 映射', () => {
    expect(injectOpenAIReasoningLevel({ model: 'gpt-5.6-sol' }, {
      thinkingLevel: 'max', thinkingLevelMap: { max: 'xhigh' },
    })).toMatchObject({ reasoning: { effort: 'xhigh' } })
  })
  test('Given 目录不支持 Off When 关闭推理 Then 不编造 none 或 off 参数', () => {
    const payload = { model: 'gpt-6-astra' }
    expect(injectOpenAIReasoningLevel(payload, { thinkingLevel: 'off', thinkingLevelMap: { off: null } })).toBe(payload)
  })
  test('Given 目录明确将 Off 映射为 none When 关闭推理 Then 覆盖默认 effort', () => {
    expect(injectOpenAIReasoningLevel({ model: 'gpt-6-astra', reasoning: { effort: 'medium' } }, {
      thinkingLevel: 'off', thinkingLevelMap: { off: 'none' },
    })).toMatchObject({ reasoning: { effort: 'none' } })
  })
})
