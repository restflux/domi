import { getAdapter, streamSSE } from '@domi/core'
import type { Channel } from '@domi/shared'
import {
  getChannelById,
  persistCodexOAuthCredentials,
  resolveChannelRuntimeApiKey,
  resolveCodexOAuthCredentials,
} from './channel-manager.ts'
import { generateCodexText } from './adapters/pi-codex-title-generator.ts'
import { getFetchFn } from './proxy-fetch.ts'
import { getEffectiveProxyUrl } from './proxy-settings-service.ts'

const HANDOFF_MAX_OUTPUT_TOKENS = 2_400
const HANDOFF_REQUEST_TIMEOUT_MS = 90_000

export const HANDOFF_SYNTHESIS_SYSTEM_PROMPT = `你是 Domi 的会话交接整理器。请把来源会话证据整理成一份可直接交给另一个 Agent 的工作交接。

要求：
- 只根据输入证据总结，不编造完成情况、决定、文件或测试结果。
- 使用清晰、简洁的中文 Markdown。
- 必须依次包含这些二级标题：任务目标、已完成工作、关键决定、当前状态、剩余事项、验证结果、重要文件、风险与注意事项、原项目路径。
- 原项目路径必须明确标注“仅供参考，不作为新会话目标”。
- 不要解释你如何生成，不要输出代码围栏，不要加入寒暄。`

export interface AgentSessionHandoffSynthesisInput {
  channelId: string
  modelId: string
  evidence: string
  signal?: AbortSignal
}

export interface AgentSessionHandoffSynthesisDependencies {
  getChannel(channelId: string): Channel | undefined
  resolveApiKey(channelId: string): Promise<string>
  getProxyUrl(): Promise<string | undefined>
  generateCodex(input: AgentSessionHandoffSynthesisInput, channel: Channel, proxyUrl?: string): Promise<string | null>
  generateProvider(input: AgentSessionHandoffSynthesisInput, channel: Channel, apiKey: string, proxyUrl?: string): Promise<string | null>
}

async function generateWithCodex(
  input: AgentSessionHandoffSynthesisInput,
  _channel: Channel,
  proxyUrl?: string,
): Promise<string | null> {
  const credentials = await resolveCodexOAuthCredentials(input.channelId)
  return generateCodexText({
    modelId: input.modelId,
    prompt: `${HANDOFF_SYNTHESIS_SYSTEM_PROMPT}\n\n以下是来源会话证据：\n\n${input.evidence}`,
    credentials,
    proxyUrl,
    signal: input.signal,
    onCredentialsRefreshed: (refreshed) => persistCodexOAuthCredentials(input.channelId, refreshed),
  }, {
    maxTokens: HANDOFF_MAX_OUTPUT_TOKENS,
    timeoutMs: HANDOFF_REQUEST_TIMEOUT_MS,
    textVerbosity: 'medium',
  })
}

async function generateWithProvider(
  input: AgentSessionHandoffSynthesisInput,
  channel: Channel,
  apiKey: string,
  proxyUrl?: string,
): Promise<string | null> {
  const adapter = getAdapter(channel.provider)
  const request = adapter.buildStreamRequest({
    baseUrl: channel.baseUrl,
    apiKey,
    modelId: input.modelId,
    history: [],
    userMessage: `以下是来源会话证据：\n\n${input.evidence}`,
    systemMessage: HANDOFF_SYNTHESIS_SYSTEM_PROMPT,
    readImageAttachments: () => [],
    thinkingEnabled: false,
  })
  const controller = new AbortController()
  const handleParentAbort = (): void => controller.abort()
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener('abort', handleParentAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), HANDOFF_REQUEST_TIMEOUT_MS)
  try {
    const response = await streamSSE({
      request,
      adapter,
      onEvent: () => undefined,
      signal: controller.signal,
      timeoutMs: HANDOFF_REQUEST_TIMEOUT_MS,
      fetchFn: getFetchFn(proxyUrl),
    })
    return response.content.trim() || null
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', handleParentAbort)
  }
}

const defaultDependencies: AgentSessionHandoffSynthesisDependencies = {
  getChannel: getChannelById,
  resolveApiKey: resolveChannelRuntimeApiKey,
  getProxyUrl: getEffectiveProxyUrl,
  generateCodex: generateWithCodex,
  generateProvider: generateWithProvider,
}

function validateGeneratedHandoff(content: string | null): string {
  const result = content?.trim()
  if (!result) throw new Error('AI 未生成可用的交接内容，请稍后重试')
  const requiredHeadings = [
    '任务目标',
    '已完成工作',
    '关键决定',
    '当前状态',
    '剩余事项',
    '验证结果',
    '重要文件',
    '风险与注意事项',
    '原项目路径',
  ]
  const missing = requiredHeadings.filter((heading) => !result.includes(`## ${heading}`))
  if (missing.length > 0) {
    throw new Error(`AI 生成的交接内容不完整，缺少：${missing.join('、')}`)
  }
  if (!result.includes('仅供参考，不作为新会话目标')) {
    throw new Error('AI 生成的交接内容没有正确说明原项目路径用途')
  }
  return result
}

export async function synthesizeAgentSessionHandoff(
  input: AgentSessionHandoffSynthesisInput,
  dependencies: AgentSessionHandoffSynthesisDependencies = defaultDependencies,
): Promise<string> {
  const channel = dependencies.getChannel(input.channelId)
  if (!channel) throw new Error('来源会话使用的模型渠道不存在')
  const proxyUrl = await dependencies.getProxyUrl()
  const content = channel.provider === 'openai-codex'
    ? await dependencies.generateCodex(input, channel, proxyUrl)
    : await dependencies.generateProvider(
        input,
        channel,
        await dependencies.resolveApiKey(input.channelId),
        proxyUrl,
      )
  return validateGeneratedHandoff(content)
}
