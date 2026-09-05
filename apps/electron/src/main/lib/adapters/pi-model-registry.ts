/**
 * Pi 模型注册与渠道兼容层。
 *
 * Pi SDK 需要把 Domi 渠道临时注册成 runtime provider；这里集中处理
 * ProviderType 到 Pi API 协议、baseUrl、认证头和模型 catalog 默认值的映射。
 */

import { join } from 'node:path'
import {
  CODEX_GPT_54_55_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  CODEX_GPT_56_CONTEXT_WINDOW,
  extractZhipuCodingTeamApiToken,
  inferAgentSdkContextWindow,
  resolveReasoningCapability,
  resolveReasoningProfile,
  type AgentThinkingLevel,
  type ChannelModel,
  type ChannelModelCapabilities,
  type CodexOAuthCredentials,
  type ContextWindowSource,
  type FinishReasonMode,
  type ReasoningCapability,
  type ReasoningTransport,
  type ProviderType,
} from '@domi/shared'
import {
  getKimiCodingPlanUserAgent,
  normalizeAnthropicBaseUrlForSdk,
  normalizeOpenAIBaseUrlForSdk,
  resolveAnthropicMessagesUrl,
} from '@domi/core'
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai/compat'
import { getSdkConfigDir } from '../config-paths'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { runWithPiRequestProxyScope } from './pi-request-proxy'
import { supportsPiDeveloperRole } from './pi-provider-compat'
import { createPiCatalogRuntime } from './pi-catalog-runtime'
import { catalogCredentials, piRemoteModelCatalog } from './pi-remote-model-catalog'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type PiAiCompat = typeof import('@earendil-works/pi-ai/compat')
type PiCatalogModel = Model<Api>
type PiModelCost = PiCatalogModel['cost']
type PiRequestHeaders = Record<string, string>
type PiCatalogModelPatch = Pick<PiCatalogModel, 'id'> & Partial<PiCatalogModel>

type ChannelModelCapabilitySources = Pick<ChannelModel, 'providerMetadata' | 'temporaryAdaptation'>

interface PiModelDefaults {
  reasoning: boolean
  thinkingLevelMap?: PiCatalogModel['thinkingLevelMap']
  compat?: PiCatalogModel['compat']
  input: PiCatalogModel['input']
  cost: PiModelCost
  contextWindow: number
  contextWindowSource: ContextWindowSource
  maxTokens: number
}

const ZERO_MODEL_COST: PiModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000
const VOLCENGINE_GLM_52_MAX_TOKENS = 128_000
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const CODEX_MAX_TOKENS = 128_000
const CODEX_MODEL_REFRESH_TIMEOUT_MS = 15_000

function toReasoningTransport(api: Api): ReasoningTransport {
  switch (api) {
    case 'anthropic-messages':
      return 'anthropic-messages'
    case 'openai-completions':
      return 'openai-completions'
    case 'openai-responses':
      return 'openai-responses'
    default:
      return 'other'
  }
}

/** 将共享 reasoning profile 编译为 Pi SDK 的 model compatibility patch。 */
function compilePiReasoningCapabilities(
  api: Api,
  modelId: string | undefined,
): Pick<PiModelDefaults, 'compat' | 'thinkingLevelMap'> | undefined {
  const transport = toReasoningTransport(api)
  const profile = resolveReasoningProfile({ modelId, transport })
  const encoding = profile?.encodings[transport]
  if (!encoding) return undefined

  const thinkingLevelMap = encoding.effortMap as PiCatalogModel['thinkingLevelMap']
  switch (encoding.kind) {
    case 'adaptive-effort':
      return {
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap,
      }
    // DeepSeek V4 is not Anthropic adaptive thinking. Pi 0.84.4 still emits a
    // legacy token budget; the scoped request extension rewrites the final body.
    case 'deepseek-output-effort':
      return { thinkingLevelMap }
    case 'openai-reasoning-effort':
      return {
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap,
      }
    case 'zai-thinking-effort':
      return {
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          thinkingFormat: 'zai',
          zaiToolStream: true,
        },
        thinkingLevelMap,
      }
  }
}

const CODEX_56_THINKING_LEVEL_MAP = compilePiReasoningCapabilities('openai-responses', 'gpt-5.6')?.thinkingLevelMap

type CodexRuntimeCredential = CodexOAuthCredentials & {
  type: 'oauth'
  [key: string]: unknown
}

/** Pi 内置 Codex provider 所需的最小模型与 OAuth 输入。 */
export interface CodexModelInput {
  model?: string
  piAgentDir?: string
  codexOAuthCredentials?: CodexOAuthCredentials
  onCodexOAuthCredentialsRefreshed?: (credentials: CodexOAuthCredentials) => void | Promise<void>
}

