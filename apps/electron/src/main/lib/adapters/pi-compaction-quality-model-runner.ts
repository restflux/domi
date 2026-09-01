import { randomUUID } from 'node:crypto'
import type { ProviderType } from '@domi/shared'
import type { AssistantMessage, Context, Model, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai/compat'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { buildModel } from './pi-model-registry'
import type {
  BlindedCheckpointSummaryGenerator,
  CheckpointEvalMessage,
  CheckpointProviderUsage,
} from './pi-compaction-quality-eval'

export interface PiCheckpointCompletionInput {
  systemPrompt: string
  userPrompt: string
}

export interface PiCheckpointCompletionResult {
  text: string
  usage?: CheckpointProviderUsage
}

export interface PiCheckpointCompletionRuntime {
  complete: (input: PiCheckpointCompletionInput) => Promise<PiCheckpointCompletionResult>
}

export interface PiCheckpointModelRuntime {
  completeSimple: (
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => Promise<Pick<AssistantMessage, 'content' | 'stopReason' | 'errorMessage' | 'usage'>>
}

export interface PiCheckpointProviderConfig {
  provider: ProviderType
  baseUrl: string
  apiKey: string
  modelId: string
  channelName?: string
  reasoning?: ThinkingLevel
  maxTokens?: number
  timeoutMs?: number
}

export interface CreatePiCheckpointCompletionRuntimeOptions {
  runtime: PiCheckpointModelRuntime
  model: Model<any> | { id: string }
  reasoning?: ThinkingLevel
  maxTokens?: number
  timeoutMs?: number
}

export async function createConfiguredPiCheckpointCompletionRuntime(
  config: PiCheckpointProviderConfig,
): Promise<PiCheckpointCompletionRuntime> {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const { modelRuntime, model } = await buildModel(sdk, {
    sessionId: `checkpoint-quality-eval-${randomUUID()}`,
    prompt: '',
    cwd: process.cwd(),
    apiKey: config.apiKey,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.modelId,
    channelName: config.channelName ?? 'Checkpoint quality evaluation',
    permissionMode: 'bypassPermissions',
    authorizeToolCall: async () => ({ behavior: 'deny', message: 'Checkpoint evaluation has no tools.' }),
    systemPrompt: '',
    piAgentDir: '',
    piSessionDir: '',
  } as PiAgentQueryOptions)
  return createPiCheckpointCompletionRuntime({
    runtime: modelRuntime,
    model,
    reasoning: config.reasoning,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  })
}

/** Adapt a Pi ModelRuntime into the narrow, evaluation-only checkpoint completion seam. */
export function createPiCheckpointCompletionRuntime(
  options: CreatePiCheckpointCompletionRuntimeOptions,
): PiCheckpointCompletionRuntime {
  return {
    complete: async ({ systemPrompt, userPrompt }) => {
      const response = await options.runtime.completeSimple(
        options.model as Model<any>,
        {
          systemPrompt,
          messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
        },
        {
          sessionId: randomUUID(),
          reasoning: options.reasoning ?? 'minimal',
          maxTokens: options.maxTokens ?? 4_000,
          timeoutMs: options.timeoutMs ?? 120_000,
          maxRetries: 0,
          cacheRetention: 'none',
        },
      )
      if (response.stopReason !== 'stop') {
        throw new Error(response.errorMessage?.trim() || `Checkpoint provider stopped with ${response.stopReason}.`)
      }
      const text = response.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      return {
        text,
        usage: {
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
          cacheReadTokens: response.usage.cacheRead,
          cacheWriteTokens: response.usage.cacheWrite,
          ...(response.usage.reasoning === undefined ? {} : { reasoningTokens: response.usage.reasoning }),
          totalTokens: response.usage.totalTokens,
        },
      }
    },
  }
}

function escapeMessageText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Serialize only provider-relevant roles and text; fixture IDs and strategy labels stay outside the request. */
export function serializeCheckpointMessages(messages: readonly CheckpointEvalMessage[]): string {
  const body = messages.map(message => [
    `<message role="${message.role}">`,
    escapeMessageText(message.text),
    '</message>',
  ].join('\n')).join('\n')
  return `<conversation>\n${body}\n</conversation>`
}

export function createPiCheckpointSummaryGenerator(
  runtime: PiCheckpointCompletionRuntime,
): BlindedCheckpointSummaryGenerator {
  return {
    generate: async ({ prompt, messages }) => {
      const completed = await runtime.complete({
        systemPrompt: prompt,
        userPrompt: serializeCheckpointMessages(messages),
      })
      const checkpoint = completed.text.trim()
      if (!checkpoint) throw new Error('Provider returned an empty checkpoint.')
      return {
        checkpoint,
        ...(completed.usage ? { usage: { ...completed.usage } } : {}),
      }
    },
  }
}
