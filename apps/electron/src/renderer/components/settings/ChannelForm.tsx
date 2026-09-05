/**
 * ChannelForm - 模型配置编辑表单
 *
 * 支持创建和编辑模型配置，包含：
 * - 基本信息（名称、供应商、Base URL、API Key）
 * - 模型列表：已启用模型置顶 + 可用模型搜索
 * - 连接测试
 *
 * 编辑模式下修改即时保存（auto-save），创建模式仍需手动提交。
 */

import * as React from 'react'
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Plus,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  Zap,
  Download,
  Search,
  Settings2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import { channelFormDirtyAtom } from '@/atoms/settings-tab'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DEEPSEEK_PRESET_MODELS,
  OPENCODE_GO_PRESET_MODELS,
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
  QWEN_TOKEN_PLAN_INDIVIDUAL_PRESET_MODELS,
  QWEN_TOKEN_PLAN_PRESET_MODELS,
  parseZhipuTeamCredentials,
  parseCodexCredentials,
} from '@domi/shared'
import type {
  AgentThinkingLevel,
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelModelCapabilities,
  ChannelTestResult,
  FetchModelsResult,
  FinishReasonMode,
  PiModelCatalogStatus,
  ProviderType,
} from '@domi/shared'
import {
  normalizeBaseUrl,
  resolveAnthropicMessagesUrl,
  resolveOpenAIChatCompletionsUrl,
  resolveOpenAIResponsesUrl,
} from '@domi/core'
import { getProviderLogo } from '@/lib/model-logo'
import { mergeFetchedChannelModels } from '@/lib/channel-model-merge'
import { formatModelTokenInput, parseModelTokenInput } from '@/lib/model-adaptation-input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  ADAPTABLE_REASONING_LEVELS,
  ModelAdaptationDialog,
  type ModelAdaptationDraft,
} from './ModelAdaptationDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsToggle,
} from './primitives'

interface ChannelFormProps {
  /** 编辑模式下传入已有渠道，创建模式传 null */
  channel: Channel | null
  onSaved: (channel?: Channel) => void
  onCancel: () => void
}

/** 所有可选供应商 */
const PROVIDER_OPTIONS: ProviderType[] = ['anthropic', 'anthropic-compatible', 'openai', 'openai-responses', 'openai-codex', 'deepseek', 'google', 'kimi-api', 'kimi-coding', 'opencode-go-openai', 'zhipu', 'zhipu-coding', 'zhipu-coding-team', 'ark-coding-plan', 'minimax', 'doubao', 'qwen', 'qwen-anthropic', 'qwen-token-plan', 'qwen-token-plan-individual', 'xiaomi', 'xiaomi-token-plan', 'custom']

/** 需要用 messages 端点测试的供应商预设模型 */
const PROVIDER_TEST_MODEL_PRESETS: Partial<Record<ProviderType, string[]>> = {
  deepseek: DEEPSEEK_PRESET_MODELS.map((model) => model.id),
  'kimi-api': ['k3', 'kimi-k2.6'],
  'opencode-go-openai': OPENCODE_GO_PRESET_MODELS.map((model) => model.id),
  xiaomi: ['mimo-v2.5-pro', 'mimo-v2-pro', 'mimo-v2.5', 'mimo-v2-omni', 'mimo-v2-flash'],
  'xiaomi-token-plan': ['mimo-v2.5-pro', 'mimo-v2-pro', 'mimo-v2.5', 'mimo-v2-omni', 'mimo-v2-flash'],
  'qwen-token-plan': QWEN_TOKEN_PLAN_PRESET_MODELS.map((model) => model.id),
  'qwen-token-plan-individual': QWEN_TOKEN_PLAN_INDIVIDUAL_PRESET_MODELS.map((model) => model.id),
}

/** 供应商选项（用于 SettingsSelect） */
const PROVIDER_SELECT_OPTIONS = PROVIDER_OPTIONS.map((p) => ({
  value: p,
  label: PROVIDER_LABELS[p],
  icon: getProviderLogo(p),
}))

const OPENAI_COMPLETIONS_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai',
  'opencode-go-openai',
  'zhipu',
  'doubao',
  'qwen',
  'qwen-token-plan-individual',
  'custom',
])

const FINISH_REASON_MODE_OPTIONS = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'required', label: '必须提供 finish_reason' },
  { value: 'not-supported', label: '服务不提供 finish_reason' },
]

function resolveDirectTestModelId(provider: ProviderType, models: ChannelModel[]): string | undefined {
  if (!PROVIDER_TEST_MODEL_PRESETS[provider]) return undefined
  const configuredModelId = models.find((model) => model.enabled)?.id ?? models[0]?.id
  if (configuredModelId) return configuredModelId
  return PROVIDER_TEST_MODEL_PRESETS[provider]?.[0]
}

/** 走 Anthropic 协议的供应商集合（共用 /v1/messages 端点） */
const ANTHROPIC_PROTOCOL_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'anthropic-compatible',
  'deepseek',
  'kimi-api',
  'kimi-coding',
  'zhipu-coding',
  'zhipu-coding-team',
  'ark-coding-plan',
  'minimax',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen-anthropic',
  'qwen-token-plan',
])

/**
 * 生成 API 端点预览 URL
 *
 * 与运行时 channel-manager / ProviderAdapter 的端点解析逻辑保持一致。
 */
function buildPreviewUrl(baseUrl: string, provider: ProviderType): string {
  if (ANTHROPIC_PROTOCOL_PROVIDERS.has(provider)) {
    return resolveAnthropicMessagesUrl(baseUrl, provider)
  }
  if (provider === 'google') {
    return `${baseUrl.trim().replace(/\/+$/, '')}/v1beta/models/{model}:generateContent`
  }
  if (provider === 'openai-responses') {
    return resolveOpenAIResponsesUrl(baseUrl, provider)
  }
  return resolveOpenAIChatCompletionsUrl(baseUrl, provider)
}