function createCodexRuntimeCredentialStore(
  initial: CodexOAuthCredentials,
  onRefreshed?: PiAgentQueryOptions['onCodexOAuthCredentialsRefreshed'],
) {
  let credential: CodexRuntimeCredential | undefined = { type: 'oauth', ...initial }

  return {
    async read(providerId: string): Promise<CodexRuntimeCredential | undefined> {
      return providerId === 'openai-codex' ? credential : undefined
    },
    async list(): Promise<readonly { providerId: string; type: 'oauth' }[]> {
      return credential ? [{ providerId: 'openai-codex', type: 'oauth' }] : []
    },
    async modify(
      providerId: string,
      fn: (current: CodexRuntimeCredential | undefined) => Promise<CodexRuntimeCredential | undefined>,
    ): Promise<CodexRuntimeCredential | undefined> {
      if (providerId !== 'openai-codex') return undefined
      const previous = credential
      credential = await fn(credential)

      if (credential && (
        previous?.access !== credential.access
        || previous?.refresh !== credential.refresh
        || previous?.expires !== credential.expires
        || previous?.accountId !== credential.accountId
      )) {
        try {
          await onRefreshed?.(credential)
        } catch (error) {
          console.warn('[Pi Codex OAuth] 刷新后的凭据回写失败，将在下次执行前重试:', error)
        }
      }
      return credential
    },
    async delete(providerId: string): Promise<void> {
      if (providerId === 'openai-codex') credential = undefined
    },
  }
}

