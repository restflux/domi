/** LobeHub 官方 SVG 按需静态导入，由 Vite 打包；运行时不访问 CDN。 */
import type { ProviderType } from '@domi/shared'
import { resolveModelBrand, resolveProviderBrand, resolveChannelBrand, type ModelBrand } from './model-brand'
import DefaultLogo from '@/assets/brand/domi-mark-small.png'
import openaiLogo from '@lobehub/icons-static-svg/icons/openai.svg'
import claudeLogo from '@lobehub/icons-static-svg/icons/claude-color.svg'
import deepseekLogo from '@lobehub/icons-static-svg/icons/deepseek-color.svg'
import geminiLogo from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import gemmaLogo from '@lobehub/icons-static-svg/icons/gemma-color.svg'
import qwenLogo from '@lobehub/icons-static-svg/icons/qwen-color.svg'
import grokLogo from '@lobehub/icons-static-svg/icons/grok.svg'
import kimiLogo from '@lobehub/icons-static-svg/icons/kimi.svg'
import doubaoLogo from '@lobehub/icons-static-svg/icons/doubao-color.svg'
import zhipuLogo from '@lobehub/icons-static-svg/icons/zhipu-color.svg'
import metaLogo from '@lobehub/icons-static-svg/icons/meta-color.svg'
import mistralLogo from '@lobehub/icons-static-svg/icons/mistral-color.svg'
import yiLogo from '@lobehub/icons-static-svg/icons/yi-color.svg'
import wenxinLogo from '@lobehub/icons-static-svg/icons/wenxin-color.svg'
import hunyuanLogo from '@lobehub/icons-static-svg/icons/hunyuan-color.svg'
import sparkLogo from '@lobehub/icons-static-svg/icons/spark-color.svg'
import stepfunLogo from '@lobehub/icons-static-svg/icons/stepfun-color.svg'
import minimaxLogo from '@lobehub/icons-static-svg/icons/minimax-color.svg'
import xiaomiLogo from '@lobehub/icons-static-svg/icons/xiaomimimo.svg'
import cohereLogo from '@lobehub/icons-static-svg/icons/cohere-color.svg'
import opencodeLogo from '@lobehub/icons-static-svg/icons/opencode.svg'
import deepgeminiLogo from '@/assets/models/deepgemini.png'
import kimigeminiLogo from '@/assets/models/kimigemini.png'
import qwengeminiLogo from '@/assets/models/qwengemini.png'
import seedgeminiLogo from '@/assets/models/seedgemini.png'
import embeddingLogo from '@/assets/models/embedding.png'

const BRAND_LOGOS: Record<ModelBrand, string> = {
  openai: openaiLogo,
  claude: claudeLogo,
  deepseek: deepseekLogo,
  gemini: geminiLogo,
  gemma: gemmaLogo,
  qwen: qwenLogo,
  grok: grokLogo,
  kimi: kimiLogo,
  doubao: doubaoLogo,
  zhipu: zhipuLogo,
  meta: metaLogo,
  mistral: mistralLogo,
  yi: yiLogo,
  wenxin: wenxinLogo,
  hunyuan: hunyuanLogo,
  spark: sparkLogo,
  stepfun: stepfunLogo,
  minimax: minimaxLogo,
  xiaomi: xiaomiLogo,
  cohere: cohereLogo,
  opencode: opencodeLogo,
  deepgemini: deepgeminiLogo,
  kimigemini: kimigeminiLogo,
  qwengemini: qwengeminiLogo,
  seedgemini: seedgeminiLogo,
  embedding: embeddingLogo,
}

/** 单色 SVG 在 img 中不继承页面颜色，交给 BrandLogo 在深色主题反相为白色。 */
export const MONOCHROME_LOGOS: ReadonlySet<string> = new Set([
  openaiLogo, grokLogo, kimiLogo, xiaomiLogo, opencodeLogo,
])

export function getModelLogoById(modelId: string): string | undefined {
  const brand = resolveModelBrand(modelId)
  return brand ? BRAND_LOGOS[brand] : undefined
}

/** 不使用渠道协议猜测模型品牌。 */
export function getModelLogo(modelId: string, _provider?: ProviderType): string {
  return getModelLogoById(modelId) ?? DefaultLogo
}

export function getProviderLogo(provider: ProviderType): string {
  const brand = resolveProviderBrand(provider)
  return brand ? BRAND_LOGOS[brand] : DefaultLogo
}

export function getChannelLogo(channel: { provider: ProviderType; baseUrl: string }): string {
  const brand = resolveChannelBrand(channel)
  return brand ? BRAND_LOGOS[brand] : DefaultLogo
}

/**
 * 根据模型 ID 在渠道列表中查找显示名称
 *
 * 优先返回别名（name !== id），未找到则返回原始 modelId。
 * 用于将 SDK 返回的 model ID 转为用户友好的显示名称。
 */
export function resolveModelDisplayName(modelId: string, channels: import('@domi/shared').Channel[]): string {
  for (const channel of channels) {
    for (const model of channel.models) {
      if (model.id === modelId && model.name && model.name !== model.id) {
        return model.name
      }
    }
  }
  return modelId
}

/**
 * 根据模型 ID 在渠道列表中查找供应商类型
 */
export function resolveModelProvider(modelId: string, channels: import('@domi/shared').Channel[]): ProviderType | undefined {
  for (const channel of channels) {
    for (const model of channel.models) {
      if (model.id === modelId) {
        return channel.provider
      }
    }
  }
  return undefined
}

/** 默认模型图标 */
export { DefaultLogo }
