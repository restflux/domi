import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, Context, Model, OpenAICodexResponsesOptions } from '@earendil-works/pi-ai/compat'
import {
  completeCodexVisionRequest,
  type CodexVisionRequestEnvironment,
  type CodexVisionRuntime,
} from './pi-codex-vision'

const model = {} as Model<'openai-codex-responses'>

function environment(): CodexVisionRequestEnvironment & { closed: boolean } {
  const state = {
    closed: false,
    installRequestProxyFetch: () => undefined,
    runWithRequestProxy: <T>(_dispatcher: unknown, operation: () => T) => operation(),
    closeRequestProxyDispatcher: async () => { state.closed = true },
  }
  return state
}

describe('Codex OAuth Vision Relay request', () => {
  test('sends one image plus focused question without agent history', async () => {
    let context: Context | undefined
    let options: OpenAICodexResponsesOptions | undefined
    const runtime: CodexVisionRuntime = {
      async complete(_model, requestContext, requestOptions) {
        context = requestContext
        options = requestOptions
        return {
          content: [{ type: 'text', text: '{"answer":"ok","observations":[],"limitations":[],"confidence":"high"}' }],
          stopReason: 'stop',
        } as Pick<AssistantMessage, 'content' | 'stopReason' | 'errorMessage'>
      },
    }
    const env = environment()
    const result = await completeCodexVisionRequest(runtime, model, {
      image: { data: Buffer.from('image'), mediaType: 'image/png' },
      question: 'What failed?',
      systemPrompt: 'Return safe JSON.',
      qualityPreset: 'balanced',
    }, env)

    expect(result).toContain('"answer":"ok"')
    expect(context?.systemPrompt).toBe('Return safe JSON.')
    expect(context?.messages).toHaveLength(1)
    expect(context?.messages[0]).toMatchObject({ role: 'user' })
    expect(context?.messages[0]?.content).toEqual([
      { type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: 'What failed?' },
    ])
    expect(options).toMatchObject({ maxRetries: 0, reasoningEffort: 'low', textVerbosity: 'medium', toolChoice: 'none' })
    expect(env.closed).toBe(true)
  })

  test('rejects oversized Codex output before returning it to the relay service', async () => {
    const runtime: CodexVisionRuntime = {
      async complete() {
        return { content: [{ type: 'text', text: 'x'.repeat(12_001) }], stopReason: 'stop' }
      },
    }
    const env = environment()
    await expect(completeCodexVisionRequest(runtime, model, {
      image: { data: Buffer.from('image'), mediaType: 'image/png' },
      question: 'Describe.',
      systemPrompt: 'Return JSON.',
      qualityPreset: 'accurate',
    }, env)).rejects.toMatchObject({ code: 'VISION_OUTPUT_TOO_LARGE' })
    expect(env.closed).toBe(true)
  })

  test('closes proxy resources when Codex fails', async () => {
    const runtime: CodexVisionRuntime = { async complete() { throw new Error('quota') } }
    const env = environment()
    await expect(completeCodexVisionRequest(runtime, model, {
      image: { data: Buffer.from('image'), mediaType: 'image/jpeg' },
      question: 'Describe.',
      systemPrompt: 'Return JSON.',
      qualityPreset: 'fast',
    }, env)).rejects.toThrow('quota')
    expect(env.closed).toBe(true)
  })

  test('maps product quality presets to bounded Codex reasoning options', async () => {
    const seen: Array<Pick<OpenAICodexResponsesOptions, 'reasoningEffort' | 'textVerbosity'>> = []
    const runtime: CodexVisionRuntime = {
      async complete(_model, _context, options) {
        seen.push({ reasoningEffort: options.reasoningEffort, textVerbosity: options.textVerbosity })
        return { content: [{ type: 'text', text: '{"answer":"ok"}' }], stopReason: 'stop' }
      },
    }
    for (const qualityPreset of ['fast', 'balanced', 'accurate'] as const) {
      await completeCodexVisionRequest(runtime, model, {
        image: { data: Buffer.from('image'), mediaType: 'image/png' },
        question: 'Identify the app.',
        systemPrompt: 'Return JSON.',
        qualityPreset,
      }, environment())
    }
    expect(seen).toEqual([
      { reasoningEffort: 'none', textVerbosity: 'low' },
      { reasoningEffort: 'low', textVerbosity: 'medium' },
      { reasoningEffort: 'medium', textVerbosity: 'medium' },
    ])
  })
})