const CODEX_MODEL_PATCHES: PiCatalogModelPatch[] = [
  {
    id: 'gpt-5.4',
    contextWindow: CODEX_GPT_54_55_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.4-mini',
    contextWindow: CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.5',
    contextWindow: CODEX_GPT_54_55_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_56_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: CODEX_GPT_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_56_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: CODEX_GPT_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_56_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: CODEX_GPT_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
]

let piAiCompatPromise: Promise<PiAiCompat> | undefined

function loadPiAiCompat(): Promise<PiAiCompat> {
  piAiCompatPromise ??= import('@earendil-works/pi-ai/compat')
  return piAiCompatPromise
}

function normalizePiApi(provider: ProviderType): Api {
  switch (provider) {
    case 'openai':
    case 'opencode-go-openai':
    case 'zhipu':
    case 'doubao':
    case 'qwen':
    case 'qwen-token-plan-individual':
    case 'custom':
      return 'openai-completions'
    case 'openai-responses':
      return 'openai-responses'
    case 'google':
      return 'google-generative-ai'
    default:
      return 'anthropic-messages'
  }
}

function candidatePiProviders(provider: ProviderType): KnownProvider[] {
  switch (provider) {
    case 'anthropic':
      return ['anthropic']
    case 'openai':
    case 'openai-responses':
    case 'custom':
      return ['openai']
    case 'opencode-go-openai':
      return ['opencode-go']
    case 'deepseek':
      return ['deepseek']
    case 'google':
      return ['google']
    case 'kimi-api':
      return ['moonshotai-cn', 'moonshotai']
    case 'kimi-coding':
      return ['kimi-coding', 'moonshotai-cn', 'moonshotai']
    case 'zhipu':
      return ['zai']
    case 'zhipu-coding':
    case 'zhipu-coding-team':
      return ['zai-coding-cn', 'zai']
    case 'minimax':
      return ['minimax', 'minimax-cn']
    case 'xiaomi':
      return ['xiaomi']
    case 'xiaomi-token-plan':
      return ['xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams', 'xiaomi']
    case 'qwen-token-plan':
      return ['qwen-token-plan-cn', 'qwen-token-plan']
    case 'qwen-token-plan-individual':
      return ['qwen-token-plan-individual']
    default:
      return []
  }
}

function findCatalogModelById(models: readonly PiCatalogModel[], modelId: string): PiCatalogModel | undefined {
  const normalized = modelId.toLowerCase()
  return models.find((model) =>
    model.id.toLowerCase() === normalized || model.name.toLowerCase() === normalized)
}

/**
 * Extract an unambiguous Claude family/version key from common provider aliases.
 *
 * Catalogs vary between `claude-opus-4-6`, `Claude Opus 4.6`, and provider-scoped
 * forms such as `anthropic.claude-opus-4-6-v1`. The fallback intentionally requires
 * a family plus full major/minor version. Major-only matching is only allowed for
 * Fable, catalog entries, or an explicit `-promo` alias.
 */
function getClaudeFamilyKey(modelRef: string, allowMajorOnly = false): string | undefined {
  const normalized = modelRef.toLowerCase()
  const familyFirst = normalized.match(/claude[\s._:/-]+(opus|sonnet|haiku|fable)[\s._:/-]+(\d+)(?:[\s._:/-]+(\d+))?/)
  const versionFirst = normalized.match(/claude[\s._:/-]+(\d+)(?:[\s._:/-]+(\d+))?[\s._:/-]+(opus|sonnet|haiku)/)
  const family = familyFirst?.[1] ?? versionFirst?.[3]
  const major = familyFirst?.[2] ?? versionFirst?.[1]
  const minor = familyFirst?.[3] ?? versionFirst?.[2]
  const isPromoAlias = /[\s._:/-]promo$/.test(normalized)
  if (!family || !major || (!minor && family !== 'fable' && !allowMajorOnly && !isPromoAlias)) return undefined
  return `${family}-${major}${minor ? `-${minor}` : ''}`
}

function findClaudeCatalogModel(models: readonly PiCatalogModel[], modelId: string): PiCatalogModel | undefined {
  const familyKey = getClaudeFamilyKey(modelId)
  if (!familyKey) return undefined
  return models.find((model) =>
    getClaudeFamilyKey(model.id, true) === familyKey || getClaudeFamilyKey(model.name, true) === familyKey)
}

async function getCatalogModels(provider: KnownProvider): Promise<readonly PiCatalogModel[]> {
  try {
    return await piRemoteModelCatalog.getModels(provider)
  } catch {
    const { getModels } = await loadPiAiCompat()
    return getModels(provider as Parameters<typeof getModels>[0])
  }
}

/** 中转只刷新能力目录，实际可用模型清单仍以中转自己的接口为准。 */
export async function refreshPiChannelModelCatalog(provider: ProviderType, proxyUrl?: string, force = true): Promise<void> {
  const providers = provider === 'custom' || provider === 'openai' || provider === 'openai-responses'
    ? ['openai', 'anthropic']
    : provider === 'anthropic-compatible'
      ? ['anthropic']
      : candidatePiProviders(provider)
  await piRemoteModelCatalog.refresh(providers, proxyUrl, force)
}

async function ensurePiChannelCatalog(provider: ProviderType): Promise<void> {
  if (provider === 'openai-codex') return
  try {
    await refreshPiChannelModelCatalog(provider, await getEffectiveProxyUrl(), false)
  } catch {
    // 自动补全失败沿用缓存或内置目录；主动刷新时再展示失败反馈。
  }
}

function isGptModel(modelId: string): boolean {
  return /^gpt[-_\s]?\d/i.test(modelId)
}

/** GPT 能力不从 Codex 或其他供应商的同名目录借用；别名不做模糊匹配。 */
async function findGptCatalogModel(provider: ProviderType, modelId: string): Promise<PiCatalogModel | undefined> {
  const api = normalizePiApi(provider)
  if (api !== 'openai-completions' && api !== 'openai-responses') return undefined
  return (await getCatalogModels('openai')).find((model) => model.id.toLowerCase() === modelId.toLowerCase()
    && (model.api === 'openai-completions' || model.api === 'openai-responses'))
}

type PiImageInputCapability = 'supported' | 'unsupported' | 'unknown'

/** 只有所有精确 catalog 声明一致时才接受跨 Provider 的能力结论。 */
export function resolveImageCapabilityConsensus(
  capabilities: readonly Exclude<PiImageInputCapability, 'unknown'>[],
): PiImageInputCapability {
  if (capabilities.length === 0) return 'unknown'
  const first = capabilities[0]!
  return capabilities.every((capability) => capability === first) ? first : 'unknown'
}

const GLOBAL_CATALOG_CAPABILITY_FALLBACK_PROVIDERS = new Set<ProviderType>([
  'anthropic-compatible',
  'openai',
  'openai-responses',
  'custom',
  'doubao',
  'ark-coding-plan',
  'qwen',
  'qwen-anthropic',
  'qwen-token-plan',
  'qwen-token-plan-individual',
])

async function buildGlobalExactImageCapabilities(): Promise<Map<string, PiImageInputCapability>> {
  const { getProviders } = await loadPiAiCompat()
  const declarations = new Map<string, Array<Exclude<PiImageInputCapability, 'unknown'>>>()
  const catalogs = await Promise.all(getProviders().map(async (provider) => (
    provider === 'openai-codex' ? getCodexCatalogModels() : getCatalogModels(provider)
  )))

  for (const models of catalogs) {
    for (const model of models) {
      const key = model.id.trim().toLowerCase()
      if (!key) continue
      const capability = model.input.includes('image') ? 'supported' : 'unsupported'
      const current = declarations.get(key)
      if (current) current.push(capability)
      else declarations.set(key, [capability])
    }
  }

  return new Map([...declarations].map(([modelId, capabilities]) => [
    modelId,
    resolveImageCapabilityConsensus(capabilities),
  ]))
}

async function resolveGlobalExactImageCapability(modelId: string): Promise<PiImageInputCapability> {
  return (await buildGlobalExactImageCapabilities()).get(modelId.trim().toLowerCase()) ?? 'unknown'
}

async function findPiCatalogModel(provider: ProviderType, modelId: string): Promise<PiCatalogModel | undefined> {
  await ensurePiChannelCatalog(provider)
  if (provider === 'openai-codex') {
    return findCatalogModelById(await getCodexCatalogModels(), modelId)
  }

  if (isGptModel(modelId)) return findGptCatalogModel(provider, modelId)

  const preferredProviders = candidatePiProviders(provider)
  const { getProviders } = await loadPiAiCompat()
  const checked = new Set(preferredProviders)
  const fallbackProviders = getProviders().filter((candidate) => !checked.has(candidate))

  // The configured provider owns both exact and safe Claude-family matching.
  for (const candidate of preferredProviders) {
    const model = findCatalogModelById(await getCatalogModels(candidate), modelId)
    if (model) return model
  }

  const claudeFamilyKey = getClaudeFamilyKey(modelId)
  if (claudeFamilyKey) {
    for (const candidate of preferredProviders) {
      const model = findClaudeCatalogModel(await getCatalogModels(candidate), modelId)
      if (model) return model
    }
  }

  // Generic/custom channels can still match a provider-scoped catalog ID exactly.
  for (const candidate of fallbackProviders) {
    const model = findCatalogModelById(await getCatalogModels(candidate), modelId)
    if (model) return model
  }

  // Only relax aliases after every exact lookup has failed.
  if (claudeFamilyKey) {
    for (const candidate of fallbackProviders) {
      const model = findClaudeCatalogModel(await getCatalogModels(candidate), modelId)
      if (model) return model
    }
  }
  return undefined
}

export async function resolvePiModelCatalogStatus(
  provider: ProviderType,
  modelId: string | undefined,
): Promise<'catalog' | 'missing'> {
  const resolvedModelId = stripAgentSdkContextSuffix(modelId)
  if (!resolvedModelId) return 'missing'
  return await findPiCatalogModel(provider, resolvedModelId) ? 'catalog' : 'missing'
}

async function findProviderScopedCatalogModel(
  provider: ProviderType,
  modelId: string,
): Promise<PiCatalogModel | undefined> {
  if (provider === 'openai-codex') {
    return findCatalogModelById(await getCodexCatalogModels(), modelId)
  }
  await ensurePiChannelCatalog(provider)
  if (isGptModel(modelId)) return findGptCatalogModel(provider, modelId)
  const providers = candidatePiProviders(provider)
  if (providers.length === 0) return undefined
  for (const candidate of providers) {
    const model = findCatalogModelById(await getCatalogModels(candidate), modelId)
    if (model) return model
  }
  const claudeFamilyKey = getClaudeFamilyKey(modelId)
  if (!claudeFamilyKey) return undefined
  for (const candidate of providers) {
    const model = findClaudeCatalogModel(await getCatalogModels(candidate), modelId)
    if (model) return model
  }
  return undefined
}

/**
 * 解析模型图片输入能力：优先使用当前 Provider 自己的 Pi catalog；对协议兼容渠道，
 * 仅在 Provider-scoped 未命中时按精确 model ID 查询全部 Pi catalog。跨 Provider
 * 声明必须一致，冲突、缺失或仅名称近似时继续 fail closed。
 */
export async function resolvePiImageInputCapability(
  provider: ProviderType,
  modelId: string | undefined,
  configured?: ChannelModelCapabilitySources,
): Promise<PiImageInputCapability> {
  const resolvedModelId = stripAgentSdkContextSuffix(modelId)
  if (!resolvedModelId) return 'unknown'
  if (configured?.providerMetadata?.input) {
    return configured.providerMetadata.input.includes('image') ? 'supported' : 'unsupported'
  }
  const catalogModel = await findProviderScopedCatalogModel(provider, resolvedModelId)
  if (catalogModel) return catalogModel.input.includes('image') ? 'supported' : 'unsupported'
  if (!isGptModel(resolvedModelId) && GLOBAL_CATALOG_CAPABILITY_FALLBACK_PROVIDERS.has(provider)) {
    const globalCapability = await resolveGlobalExactImageCapability(resolvedModelId)
    if (globalCapability !== 'unknown') return globalCapability
  }
  if (configured?.temporaryAdaptation?.input) {
    return configured.temporaryAdaptation.input.includes('image') ? 'supported' : 'unsupported'
  }
  return 'unknown'
}

const VALID_THINKING_LEVELS: readonly AgentThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]