function isThirdPartyBaseUrl(provider: ProviderType, baseUrl: string): boolean {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  return Boolean(normalizedBaseUrl) && normalizedBaseUrl !== normalizeBaseUrl(PROVIDER_DEFAULT_URLS[provider])
}

function getUrlInputLabel(provider: ProviderType): string {
  return provider === 'custom' || provider === 'anthropic-compatible' ? '请求地址' : 'Base URL'
}

function getUrlInputPlaceholder(provider: ProviderType): string {
  if (provider === 'custom') return 'https://api.example.com/v2（Chat 按原样请求）'
  if (provider === 'openai-responses') return 'https://api.example.com/v1/responses'
  if (provider === 'anthropic-compatible') return 'https://api.example.com/v1/messages'
  return 'https://api.example.com'
}

function getApiKeyPlaceholder(provider: ProviderType, isEdit: boolean): string {
  if (isEdit) return '留空则不更新'
  if (provider === 'zhipu-coding-team') {
    return '输入 API Token'
  }
  return '输入 API Key'
}

interface ZhipuTeamSecretForm {
  apiKey: string
  organization: string
  project: string
}

const EMPTY_ZHIPU_TEAM_SECRET: ZhipuTeamSecretForm = {
  apiKey: '',
  organization: '',
  project: '',
}

function parseZhipuTeamSecret(secret: string): Partial<ZhipuTeamSecretForm> {
  const credentials = parseZhipuTeamCredentials(secret)
  if (!credentials) return {}
  return {
    apiKey: credentials.apiKey,
    organization: credentials.organization ?? '',
    project: credentials.project ?? '',
  }
}

function buildZhipuTeamSecret(secret: ZhipuTeamSecretForm): string {
  const payload: Record<string, string> = {}
  if (secret.apiKey.trim()) payload.apiKey = secret.apiKey.trim()
  if (secret.organization.trim()) payload.organization = secret.organization.trim()
  if (secret.project.trim()) payload.project = secret.project.trim()
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : ''
}

/** auto-save 防抖延迟 */
const AUTO_SAVE_DELAY = 600
function createModelAdaptationDraft(model: ChannelModel): ModelAdaptationDraft {
  const adaptation = model.temporaryAdaptation
  const levels = adaptation?.reasoningLevels?.filter((level) => ADAPTABLE_REASONING_LEVELS.includes(level))
  const normalizedLevels: AgentThinkingLevel[] = levels && levels.length > 0
    ? [...levels]
    : ['low', 'high', 'max']
  const defaultLevel = adaptation?.defaultReasoningLevel && normalizedLevels.includes(adaptation.defaultReasoningLevel)
    ? adaptation.defaultReasoningLevel
    : normalizedLevels[0]!
  return {
    contextWindow: adaptation?.contextWindow ? formatModelTokenInput(String(adaptation.contextWindow)) : '',
    maxTokens: adaptation?.maxTokens ? formatModelTokenInput(String(adaptation.maxTokens)) : '',
    inputMode: adaptation?.input == null
      ? 'unspecified'
      : adaptation.input.includes('image')
        ? 'text-image'
        : 'text',
    reasoningMode: adaptation?.reasoning === true || adaptation?.reasoningLevels?.length
      ? 'enabled'
      : adaptation?.reasoning === false
        ? 'disabled'
        : 'unspecified',
    levels: [...normalizedLevels],
    defaultLevel,
    effortMap: Object.fromEntries(normalizedLevels.map((level) => [
      level,
      adaptation?.thinkingLevelMap?.[level] ?? (level === 'off' ? null : level),
    ])),
  }
}

