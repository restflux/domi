import { describe, expect, test } from 'bun:test'
import { OpenAIAdapter } from './openai-adapter.ts'
import { getAdapter } from './index.ts'

function buildTitleBody(provider: 'openai' | 'opencode-go-openai' | 'custom' | 'zhipu'): Record<string, unknown> {
  const request = new OpenAIAdapter(provider).buildTitleRequest({
    baseUrl: provider === 'opencode-go-openai'
      ? 'https://opencode.ai/zen/go/v1'
      : 'https://api.openai.com/v1',
    apiKey: 'test-key',
    modelId: 'glm-5.2',
    prompt: '生成标题',
  })

  return JSON.parse(request.body) as Record<string, unknown>
}

describe('OpenAIAdapter 标题生成请求', () => {
  test('Given 任意 OpenAI 兼容渠道（含推理模型）When 生成标题 Then 预留足够的输出预算', () => {
    // GLM / DeepSeek / Qwen 等推理模型默认输出思考内容且计入 completion 预算，
    // 预算不足时 message.content 为空，自动命名会停留在默认标题。
    for (const provider of ['openai', 'opencode-go-openai', 'custom', 'zhipu'] as const) {
      expect(buildTitleBody(provider).max_tokens).toBe(512)
    }
  })

  test('Given Qwen Token Plan Individual When 构建请求 Then 使用独立 OpenAI Chat Completions 端点', () => {
    const request = getAdapter('qwen-token-plan-individual').buildTitleRequest({
      baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: 'test-key',
      modelId: 'qwen3.8-max',
      prompt: '生成标题',
    })

    expect(request.url).toBe(
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    )
    expect(request.headers.Authorization).toBe('Bearer test-key')
  })
})
