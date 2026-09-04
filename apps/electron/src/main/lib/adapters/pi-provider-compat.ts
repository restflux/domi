import type { ProviderType } from '@domi/shared'

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' && url.hostname === 'api.openai.com'
  } catch {
    return false
  }
}

/**
 * 某些 OpenAI 兼容接口只接受 system、user、assistant 和 tool 角色。
 * Pi 默认会把系统提示词编码为 developer，因此必须显式请求降级为 system。
 *
 * 用户可能为了复用模型列表与 URL 补全能力，把第三方中转站配置成 OpenAI。
 * 只有 OpenAI 官方地址可以安全假定支持 developer；其他兼容地址统一降级为
 * 接受范围更广的 system。Responses 协议不经过 Chat Completions 的角色转换。
 */
export function supportsPiDeveloperRole(provider: ProviderType, baseUrl?: string): boolean {
  if (provider === 'openai') {
    return isOfficialOpenAIBaseUrl(baseUrl)
  }

  return provider !== 'doubao'
    && provider !== 'custom'
    && provider !== 'qwen-token-plan-individual'
}