function hasReasoningMetadata(metadata: ChannelModelCapabilities | undefined): boolean {
  return metadata?.reasoning != null
    || metadata?.reasoningLevels != null
    || metadata?.defaultReasoningLevel != null
    || metadata?.thinkingLevelMap != null
}

function configuredReasoningCapability(
  metadata: ChannelModelCapabilities,
  source: 'provider-metadata' | 'temporary-adaptation',
): ReasoningCapability | undefined {
  if (metadata.reasoning === false) return undefined
  const configuredLevels = metadata.reasoningLevels
    ?? Object.keys(metadata.thinkingLevelMap ?? {}).filter((level) =>
      metadata.thinkingLevelMap?.[level as AgentThinkingLevel] !== null) as AgentThinkingLevel[]
  const levels = VALID_THINKING_LEVELS.filter((level) => configuredLevels.includes(level))
  if (levels.length === 0 || levels.every((level) => level === 'off')) return undefined
  const defaultLevel = metadata.defaultReasoningLevel && levels.includes(metadata.defaultReasoningLevel)
    ? metadata.defaultReasoningLevel
    : levels.find((level) => level !== 'off') ?? levels[0]!
  return { source, levels, defaultLevel }
}

/**
 * 解析 Pi runtime 的会话级 reasoning capability。
 *
 * 供应商明确返回的元数据最优先；经过验证的专属 profile 其次；Pi catalog
 * 精确声明再其次。只有以上来源都缺失时，才启用用户的临时适配。
 */
