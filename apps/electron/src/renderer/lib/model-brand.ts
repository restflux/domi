import type { ProviderType } from '@domi/shared'

/** 品牌身份与请求协议分离；此模块不依赖图片或 React，供各展示入口共用。 */
const MODEL_BRAND_RULES = [
  // 已有组合模型有专用图标，必须先于单一品牌匹配。
  ['deepgemini', /^deepgemini(?=$|[-_.\d])/],
  ['kimigemini', /^kimigemini(?=$|[-_.\d])/],
  ['qwengemini', /^qwengemini(?=$|[-_.\d])/],
  ['seedgemini', /^seedgemini(?=$|[-_.\d])/],
  ['openai', /^(?:gpt(?=$|[-_.\d])|gpts$|chatgpt(?=$|[-_.\d])|o\d+(?=$|[-_.]))/],
  ['claude', /^(?:claude|anthropic)(?=$|[-_.\d])/],
  ['deepseek', /^deepseek(?=$|[-_.\d])/],
  ['gemini', /^(?:gemini|veo)(?=$|[-_.\d])/],
  ['gemma', /^gemma(?=$|[-_.\d])/],
  ['qwen', /^(?:qwen|qwq|qvq|wan)(?=$|[-_.\d])/],
  ['grok', /^grok(?=$|[-_.\d])/],
  ['kimi', /^(?:kimi|moonshot)(?=$|[-_.\d])/],
  ['doubao', /^(?:doubao|seed)(?=$|[-_.\d])/],
  ['zhipu', /^(?:glm|chatglm|zhipu|cogview)(?=$|[-_.\d])/],
  ['meta', /^llama(?=$|[-_.\d])/],
  ['mistral', /^(?:mistral|mixtral|codestral|devstral|ministral|pixtral|magistral)(?=$|[-_.\d])/],
  ['yi', /^yi(?=$|[-_.\d])/],
  ['wenxin', /^(?:ernie|wenxin|tao)(?=$|[-_.\d])/],
  ['hunyuan', /^hunyuan(?=$|[-_.\d])/],
  ['spark', /^(?:sparkdesk|spark|generalv)(?=$|[-_.\d])/],
  ['stepfun', /^(?:step|stepfun)(?=$|[-_.\d])/],
  ['minimax', /^minimax(?=$|[-_.\d])/],
  ['xiaomi', /^mimo(?=$|[-_.\d])/],
  ['cohere', /^(?:cohere|command)(?=$|[-_.\d])/],
  ['embedding', /^(?:text-embedding|embedding)(?=$|[-_.\d])/],
] as const

export type ModelBrand = typeof MODEL_BRAND_RULES[number][0] | 'opencode'

const PUBLISHERS: Record<string, readonly ModelBrand[]> = {
  openai: ['openai', 'embedding'], anthropic: ['claude'], deepseek: ['deepseek'],
  'deepseek-ai': ['deepseek'], google: ['gemini', 'gemma'], qwen: ['qwen'],
  'qwen-ai': ['qwen'], 'x-ai': ['grok'], xai: ['grok'], moonshotai: ['kimi'],
  'moonshot-ai': ['kimi'], zhipu: ['zhipu'], zai: ['zhipu'], 'z-ai': ['zhipu'],
  thudm: ['zhipu'], 'meta-llama': ['meta'], meta: ['meta'], mistralai: ['mistral'],
  '01-ai': ['yi'], baidu: ['wenxin'], tencent: ['hunyuan'], stepfun: ['stepfun'],
  'stepfun-ai': ['stepfun'], minimax: ['minimax'], 'minimaxai': ['minimax'],
  xiaomi: ['xiaomi'], cohere: ['cohere'], bytedance: ['doubao'],
}

export function resolveModelBrand(modelId: string): ModelBrand | undefined {
  const id = modelId.trim().toLowerCase()
  const parts = id.split('/')
  if (parts.length > 2) return undefined
  const name = parts.at(-1) ?? ''
  const brand = MODEL_BRAND_RULES.find(([, pattern]) => pattern.test(name))?.[0]
  if (parts.length === 2 && (!brand || !PUBLISHERS[parts[0] ?? '']?.includes(brand))) return undefined
  return brand
}

const PROVIDER_BRANDS: Record<ProviderType, ModelBrand | undefined> = {
  anthropic: 'claude', 'anthropic-compatible': undefined,
  openai: 'openai', 'openai-responses': 'openai', 'openai-codex': 'openai',
  deepseek: 'deepseek', google: 'gemini', 'kimi-api': 'kimi', 'kimi-coding': 'kimi',
  'opencode-go-openai': 'opencode', zhipu: 'zhipu', 'zhipu-coding': 'zhipu',
  'zhipu-coding-team': 'zhipu', 'ark-coding-plan': 'doubao', minimax: 'minimax',
  doubao: 'doubao', qwen: 'qwen', 'qwen-anthropic': 'qwen',
  'qwen-token-plan': 'qwen', 'qwen-token-plan-individual': 'qwen',
  xiaomi: 'xiaomi', 'xiaomi-token-plan': 'xiaomi', custom: undefined,
}

export function resolveProviderBrand(provider: ProviderType): ModelBrand | undefined {
  return PROVIDER_BRANDS[provider]
}

const HOST_BRANDS: ReadonlyArray<readonly [string, ModelBrand]> = [
  ['moonshot.cn', 'kimi'], ['moonshot.ai', 'kimi'], ['kimi.com', 'kimi'],
  ['bigmodel.cn', 'zhipu'], ['z.ai', 'zhipu'], ['zhipuai.cn', 'zhipu'],
  ['minimax.io', 'minimax'], ['minimaxi.com', 'minimax'], ['xiaomimimo.com', 'xiaomi'],
  ['volces.com', 'doubao'], ['volcengine.com', 'doubao'],
  ['dashscope.aliyuncs.com', 'qwen'], ['dashscope-intl.aliyuncs.com', 'qwen'], ['dashscope.ai', 'qwen'], ['deepseek.com', 'deepseek'],
  ['openai.com', 'openai'], ['googleapis.com', 'gemini'], ['x.ai', 'grok'],
  ['stepfun.com', 'stepfun'], ['cohere.com', 'cohere'], ['cohere.ai', 'cohere'],
  ['xfyun.cn', 'spark'], ['hunyuan.tencentcloudapi.com', 'hunyuan'],
  ['baidubce.com', 'wenxin'], ['lingyiwanwu.com', 'yi'],
]

export function resolveChannelBrand(channel: { provider: ProviderType; baseUrl: string }): ModelBrand | undefined {
  if (['anthropic', 'anthropic-compatible', 'custom'].includes(channel.provider)) {
    try {
      const url = new URL(channel.baseUrl)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        const host = url.hostname.toLowerCase().replace(/\.$/, '')
        const brand = HOST_BRANDS.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1]
        if (brand) return brand
      }
    } catch { /* 未完成输入或未知地址沿用供应商品牌。 */ }
  }
  return resolveProviderBrand(channel.provider)
}