export function ChannelForm({ channel, onSaved, onCancel }: ChannelFormProps): React.ReactElement {
  const isEdit = channel !== null

  // 表单状态
  const [name, setName] = React.useState(channel?.name ?? '')
  const [provider, setProvider] = React.useState<ProviderType>(channel?.provider ?? 'anthropic')
  const [baseUrl, setBaseUrl] = React.useState(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS.anthropic)
  const [acknowledgedBaseUrl, setAcknowledgedBaseUrl] = React.useState(() => (
    normalizeBaseUrl(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS[channel?.provider ?? 'anthropic'])
  ))
  const [apiKey, setApiKey] = React.useState('')
  const [zhipuTeamSecret, setZhipuTeamSecret] = React.useState<ZhipuTeamSecretForm>(EMPTY_ZHIPU_TEAM_SECRET)
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [models, setModels] = React.useState<ChannelModel[]>(channel?.models ?? [])
  const [enabled, setEnabled] = React.useState(channel?.enabled ?? true)
  const [finishReasonMode, setFinishReasonMode] = React.useState<FinishReasonMode>(
    channel?.finishReasonMode ?? 'auto',
  )

  // 新模型输入
  const [newModelId, setNewModelId] = React.useState('')
  const [newModelName, setNewModelName] = React.useState('')

  // 模型搜索过滤
  const [modelFilter, setModelFilter] = React.useState('')

  // UI 状态
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<ChannelTestResult | null>(null)
  const [fetchingModels, setFetchingModels] = React.useState(false)
  const [fetchResult, setFetchResult] = React.useState<FetchModelsResult | null>(null)
  const [apiKeyLoaded, setApiKeyLoaded] = React.useState(false)
  const [showExitDialog, setShowExitDialog] = React.useState(false)
  const [showBaseUrlRiskDialog, setShowBaseUrlRiskDialog] = React.useState(false)
  const [pendingRiskAction, setPendingRiskAction] = React.useState<'auto-save' | 'create' | 'fetch' | 'save-and-close' | 'test' | null>(null)
  const [codexLoggingIn, setCodexLoggingIn] = React.useState(false)
  const [adaptationModelId, setAdaptationModelId] = React.useState<string | null>(null)
  const [adaptationDraft, setAdaptationDraft] = React.useState<ModelAdaptationDraft | null>(null)
  const [adaptationCatalogStatus, setAdaptationCatalogStatus] = React.useState<PiModelCatalogStatus | null>(null)
  const [adaptationAdvancedOpen, setAdaptationAdvancedOpen] = React.useState(false)

  const setChannelFormDirty = useSetAtom(channelFormDirtyAtom)
  /** 编辑模式下加载明文 API Key */
  React.useEffect(() => {
    if (isEdit && channel && !apiKeyLoaded) {
      window.electronAPI.decryptApiKey(channel.id).then((key) => {
        setApiKey(key)
        if (channel.provider === 'zhipu-coding-team') {
          setZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parseZhipuTeamSecret(key) })
        }
        setApiKeyLoaded(true)
      }).catch((error) => {
        console.error('[模型配置表单] 解密 API Key 失败:', error)
        setApiKeyLoaded(true)
      })
    }
  }, [isEdit, channel, apiKeyLoaded])

  const isZhipuTeamProvider = provider === 'zhipu-coding-team'
  const isCodexProvider = provider === 'openai-codex'
  const effectiveApiKey = isZhipuTeamProvider ? buildZhipuTeamSecret(zhipuTeamSecret) : apiKey
  // ChatGPT (Codex)：apiKey state 存的是登录后拿到的凭据 JSON；能解析出有效凭据即视为已登录。
  const codexCredentials = isCodexProvider ? parseCodexCredentials(apiKey) : null
  const hasRequiredSecret = isZhipuTeamProvider
    ? Boolean(zhipuTeamSecret.apiKey.trim())
    : isCodexProvider
      ? Boolean(codexCredentials)
      : Boolean(apiKey.trim())
  const requiresBaseUrlRiskAcknowledgement = isThirdPartyBaseUrl(provider, baseUrl)
    && normalizeBaseUrl(baseUrl) !== acknowledgedBaseUrl

  const updateZhipuTeamSecret = React.useCallback((patch: Partial<ZhipuTeamSecretForm>) => {
    setZhipuTeamSecret((prev) => {
      const next = { ...prev, ...patch }
      setApiKey(buildZhipuTeamSecret(next))
      return next
    })
  }, [])

  // ===== Auto-save（仅编辑模式） =====
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 初始化完成标志，避免加载时触发 auto-save */
  const initializedRef = React.useRef(false)

  /** 执行 auto-save */
  const doAutoSave = React.useCallback(async (
    currentModels: ChannelModel[],
    currentName: string,
    currentProvider: ProviderType,
    currentBaseUrl: string,
    currentApiKey: string,
    currentEnabled: boolean,
    currentFinishReasonMode: FinishReasonMode,
  ) => {
    if (!isEdit || !channel) return
    try {
      await window.electronAPI.updateChannel(channel.id, {
        name: currentName,
        provider: currentProvider,
        baseUrl: currentBaseUrl,
        apiKey: currentApiKey || undefined,
        models: currentModels,
        enabled: currentEnabled,
        finishReasonMode: currentFinishReasonMode,
      })
      toast.success('已保存', { id: 'auto-save-success' })
    } catch (error) {
      console.error('[模型配置表单] auto-save 失败:', error)
      toast.error('自动保存失败，请检查后手动重试', { id: 'auto-save-error' })
    }
  }, [isEdit, channel])

  /** 触发防抖 auto-save */
  const scheduleAutoSave = React.useCallback((
    nextModels: ChannelModel[],
    nextName: string,
    nextProvider: ProviderType,
    nextBaseUrl: string,
    nextApiKey: string,
    nextEnabled: boolean,
    nextFinishReasonMode: FinishReasonMode,
    requiresRiskAcknowledgement: boolean,
  ) => {
    if (!isEdit || !initializedRef.current || requiresRiskAcknowledgement) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      doAutoSave(
        nextModels,
        nextName,
        nextProvider,
        nextBaseUrl,
        nextApiKey,
        nextEnabled,
        nextFinishReasonMode,
      )
    }, AUTO_SAVE_DELAY)
  }, [isEdit, doAutoSave])

  // API Key 加载完成后标记初始化
  React.useEffect(() => {
    if (isEdit && apiKeyLoaded) {
      // 延迟标记，避免加载时触发
      const t = setTimeout(() => { initializedRef.current = true }, 100)
      return () => clearTimeout(t)
    }
    if (!isEdit) {
      initializedRef.current = true
    }
  }, [isEdit, apiKeyLoaded])

  // 监听字段变化触发 auto-save
  React.useEffect(() => {
    scheduleAutoSave(
      models,
      name,
      provider,
      baseUrl,
      effectiveApiKey,
      enabled,
      finishReasonMode,
      requiresBaseUrlRiskAcknowledgement,
    )
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current) }
  }, [models, name, provider, baseUrl, effectiveApiKey, enabled, finishReasonMode, requiresBaseUrlRiskAcknowledgement, scheduleAutoSave])

  // 切换供应商时自动更新 Base URL 与名称，Anthropic 兼容渠道自动添加预设模型
  const handleProviderChange = (newProvider: string): void => {
    const p = newProvider as ProviderType
    // 若 name 为空或仍是上一个 provider 的默认名称，则用新 provider 的名称覆盖；用户手动改过的 name 不动
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName === PROVIDER_LABELS[provider]) {
      setName(PROVIDER_LABELS[p])
    }
    setProvider(p)
    setBaseUrl(PROVIDER_DEFAULT_URLS[p])
    setAcknowledgedBaseUrl(normalizeBaseUrl(PROVIDER_DEFAULT_URLS[p]))
    setTestResult(null)
    setFetchResult(null)
    if (p === 'zhipu-coding-team') {
      const parsed = parseZhipuTeamSecret(apiKey)
      setZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parsed })
      setApiKey(buildZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parsed }))
    } else if (provider === 'zhipu-coding-team') {
      setApiKey(zhipuTeamSecret.apiKey)
      setZhipuTeamSecret(EMPTY_ZHIPU_TEAM_SECRET)
    }
    // 预设模型：首次切换到对应 provider 且无模型时自动填充
    if (models.length === 0) {
      if (p === 'deepseek') {
        setModels(DEEPSEEK_PRESET_MODELS.map((model) => ({
          ...model,
          ...(model.temporaryAdaptation ? { temporaryAdaptation: { ...model.temporaryAdaptation } } : {}),
        })))
      } else if (p === 'kimi-api') {
        setModels([
          { id: 'k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-k2.6', name: 'Kimi K2.6', enabled: true },
        ])
      } else if (p === 'kimi-coding') {
        setModels([
          { id: 'k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-for-coding', name: 'Kimi for Coding', enabled: true },
        ])
      } else if (p === 'opencode-go-openai') {
        setModels(OPENCODE_GO_PRESET_MODELS.map((model) => ({
          ...model,
          ...(model.temporaryAdaptation ? { temporaryAdaptation: { ...model.temporaryAdaptation } } : {}),
        })))
      } else if (p === 'zhipu' || p === 'zhipu-coding' || p === 'zhipu-coding-team') {
        setModels([
          { id: 'glm-5.2', name: 'GLM-5.2', enabled: true },
          { id: 'glm-5.1', name: 'GLM-5.1', enabled: false },
        ])
      } else if (p === 'ark-coding-plan') {
        setModels([
          { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', enabled: true },
          { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', enabled: true },
          { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite', enabled: true },
          { id: 'glm-5.2', name: 'GLM-5.2', enabled: true },
          { id: 'k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', enabled: true },
          { id: 'minimax-m3', name: 'MiniMax M3', enabled: true },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        ])
      } else if (p === 'minimax') {
        setModels([
          { id: 'MiniMax-M3', name: 'MiniMax-M3', enabled: true },
          { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', enabled: true },
        ])
      } else if (p === 'xiaomi' || p === 'xiaomi-token-plan') {
        setModels([
          { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', enabled: true },
          { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', enabled: true },
          { id: 'mimo-v2.5', name: 'MiMo V2.5', enabled: true },
          { id: 'mimo-v2-omni', name: 'MiMo V2 Omni', enabled: true },
          { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', enabled: true },
        ])
      } else if (p === 'qwen-anthropic') {
        setModels([
          { id: 'qwen3.7-max', name: 'Qwen3.7 Max', enabled: true },
          { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', enabled: true },
        ])
      } else if (p === 'qwen-token-plan') {
        setModels(QWEN_TOKEN_PLAN_PRESET_MODELS.map((model) => ({ ...model })))
      } else if (p === 'qwen-token-plan-individual') {
        setModels(QWEN_TOKEN_PLAN_INDIVIDUAL_PRESET_MODELS.map((model) => ({ ...model })))
      }
    }
  }

  /** 添加模型 */
  const handleAddModel = (): void => {
    if (!newModelId.trim()) return

    const model: ChannelModel = {
      id: newModelId.trim(),
      name: newModelName.trim() || newModelId.trim(),
      enabled: true,
      source: 'manual',
    }

    setModels((prev) => [...prev, model])
    setNewModelId('')
    setNewModelName('')
  }

  /** 删除模型 */
  const handleRemoveModel = (modelId: string): void => {
    setModels((prev) => prev.filter((m) => m.id !== modelId))
  }

  /** 切换模型启用状态（点击可用模型 → 启用，点击已启用模型 → 禁用） */
  const handleToggleModel = (modelId: string): void => {
    setModels((prev) =>
      prev.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m))
    )
  }

  const handleOpenModelAdaptation = (model: ChannelModel): void => {
    setAdaptationModelId(model.id)
    setAdaptationDraft(createModelAdaptationDraft(model))
    setAdaptationCatalogStatus(null)
    setAdaptationAdvancedOpen(false)
    if (channel) {
      void window.electronAPI.getPiModelCatalogStatus(channel.id, model.id)
        .then(setAdaptationCatalogStatus)
        .catch(() => setAdaptationCatalogStatus('missing'))
    }
  }

  const handleSaveModelAdaptation = (): void => {
    if (!adaptationModelId || !adaptationDraft) return
    const levels = adaptationDraft.reasoningMode === 'enabled' ? adaptationDraft.levels : []
    if (adaptationDraft.reasoningMode === 'enabled' && levels.length === 0) return
    const defaultLevel = levels.includes(adaptationDraft.defaultLevel)
      ? adaptationDraft.defaultLevel
      : levels[0]
    const contextWindow = parseModelTokenInput(adaptationDraft.contextWindow)
    const maxTokens = parseModelTokenInput(adaptationDraft.maxTokens)
    if ((adaptationDraft.contextWindow.trim() && contextWindow == null)
      || (adaptationDraft.maxTokens.trim() && maxTokens == null)) return
    const temporaryAdaptation: ChannelModelCapabilities = {
      ...(adaptationDraft.inputMode === 'text-image'
        ? { input: ['text', 'image'] }
        : adaptationDraft.inputMode === 'text'
          ? { input: ['text'] }
          : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(adaptationDraft.reasoningMode === 'enabled'
        ? { reasoning: true }
        : adaptationDraft.reasoningMode === 'disabled'
          ? { reasoning: false }
          : {}),
      ...(adaptationDraft.reasoningMode === 'enabled' && defaultLevel ? {
        reasoningLevels: levels,
        defaultReasoningLevel: defaultLevel,
        thinkingLevelMap: Object.fromEntries(levels.map((level) => [
          level,
          level === 'off' ? null : adaptationDraft.effortMap[level]?.trim() || level,
        ])),
      } : {}),
    }
    setModels((prev) => prev.map((model) => {
      if (model.id !== adaptationModelId) return model
      if (Object.keys(temporaryAdaptation).length > 0) return { ...model, temporaryAdaptation }
      const { temporaryAdaptation: _removed, ...rest } = model
      return rest
    }))
    setAdaptationModelId(null)
    setAdaptationDraft(null)
    setAdaptationCatalogStatus(null)
    setAdaptationAdvancedOpen(false)
  }

  const handleClearModelAdaptation = (): void => {
    if (!adaptationModelId) return
    setModels((prev) => prev.map((model) => {
      if (model.id !== adaptationModelId) return model
      const { temporaryAdaptation: _removed, ...rest } = model
      return rest
    }))
    setAdaptationModelId(null)
    setAdaptationDraft(null)
    setAdaptationCatalogStatus(null)
    setAdaptationAdvancedOpen(false)
  }

  /** 发起 ChatGPT (Codex) OAuth 登录：打开浏览器授权，成功后把凭据写入 apiKey */
  const handleCodexLogin = async (): Promise<void> => {
    setCodexLoggingIn(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.codexOAuthLogin()
      if (!result.success || !result.credentials) {
        toast.error(result.message ?? 'ChatGPT 登录失败，请重试')
        return
      }
      const credentials = result.credentials
      // 凭据 JSON 已含 accountId，写入 apiKey 后由 codexCredentials 派生展示，无需单独 state。
      setApiKey(credentials)

      // Codex 模型由 Pi 远端目录提供，不依赖 baseUrl。登录后自动刷新并全部启用。
      // 不复用 handleFetchModels：其 gate 读派生自 apiKey state 的 hasRequiredSecret，
      // 而 setApiKey 是异步的，同一 tick 内仍是旧值，这里直接内联拉取。
      let codexModels: ChannelModel[] = []
      try {
        const modelsResult = await window.electronAPI.fetchModels({ provider, baseUrl, apiKey: credentials })
        setFetchResult(modelsResult)
        if (modelsResult.success && modelsResult.models.length > 0) {
          codexModels = modelsResult.models.map((m) => ({ ...m, enabled: true }))
          setModels(codexModels)
        }
      } catch (modelErr) {
        console.error('[模型配置表单] 拉取 ChatGPT 模型失败:', modelErr)
      }

      // OAuth 流程中用户很容易在浏览器授权后直接关闭表单，来不及点「创建」而丢失凭据。
      // 登录成功即明确的保存意图：创建模式下自动落库（编辑模式由 effectiveApiKey 变化触发 auto-save）。
      // 用刚拿到的凭据/模型直接构造入参，避免依赖 setState 后同一 tick 仍是旧值的闭包。
      if (isEdit) {
        toast.success('ChatGPT 登录成功')
      } else {
        const input: ChannelCreateInput = {
          name: name.trim() || PROVIDER_LABELS['openai-codex'],
          provider,
          baseUrl,
          apiKey: credentials,
          models: codexModels,
          enabled,
        }
        const saved = await window.electronAPI.createChannel(input)
        toast.success('ChatGPT 渠道已创建')
        onSaved(saved)
      }
    } catch (error) {
      console.error('[模型配置表单] ChatGPT 登录失败:', error)
      toast.error('ChatGPT 登录失败，请重试')
    } finally {
      setCodexLoggingIn(false)
    }
  }

  /** 从供应商 API 拉取可用模型列表。 */
  const fetchAvailableModels = async (): Promise<void> => {
    // ChatGPT (Codex) 走 Pi 远端目录，不依赖 baseUrl；其余 provider 仍要求 baseUrl。
    if (!hasRequiredSecret || (!isCodexProvider && !baseUrl.trim())) return

    setFetchingModels(true)
    setFetchResult(null)

    try {
      const result = await window.electronAPI.fetchModels({
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
      })

      setFetchResult(result)

      // 用成功拉取的结果作为权威清单替换：
      // - 手动模型或带临时适配的模型一律保留（即便不在新结果里）
      // - 在新结果里也存在的旧模型保留 enabled 状态
      // - 新出现的模型默认未启用
      // - 既不在新结果里、也不是手动添加的旧模型一律丢弃（清除残留）
      // 拉取失败时保留现有列表，避免 auto-save 持久化空模型列表
      if (!result.success) return
      const fetchedModels = result.models
      setModels((previous) => mergeFetchedChannelModels({
        previous,
        fetched: fetchedModels,
        provider,
        // ChatGPT (Codex) 目录由 Pi 远端维护，拉取即全部启用，避免新模型
        // 默认未启用而沉到「可用模型」折叠区，被误认为“拉不到”。
        enableAll: isCodexProvider,
      }))
    } catch (error) {
      setFetchResult({ success: false, message: '拉取模型请求失败', models: [] })
    } finally {
      setFetchingModels(false)
    }
  }

  const handleFetchModels = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('fetch')
      return
    }
    void fetchAvailableModels()
  }

  /** 测试连接（直接使用表单当前值，无需先保存）。 */
  const testChannelConnection = async (): Promise<void> => {
    if (!hasRequiredSecret || !baseUrl.trim()) return

    setTesting(true)
    setTestResult(null)

    try {
      const modelId = resolveDirectTestModelId(provider, models)
      const result = await window.electronAPI.testChannelDirect({
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
        ...(modelId ? { modelId } : {}),
      })
      setTestResult(result)
    } catch (error) {
      setTestResult({ success: false, message: '测试请求失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleTest = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('test')
      return
    }
    void testChannelConnection()
  }

  /** 执行创建渠道 */
  const doCreate = React.useCallback(async (): Promise<Channel | null> => {
    if (!name.trim() || !hasRequiredSecret) return null

    setSaving(true)
    try {
      const input: ChannelCreateInput = {
        name,
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
        models,
        enabled,
        finishReasonMode,
      }
      const savedChannel = await window.electronAPI.createChannel(input)
      toast.success('渠道创建成功')
      return savedChannel
    } catch (error) {
      console.error('[模型配置表单] 创建失败:', error)
      toast.error('渠道创建失败，请检查配置后重试')
      return null
    } finally {
      setSaving(false)
    }
  }, [name, provider, baseUrl, effectiveApiKey, hasRequiredSecret, models, enabled, finishReasonMode])

  /** 显示第三方 Base URL 风险确认。 */
  const requestBaseUrlRiskAcknowledgement = (action: 'auto-save' | 'create' | 'fetch' | 'save-and-close' | 'test' | null): void => {
    setPendingRiskAction(action)
    setShowBaseUrlRiskDialog(true)
  }

  /** 确认风险后，仅放行当前变更的 Base URL。 */
  const handleBaseUrlRiskAcknowledgement = async (): Promise<void> => {
    const action = pendingRiskAction
    setAcknowledgedBaseUrl(normalizeBaseUrl(baseUrl))
    setPendingRiskAction(null)
    setShowBaseUrlRiskDialog(false)

    // 确认后由 acknowledgedBaseUrl 变化触发既有的防抖 auto-save，避免重复保存。
    if (action === 'auto-save') return
    if (action === 'fetch') {
      await fetchAvailableModels()
      return
    }
    if (action === 'test') {
      await testChannelConnection()
      return
    }

    if (action !== 'create' && action !== 'save-and-close') return
    const savedChannel = await doCreate()
    if (!savedChannel) return
    if (action === 'save-and-close') setShowExitDialog(false)
    onSaved(savedChannel)
  }

  /** Base URL 失焦时，要求确认第三方中转站风险。 */
  const handleBaseUrlBlur = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement(isEdit ? 'auto-save' : null)
    }
  }

  /** 创建渠道（仅新建模式） */
  const handleCreate = async (): Promise<void> => {
    if (models.length === 0) {
      toast.warning('尚未配置模型，建议先从供应商获取或手动添加', { id: 'no-models-warn' })
      return
    }
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('create')
      return
    }
    const savedChannel = await doCreate()
    if (savedChannel) onSaved(savedChannel)
  }

  /** 检测表单是否有未保存内容 */
  const isDirty = !isEdit && (
    name.trim() !== ''
    || effectiveApiKey.trim() !== ''
    || models.length > 0
    || finishReasonMode !== 'auto'
  )
  const hasNoModels = !isEdit && models.length === 0

  /** 返回按钮：创建模式下有未保存内容时拦截 */
  const handleBack = (): void => {
    if (!isEdit && isDirty) {
      setShowExitDialog(true)
      return
    }
    if (isEdit) {
      onSaved()
    } else {
      onCancel()
    }
  }

  /** 放弃编辑 */
  const handleDiscard = (): void => {
    setShowExitDialog(false)
    onCancel()
  }

  /** 保存并关闭（从弹窗触发） */
  const handleSaveAndClose = async (): Promise<void> => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('save-and-close')
      return
    }
    const savedChannel = await doCreate()
    if (savedChannel) {
      setShowExitDialog(false)
      onSaved(savedChannel)
    }
  }

  // 同步表单 dirty 状态到全局 atom（供 SettingsPanel 拦截侧边栏导航）
  React.useEffect(() => {
    setChannelFormDirty(isDirty)
    return () => { setChannelFormDirty(false) }
  }, [isDirty, setChannelFormDirty])

  // 拦截窗口关闭（Cmd+W / Alt+F4 / 点击窗口 X）
  React.useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // ===== 模型分区 =====
  const enabledModels = models.filter((m) => m.enabled)
  const availableModels = React.useMemo(() => {
    const disabled = models.filter((m) => !m.enabled)
    if (!modelFilter.trim()) return disabled
    const keyword = modelFilter.trim().toLowerCase()
    return disabled.filter(
      (m) => m.id.toLowerCase().includes(keyword) || m.name.toLowerCase().includes(keyword)
    )
  }, [models, modelFilter])
  const adaptedModel = adaptationModelId
    ? models.find((model) => model.id === adaptationModelId)
    : undefined
  const contextWindowError = adaptationDraft?.contextWindow.trim()
    && parseModelTokenInput(adaptationDraft.contextWindow) == null
    ? '请输入大于 0 的整数'
    : undefined
  const maxTokensError = adaptationDraft?.maxTokens.trim()
    && parseModelTokenInput(adaptationDraft.maxTokens) == null
    ? '请输入大于 0 的整数'
    : undefined
  const reasoningLevelsError = adaptationDraft?.reasoningMode === 'enabled'
    && adaptationDraft.levels.length === 0
    ? '至少选择一个可用档位'
    : undefined
  const adaptationCanSave = adaptationDraft != null
    && contextWindowError == null
    && maxTokensError == null
    && reasoningLevelsError == null

  return (
    <div className="space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleBack}
        >
          <ArrowLeft size={18} />
        </Button>
        <h3 className="text-lg font-medium text-foreground flex-1">
          {isEdit ? '编辑模型配置' : '添加模型配置'}
        </h3>
        {/* 新建模式：创建按钮 */}
        {!isEdit && (
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={saving || !name.trim() || !hasRequiredSecret}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            <span>创建</span>
          </Button>
        )}
      </div>

      {/* 基本信息卡片 */}
      <SettingsSection title="基本信息">
        <SettingsCard>
          <SettingsSelect
            label="供应商类型"
            value={provider}
            onValueChange={handleProviderChange}
            options={PROVIDER_SELECT_OPTIONS}
            placeholder="选择供应商"
          />
          {provider === 'custom' && (
            <div className="px-4 pb-3 text-xs text-muted-foreground">
              用于 OpenAI Chat Completions 的自定义请求地址，Chat 会按原样发送请求。用于 Agent 时请选择 Pi；若服务提供 Anthropic Messages 端点，请选择「Anthropic 兼容格式」。
            </div>
          )}
          <SettingsInput
            label="供应商名称"
            value={name}
            onChange={setName}
            placeholder="例如: My Anthropic"
            required
          />
          {/* ChatGPT (Codex) 的请求地址由 Pi SDK 内置管理，无需用户填写 */}
          {!isCodexProvider && (
            <SettingsInput
              label={getUrlInputLabel(provider)}
              value={baseUrl}
              onChange={setBaseUrl}
              onBlur={handleBaseUrlBlur}
              placeholder={getUrlInputPlaceholder(provider)}
              description={baseUrl.trim() ? `预览：${buildPreviewUrl(baseUrl, provider)}` : undefined}
            />
          )}
          {/* API Key + 测试连接同行 */}
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">
                {isCodexProvider ? 'ChatGPT 登录' : isZhipuTeamProvider ? '智谱团队版凭证' : 'API Key'}
              </div>
              {/* codex 无 baseUrl/apiKey，测试连接不适用，隐藏测试按钮 */}
              {!isCodexProvider && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={handleTest}
                  disabled={testing || !hasRequiredSecret || !baseUrl.trim()}
                  className="h-7 text-xs"
                >
                  {testing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Zap size={12} />
                  )}
                  <span>测试连接</span>
                </Button>
              )}
            </div>
            {isCodexProvider ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={handleCodexLogin}
                  disabled={codexLoggingIn}
                  className="w-full"
                >
                  {codexLoggingIn ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Zap size={14} />
                  )}
                  <span>
                    {codexLoggingIn
                      ? '等待浏览器授权…'
                      : hasRequiredSecret
                        ? '重新登录 ChatGPT'
                        : '用 ChatGPT 登录'}
                  </span>
                </Button>
                {hasRequiredSecret ? (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                    <CheckCircle2 size={12} className="shrink-0" />
                    <span>
                      已登录 ChatGPT 订阅
                      {codexCredentials?.accountId ? `（账号 ${codexCredentials.accountId.slice(0, 8)}…）` : ''}
                    </span>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    使用 ChatGPT Plus/Pro 订阅登录，通过 OAuth 授权，无需 API Key。授权将在系统浏览器中打开。
                  </div>
                )}
              </div>
            ) : isZhipuTeamProvider ? (
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={zhipuTeamSecret.apiKey}
                    onChange={(e) => updateZhipuTeamSecret({ apiKey: e.target.value })}
                    placeholder="API Token"
                    required={!isEdit}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    title={showApiKey ? '隐藏凭证' : '显示凭证'}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    value={zhipuTeamSecret.organization}
                    onChange={(e) => updateZhipuTeamSecret({ organization: e.target.value })}
                    placeholder="组织 ID（可选）"
                  />
                  <Input
                    value={zhipuTeamSecret.project}
                    onChange={(e) => updateZhipuTeamSecret({ project: e.target.value })}
                    placeholder="项目 ID（可选）"
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  组织 ID 和项目 ID 可在{' '}
                  <a
                    href="https://bigmodel.cn/usercenter/proj-mgmt/org-mgmt"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    智谱组织与项目管理
                  </a>
                  {' '}查看；不填写时使用 API Token 的默认组织与项目上下文查询。
                </div>
              </div>
            ) : (
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={getApiKeyPlaceholder(provider, isEdit)}
                  required={!isEdit}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            )}
            {testResult && (
              <div className={cn(
                'flex items-start gap-1.5 text-xs',
                testResult.success ? 'text-emerald-600' : 'text-destructive'
              )}>
                {testResult.success
                  ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                  : <XCircle size={12} className="mt-0.5 shrink-0" />}
                <span className="min-w-0 break-all">{testResult.message}</span>
              </div>
            )}
          </div>
          <SettingsToggle
            label="启用此配置"
            description="关闭后该配置的模型不会在选择列表中出现"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </SettingsCard>
      </SettingsSection>

      {OPENAI_COMPLETIONS_PROVIDERS.has(provider) && (
        <SettingsSection title="高级设置">
          <SettingsCard>
            <SettingsSelect
              label="finish_reason 兼容模式"
              value={finishReasonMode}
              onValueChange={(value) => setFinishReasonMode(value as FinishReasonMode)}
              options={FINISH_REASON_MODE_OPTIONS}
              description={finishReasonMode === 'not-supported'
                ? 'Pi 会在流结束时推断 stop 或 toolUse；若服务实际发生断流，也可能被当作正常结束。仅用于确认不会返回 finish_reason 的中转站。'
                : finishReasonMode === 'required'
                  ? '明确要求响应提供 finish_reason；缺失时按断流错误处理并保留重试能力。'
                  : '遵循 Pi SDK 与模型目录默认值；标准 OpenAI-compatible 服务应保留此设置。'}
            />
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 已启用模型 */}
      <SettingsSection
        title="已启用模型"
        description={enabledModels.length > 0 ? `${enabledModels.length} 个模型` : undefined}
      >
        <SettingsCard divided={false}>
          {enabledModels.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              还没有启用任何模型，从下方可用模型中选择
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {enabledModels.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center gap-2 px-4 py-2.5 group"
                >
                  <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" />
                  <span className="text-sm text-foreground flex-1 min-w-0">
                    {model.name}
                    {model.name !== model.id && (
                      <span className="text-muted-foreground ml-1">({model.id})</span>
                    )}
                    {model.providerMetadata && (
                      <span className="ml-2 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">供应商</span>
                    )}
                    {model.temporaryAdaptation && (
                      <span className="ml-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">已适配</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleOpenModelAdaptation(model)}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                    title="管理模型适配"
                  >
                    <Settings2 size={13} />
                    <span>适配</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleModel(model.id)}
                    className="p-0.5 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                    title="取消启用"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 可用模型 */}
      <SettingsSection
        title="可用模型"
        action={
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={handleFetchModels}
            disabled={fetchingModels || !hasRequiredSecret || (!isCodexProvider && !baseUrl.trim())}
            className="h-7 text-xs"
          >
            {fetchingModels ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Download size={12} />
            )}
            <span>从供应商获取</span>
          </Button>
        }
      >
        {/* 拉取结果提示 */}
        {fetchResult && (
          <div className={cn(
            'flex items-center gap-1.5 text-xs px-1',
            fetchResult.success ? 'text-emerald-600' : 'text-destructive'
          )}>
            {fetchResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{fetchResult.message}</span>
          </div>
        )}

        <SettingsCard divided={false}>
          {/* 模型搜索过滤 */}
          {models.filter((m) => !m.enabled).length > 5 && (
            <div className="px-4 pt-3 pb-1">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="搜索可用模型..."
                  className="h-8 text-sm pl-8"
                />
              </div>
            </div>
          )}

          {/* 可用模型计数 */}
          {models.filter((m) => !m.enabled).length > 0 && (
            <div className="px-4 pt-2 pb-1 text-xs text-muted-foreground">
              {modelFilter.trim()
                ? `${availableModels.length} / ${models.filter((m) => !m.enabled).length} 个可用模型`
                : `${models.filter((m) => !m.enabled).length} 个可用模型`}
            </div>
          )}

          <ScrollArea className={availableModels.length > 8 ? 'h-[280px]' : undefined}>
            <div className="divide-y divide-border/50">
              {availableModels.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center gap-2 px-4 py-2.5 group cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => handleToggleModel(model.id)}
                >
                  <Plus size={14} className="text-muted-foreground flex-shrink-0" />
                  <span className="text-sm text-foreground flex-1 min-w-0">
                    {model.name}
                    {model.name !== model.id && (
                      <span className="text-muted-foreground ml-1">({model.id})</span>
                    )}
                    {model.providerMetadata && (
                      <span className="ml-2 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">供应商</span>
                    )}
                    {model.temporaryAdaptation && (
                      <span className="ml-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">已适配</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleOpenModelAdaptation(model) }}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
                    title="管理模型适配"
                  >
                    <Settings2 size={13} />
                    <span>适配</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveModel(model.id) }}
                    className="p-0.5 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                    title="删除"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              {/* 搜索无结果提示 */}
              {modelFilter.trim() && availableModels.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  未找到匹配的模型
                </div>
              )}

              {/* 无可用模型提示 */}
              {!modelFilter.trim() && models.filter((m) => !m.enabled).length === 0 && models.length > 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  所有模型已启用
                </div>
              )}
            </div>
          </ScrollArea>

          {/* 手动添加模型 */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border/50">
            <Input
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="模型 ID（如 claude-opus-4-6）"
              className="flex-1 h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddModel()
                }
              }}
            />
            <Input
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              placeholder="显示名称（可选）"
              className="flex-1 h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddModel()
                }
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={handleAddModel}
              disabled={!newModelId.trim()}
              className="h-8 w-8 flex-shrink-0"
            >
              <Plus size={18} />
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <ModelAdaptationDialog
        open={adaptationModelId != null}
        modelId={adaptationModelId}
        model={adaptedModel}
        draft={adaptationDraft}
        catalogStatus={adaptationCatalogStatus}
        advancedOpen={adaptationAdvancedOpen}
        contextWindowError={contextWindowError}
        maxTokensError={maxTokensError}
        reasoningLevelsError={reasoningLevelsError}
        canSave={adaptationCanSave}
        onDraftChange={setAdaptationDraft}
        onAdvancedOpenChange={setAdaptationAdvancedOpen}
        onClear={handleClearModelAdaptation}
        onSave={handleSaveModelAdaptation}
        onOpenChange={(open) => {
          if (!open) {
            setAdaptationModelId(null)
            setAdaptationDraft(null)
            setAdaptationCatalogStatus(null)
            setAdaptationAdvancedOpen(false)
          }
        }}
      />

      {/* 第三方 Base URL 风险确认 */}
      <AlertDialog
        open={showBaseUrlRiskDialog}
        onOpenChange={(open) => {
          setShowBaseUrlRiskDialog(open)
          if (!open) setPendingRiskAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认使用第三方中转站？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>该地址并非当前供应商的官方默认 Base URL。中转站可能存在篡改对话内容和模型响应，存在中间人攻击、凭据泄露与隐私风险。</p>
                <p>其协议适配也可能导致上下文窗口、工具调用、多模态或流式内容显示异常。请仅使用你信赖的服务，并先用非敏感内容测试。</p>
                <p>Domi 仅作为本地 Agent 执行环境：配置、会话等本地数据均存储在你的设备上，Domi 本身不会额外构成数据风险。</p>
                <p>请只使用你信赖的渠道，先用非敏感内容验证后再用于正式工作。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleBaseUrlRiskAcknowledgement}>
              知晓并愿意承担风险
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 退出拦截弹窗 */}
      <AlertDialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              {hasNoModels
                ? '当前尚未配置模型，建议先配置模型再保存。'
                : '您填写的内容尚未保存，确定要放弃编辑吗？'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDiscard}>放弃编辑</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSaveAndClose}
              disabled={saving || !name.trim() || !hasRequiredSecret}
            >
              {saving ? <><Loader2 size={14} className="animate-spin" /> 保存中...</> : '保存并关闭'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