export async function resolvePiReasoningCapability(
  provider: ProviderType,
  modelId: string | undefined,
  configured?: ChannelModelCapabilitySources,
): Promise<ReasoningCapability | undefined> {
  const resolvedModelId = stripAgentSdkContextSuffix(modelId)
  if (configured?.providerMetadata?.reasoning === false) return undefined
  const catalogModel = resolvedModelId
    ? await findPiCatalogModel(provider, resolvedModelId)
    : undefined
  if (hasReasoningMetadata(configured?.providerMetadata)) {
    return configuredReasoningCapability({
      reasoning: catalogModel?.reasoning,
      thinkingLevelMap: catalogModel?.thinkingLevelMap,
      ...configured!.providerMetadata,
      // 显式档位集合优先；只声明 reasoning=true 时继续补全目录中的 max 等档位。
      ...(configured?.providerMetadata?.reasoningLevels
        ? { thinkingLevelMap: configured.providerMetadata.thinkingLevelMap }
        : {}),
    }, 'provider-metadata')
  }
  // 中转 GPT 仅接受精确目录或显式适配，不根据未知别名猜测思考档位。
  const profile = provider !== 'openai-codex' && resolvedModelId && isGptModel(resolvedModelId)
    ? undefined
    : resolveReasoningProfile({
      modelId: resolvedModelId,
      transport: provider === 'openai-codex'
        ? 'openai-responses'
        : toReasoningTransport(normalizePiApi(provider)),
    })
  if (profile) return resolveReasoningCapability({ profile })
  if (catalogModel) {
    return resolveReasoningCapability({
      catalog: {
        reasoning: catalogModel.reasoning,
        thinkingLevelMap: catalogModel.thinkingLevelMap,
      },
    })
  }
  if (hasReasoningMetadata(configured?.temporaryAdaptation)) {
    return configuredReasoningCapability(configured!.temporaryAdaptation!, 'temporary-adaptation')
  }
  return undefined
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! > 0 ? value : undefined
}

function metadataThinkingLevelMap(metadata: ChannelModelCapabilities | undefined): PiCatalogModel['thinkingLevelMap'] {
  return metadata?.thinkingLevelMap
    ?? (metadata?.reasoningLevels ? Object.fromEntries(metadata.reasoningLevels.map((level) => [
      level, level === 'off' ? null : level,
    ])) : undefined)
}

