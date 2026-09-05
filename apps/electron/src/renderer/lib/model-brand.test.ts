import { describe, expect, test } from 'bun:test'
import { resolveModelBrand, resolveChannelBrand, resolveProviderBrand } from './model-brand'

describe('模型品牌按家族匹配，不依赖固定版本', () => {
  const examples = [
    ['gpt-6-astra', 'openai'], ['gpt-oss-120b-medium', 'openai'], ['gpt-image-2', 'openai'],
    ['gpt-42-mini', 'openai'], ['o12-mini', 'openai'], ['chatgpt-latest', 'openai'],
    ['claude-sonnet-9', 'claude'], ['anthropic-next', 'claude'], ['deepseek-v9', 'deepseek'],
    ['gemini-7-flash', 'gemini'], ['gemma4', 'gemma'], ['veo-5', 'gemini'],
    ['qwen4-235b', 'qwen'], ['qwq-32b', 'qwen'], ['qvq-max', 'qwen'], ['wan2.8', 'qwen'],
    ['grok-9', 'grok'], ['kimi-k5', 'kimi'], ['moonshot-v2', 'kimi'],
    ['doubao-seed-3', 'doubao'], ['seed-4', 'doubao'], ['glm-9', 'zhipu'],
    ['chatglm4', 'zhipu'], ['cogview-5', 'zhipu'], ['zhipu-next', 'zhipu'],
    ['llama-6', 'meta'], ['mistral-large-3', 'mistral'], ['mixtral-8x22b', 'mistral'],
    ['codestral-2701', 'mistral'], ['ministral-8b', 'mistral'], ['magistral-medium', 'mistral'],
    ['pixtral-large', 'mistral'], ['devstral-next', 'mistral'], ['yi-2', 'yi'],
    ['ernie-5', 'wenxin'], ['tao-2', 'wenxin'], ['hunyuan-turbo', 'hunyuan'],
    ['sparkdesk-v5', 'spark'], ['generalv4', 'spark'], ['step-4', 'stepfun'],
    ['minimax-m3', 'minimax'], ['mimo-v3', 'xiaomi'], ['cohere-next', 'cohere'],
    ['command-r-plus', 'cohere'], ['text-embedding-4', 'embedding'], ['embedding-3', 'embedding'],
  ] as const
  test.each(examples)('%s → %s', (model, brand) => expect(resolveModelBrand(model)).toBe(brand))

  test.each(['deepgemini', 'kimigemini', 'qwengemini', 'seedgemini'] as const)('组合品牌 %s 不被通用规则覆盖', (brand) => {
    expect(resolveModelBrand(`${brand}-3-pro`)).toBe(brand)
  })

  test.each([
    ['OpenAI/GPT-6-ASTRA', 'openai'], ['anthropic/claude-opus-5', 'claude'],
    ['google/gemma4', 'gemma'], ['Qwen/Qwen4-32B', 'qwen'],
    ['deepseek-ai/DeepSeek-V4', 'deepseek'], ['meta-llama/Llama-5', 'meta'],
    ['z-ai/glm-5', 'zhipu'], ['mistralai/devstral-3', 'mistral'],
  ] as const)('明确发布者命名空间 %s → %s', (id, brand) => expect(resolveModelBrand(id)).toBe(brand))

  test.each(['', 'custom-smart', 'my-gpt-6', 'notclaude', 'workflow-o1', 'footstep',
    'yiwen', 'commandcenter', 'geminix', 'seedling', 'google/gpt-6',
    'unknown/gpt-6', 'openai/custom-name', 'proxy/openai/gpt-6', 'https://openai.com/gpt-6'])
  ('未知别名或冲突命名 %s 不猜测品牌', (id) => expect(resolveModelBrand(id)).toBeUndefined())
})

describe('渠道品牌与模型家族分离', () => {
  test('兼容协议不代表模型厂商', () => {
    expect(resolveProviderBrand('anthropic-compatible')).toBeUndefined()
    expect(resolveProviderBrand('custom')).toBeUndefined()
    expect(resolveProviderBrand('openai-responses')).toBe('openai')
    expect(resolveModelBrand('private-model')).toBeUndefined()
    expect(resolveModelBrand('claude-sonnet-5')).toBe('claude')
  })
  test.each([
    ['https://api.moonshot.cn/v1', 'kimi'], ['https://api.deepseek.com/v1', 'deepseek'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen'],
    ['https://api.x.ai/v1', 'grok'], ['https://api.minimax.io/v1', 'minimax'],
    ['https://api.openai.com/v1', 'openai'],
  ] as const)('已知官方 hostname %s → %s', (baseUrl, brand) => {
    expect(resolveChannelBrand({ provider: 'custom', baseUrl })).toBe(brand)
  })
  test.each(['https://openai.com.attacker.example/v1', 'https://notkimi.example',
    'https://relay.example/v1/openai.com', 'https://openai.com@relay.example/v1',
    'https://relay.example/?next=moonshot.cn', 'https://oss.aliyuncs.com/v1', 'not a URL'])
  ('地址 %s 不因子串误标品牌', (baseUrl) => {
    expect(resolveChannelBrand({ provider: 'custom', baseUrl })).toBeUndefined()
  })
  test('明确供应商品牌保持不变', () => {
    expect(resolveChannelBrand({ provider: 'deepseek', baseUrl: 'https://relay.example' })).toBe('deepseek')
    expect(resolveProviderBrand('qwen-token-plan')).toBe('qwen')
    expect(resolveProviderBrand('openai-codex')).toBe('openai')
  })
})
