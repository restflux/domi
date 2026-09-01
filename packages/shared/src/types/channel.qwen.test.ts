import { describe, expect, test } from 'bun:test'
import {
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
  QWEN_TOKEN_PLAN_INDIVIDUAL_PRESET_MODELS,
  QWEN_TOKEN_PLAN_PRESET_MODELS,
} from './channel'

describe('Qwen Token Plan 渠道预设', () => {
  test('Given 中国区新建渠道 When 读取预设 Then 使用稳定 qwen3.8-max 且不再新增 preview', () => {
    expect(QWEN_TOKEN_PLAN_PRESET_MODELS.map((model) => model.id)).toEqual([
      'qwen3.8-max',
      'qwen3.7-max',
      'qwen3.6-flash',
    ])
    expect(QWEN_TOKEN_PLAN_PRESET_MODELS.some((model) => model.id === 'qwen3.8-max-preview')).toBe(false)
  })

  test('Given 国际 Individual 渠道 When 读取配置 Then 使用独立 URL 与 Pi 0.84.1 模型目录', () => {
    expect(PROVIDER_DEFAULT_URLS['qwen-token-plan-individual']).toBe(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    )
    expect(PROVIDER_LABELS['qwen-token-plan-individual']).toContain('Individual')
    expect(QWEN_TOKEN_PLAN_INDIVIDUAL_PRESET_MODELS.map((model) => model.id)).toEqual([
      'deepseek-v4-flash-0731',
      'deepseek-v4-pro',
      'glm-5.2',
      'qwen3.6-flash',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.8-max',
    ])
  })
})