async function resolvePiModelDefaults(input: PiAgentQueryOptions): Promise<PiModelDefaults> {
  const catalogModel = input.model ? await findPiCatalogModel(input.provider, input.model) : undefined
  const providerMetadata = input.channelModel?.providerMetadata
  const temporaryAdaptation = input.channelModel?.temporaryAdaptation
  const api = normalizePiApi(input.provider)
  const providerSpecificCapabilities = input.model && isGptModel(input.model)
    ? undefined
    : compilePiReasoningCapabilities(api, input.model)
  const isVolcengineGlm52 = (input.provider === 'doubao' || input.provider === 'ark-coding-plan')
    && input.model?.toLowerCase() === 'glm-5.2'
  const inferredContextWindow = inferAgentSdkContextWindow(input.model, input.provider) ?? DEFAULT_CONTEXT_WINDOW
  const catalogCompat = input.provider === 'qwen-token-plan-individual'
    ? catalogModel?.compat
    : undefined
  const configuredThinkingLevelMap = metadataThinkingLevelMap(providerMetadata)
    ?? providerSpecificCapabilities?.thinkingLevelMap
    ?? catalogModel?.thinkingLevelMap
    ?? metadataThinkingLevelMap(temporaryAdaptation)
  const configuredReasoningEffort = (api === 'openai-completions' || api === 'openai-responses')
    && configuredThinkingLevelMap != null
  const providerContextWindow = positiveInteger(providerMetadata?.contextWindow)
  const catalogContextWindow = positiveInteger(catalogModel?.contextWindow)
  const temporaryContextWindow = positiveInteger(temporaryAdaptation?.contextWindow)
  const contextWindow = providerContextWindow
    ?? catalogContextWindow
    ?? temporaryContextWindow
    ?? inferredContextWindow
  const contextWindowSource: ContextWindowSource = providerContextWindow != null
    ? 'provider_metadata'
    : catalogContextWindow != null
      ? 'provider_catalog'
      : temporaryContextWindow != null
        ? 'temporary_adaptation'
        : 'name_fallback'
  return {
    reasoning: providerMetadata?.reasoning
      ?? catalogModel?.reasoning
      ?? temporaryAdaptation?.reasoning
      ?? true,
    thinkingLevelMap: configuredThinkingLevelMap,
    compat: {
      ...catalogCompat,
      ...providerSpecificCapabilities?.compat,
      ...(configuredReasoningEffort ? { supportsReasoningEffort: true } : {}),
    },
    input: providerMetadata?.input
      ? [...providerMetadata.input]
      : catalogModel
        ? [...catalogModel.input]
        : temporaryAdaptation?.input
          ? [...temporaryAdaptation.input]
          : ['text', 'image'],
    cost: catalogModel ? { ...catalogModel.cost } : { ...ZERO_MODEL_COST },
    contextWindow,
    contextWindowSource,
    // Pi 的智谱目录将 GLM-5.2 标为 131072，但火山方舟兼容端点上限为 128000。
    maxTokens: isVolcengineGlm52
      ? VOLCENGINE_GLM_52_MAX_TOKENS
      : positiveInteger(providerMetadata?.maxTokens)
        ?? positiveInteger(catalogModel?.maxTokens)
        ?? positiveInteger(temporaryAdaptation?.maxTokens)
        ?? DEFAULT_MAX_TOKENS,
  }
}

export function resolvePiSupportsFinishReason(
  mode: FinishReasonMode | undefined,
  api: Api = 'openai-completions',
): boolean | undefined {
  if (api !== 'openai-completions' || mode == null || mode === 'auto') return undefined
  return mode === 'required'
}

function normalizePiBaseUrl(baseUrl: string | undefined, provider: ProviderType): string | undefined {
  if (!baseUrl) return undefined
  if (normalizePiApi(provider) === 'anthropic-messages') {
    return normalizeAnthropicBaseUrlForSdk(resolveAnthropicMessagesUrl(baseUrl, provider))
  }
  if (provider === 'custom' || provider === 'openai-responses') {
    return normalizeOpenAIBaseUrlForSdk(baseUrl)
  }
  return baseUrl.trim().replace(/\/$/, '')
}

export function requiresKimiCompatibilityUserAgent(provider: ProviderType): boolean {
  return provider === 'kimi-coding'
    || provider === 'xiaomi-token-plan'
    || provider === 'qwen-token-plan'
    || provider === 'zhipu-coding'
    || provider === 'zhipu-coding-team'
}

function usesBearerOnlyAnthropicAuth(provider: ProviderType): boolean {
  return requiresKimiCompatibilityUserAgent(provider) || provider === 'minimax' || provider === 'qwen-anthropic'
}

export function buildPiRequestHeaders(provider: ProviderType, apiKey: string): PiRequestHeaders | undefined {
  if (normalizePiApi(provider) !== 'anthropic-messages') return undefined

  const headers: PiRequestHeaders = {
    Authorization: `Bearer ${apiKey}`,
  }

  if (requiresKimiCompatibilityUserAgent(provider)) {
    headers['User-Agent'] = getKimiCodingPlanUserAgent()
  }

  return headers
}

function shouldUseRuntimeApiKey(provider: ProviderType): boolean {
  return !usesBearerOnlyAnthropicAuth(provider)
}

/**
 * 解析出用于 Pi runtime 认证的真实 API token。
 *
 * 智谱团队版（zhipu-coding-team）的凭据是复合串（形如
 * `apiKey=xxx; bigmodel_organization=yyy; bigmodel_project=zzz`），
 * 必须先提取其中的 apiKey，否则整串会被塞进 `Authorization: Bearer` 头导致 401。
 * 与 Domi 渠道鉴权环境的既有兼容语义保持一致。
 */
export function resolvePiApiKey(provider: ProviderType, apiKey: string): string {
  return provider === 'zhipu-coding-team' ? extractZhipuCodingTeamApiToken(apiKey) : apiKey
}

/**
 * 剥离模型 ID 上的 `[1m]` 扩展上下文后缀。
 *
 * `[1m]` 是已移除 Runtime 的历史扩展上下文变体，Pi runtime 及其对接的
 * 端点（智谱等）并不识别，带后缀会被判为「模型不存在」（智谱 1211）。
 * pi 模式统一剥离该后缀，保证注册与请求使用干净的模型 ID。
 */
export function stripAgentSdkContextSuffix(modelId: string | undefined): string | undefined {
  return modelId?.replace(/\[1m\]$/i, '')
}

function mergeCodexModels(models: readonly PiCatalogModel[]): PiCatalogModel[] {
  const merged = models.map((model) => ({ ...model }))
  const indexById = new Map(merged.map((model, index) => [model.id, index]))
  for (const patch of CODEX_MODEL_PATCHES) {
    const existingIndex = indexById.get(patch.id)
    const existing = existingIndex !== undefined ? merged[existingIndex] : undefined
    if (existingIndex !== undefined && existing) {
      merged[existingIndex] = { ...existing, ...patch }
    } else if (isCompleteCatalogModel(patch)) {
      indexById.set(patch.id, merged.length)
      merged.push(patch)
    }
  }
  return merged
}

function isCompleteCatalogModel(model: PiCatalogModelPatch): model is PiCatalogModel {
  return Boolean(
    model.name
      && model.api
      && model.provider
      && model.baseUrl
      && model.input
      && model.cost
      && model.contextWindow
      && model.maxTokens,
  )
}

export async function getCodexCatalogModels(): Promise<PiCatalogModel[]> {
  return mergeCodexModels(await getCatalogModels('openai-codex'))
}

/**
 * 为 ChatGPT (Codex) OAuth 渠道构建模型。
 *
 * openai-codex 是 Pi SDK 的内置 KnownProvider：模型目录、baseUrl 和
 * `openai-codex-responses` 协议全部内置，无需（也不能）手工构造 models 或 baseUrl。
 * Pi 0.80.10 将它声明为 OAuth-only provider；runtime API key 不会参与其认证解析。
 * 因此将 Domi 已刷新过的完整凭据放入一次性内存 OAuth credential store，
 * 按真实 expires 刷新并回写 Domi，避免读写全局 ~/.pi 认证文件。
 */
export async function buildCodexModel(sdk: PiSdk, input: CodexModelInput) {
  if (!input.codexOAuthCredentials) {
    throw new Error('ChatGPT (Codex) OAuth 凭据缺失，请重新登录')
  }

  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: createCodexRuntimeCredentialStore(
      input.codexOAuthCredentials,
      input.onCodexOAuthCredentialsRefreshed,
    ),
    modelsPath: join(input.piAgentDir ?? getSdkConfigDir(), 'models.json'),
    modelsStorePath: join(input.piAgentDir ?? getSdkConfigDir(), 'models-store.json'),
    allowModelNetwork: false,
  })

  const resolvedModelId = stripAgentSdkContextSuffix(input.model)
  const codexModels = mergeCodexModels(modelRuntime.getModels('openai-codex'))
  const model = (resolvedModelId ? modelRuntime.getModel('openai-codex', resolvedModelId) : undefined)
    ?? (resolvedModelId ? findCatalogModelById(codexModels, resolvedModelId) : undefined)
    // 指定模型缺失时回退到首个已缓存或内置 codex 模型，避免因模型 ID 漂移直接失败。
    ?? codexModels[0]
  if (!model) {
    throw new Error('未找到可用的 ChatGPT (Codex) 模型，请确认已登录并升级 Pi 运行时')
  }
  return { modelRuntime, model, contextWindowSource: 'provider_catalog' as const }
}

interface CodexCatalogRuntime {
  refresh(options: {
    allowNetwork: true
    force: true
    providers: readonly ['openai-codex']
    signal: AbortSignal
  }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>
  getModels(providerId: 'openai-codex'): readonly PiCatalogModel[]
}

/** 强制刷新 Pi 官方远端 Codex 目录，并合并 Domi 仍需保留的兼容 patch。 */
export async function refreshCodexModelCatalog(
  runtime: CodexCatalogRuntime,
  signal: AbortSignal,
): Promise<PiCatalogModel[]> {
  const result = await runtime.refresh({
    allowNetwork: true,
    force: true,
    providers: ['openai-codex'],
    signal,
  })
  if (result.aborted || signal.aborted) {
    throw new Error('刷新 ChatGPT (Codex) 模型目录超时')
  }
  const refreshError = result.errors.get('openai-codex')
  if (refreshError) {
    throw new Error(`刷新 ChatGPT (Codex) 模型目录失败: ${refreshError.message}`, { cause: refreshError })
  }
  return mergeCodexModels(runtime.getModels('openai-codex'))
}

export interface ListCodexModelsOptions {
  credentials: CodexOAuthCredentials
  agentDir: string
  proxyUrl?: string
}

/** 从 Pi 官方远端目录刷新 ChatGPT (Codex) 模型，结果缓存于 Domi SDK 配置目录。 */
export async function listCodexModels(options: ListCodexModelsOptions): Promise<{ id: string; name: string }[]> {
  return runWithPiRequestProxyScope({ proxyUrl: options.proxyUrl }, async () => {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), CODEX_MODEL_REFRESH_TIMEOUT_MS)
    try {
      const runtime = await createPiCatalogRuntime(options.agentDir)
      const models = await refreshCodexModelCatalog(runtime, abortController.signal)
      return models.map((model) => ({ id: model.id, name: model.name }))
    } finally {
      clearTimeout(timeout)
    }
  })
}

export async function buildModel(sdk: PiSdk, input: PiAgentQueryOptions) {
  if (input.provider === 'openai-codex') {
    return buildCodexModel(sdk, input)
  }
  const providerName = `domi-${input.provider}-${input.sessionId}`
  const resolvedApiKey = resolvePiApiKey(input.provider, input.apiKey)
  // pi runtime 统一剥离 `[1m]` 后缀：无论上游从哪条路径传入，注册与查找都用干净 ID。
  const resolvedModelId = stripAgentSdkContextSuffix(input.model)
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: catalogCredentials,
    modelsPath: join(input.piAgentDir, 'models.json'),
    modelsStorePath: join(input.piAgentDir, 'models-store.json'),
    allowModelNetwork: false,
  })
  const api = normalizePiApi(input.provider)
  const modelDefaults = await resolvePiModelDefaults({ ...input, model: resolvedModelId })
  const baseUrl = normalizePiBaseUrl(input.baseUrl, input.provider)
  if (!baseUrl) {
    throw new Error(`渠道 ${input.channelName ?? input.provider} 缺少 Base URL`)
  }
  const headers = buildPiRequestHeaders(input.provider, resolvedApiKey)
  const supportsFinishReason = resolvePiSupportsFinishReason(input.finishReasonMode, api)
  const compat = {
    ...modelDefaults.compat,
    ...(supportsPiDeveloperRole(input.provider, baseUrl) ? {} : { supportsDeveloperRole: false }),
    ...(supportsFinishReason == null ? {} : { supportsFinishReason }),
  }
  modelRuntime.registerProvider(providerName, {
    name: input.channelName ?? providerName,
    apiKey: resolvedApiKey,
    ...(headers ? { headers } : {}),
    api,
    baseUrl,
    models: [{
      id: resolvedModelId ?? 'default',
      name: resolvedModelId ?? 'Default',
      api,
      baseUrl,
      reasoning: modelDefaults.reasoning,
      ...(modelDefaults.thinkingLevelMap ? { thinkingLevelMap: modelDefaults.thinkingLevelMap } : {}),
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
      input: modelDefaults.input,
      cost: modelDefaults.cost,
      contextWindow: modelDefaults.contextWindow,
      maxTokens: modelDefaults.maxTokens,
    }],
  })
  const model = modelRuntime.getModel(providerName, resolvedModelId ?? 'default')
  if (!model) throw new Error(`Pi model registration failed: ${resolvedModelId ?? 'default'}`)
  return { modelRuntime, model, contextWindowSource: modelDefaults.contextWindowSource }
}
