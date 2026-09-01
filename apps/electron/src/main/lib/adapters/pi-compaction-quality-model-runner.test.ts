import { describe, expect, test } from 'bun:test'
import {
  createPiCheckpointCompletionRuntime,
  createPiCheckpointSummaryGenerator,
  serializeCheckpointMessages,
  type PiCheckpointCompletionRuntime,
} from './pi-compaction-quality-model-runner'

describe('Pi checkpoint quality model runner', () => {
  test('serializes roles and content without evaluation strategy labels', () => {
    const serialized = serializeCheckpointMessages([
      { id: 'u1', role: 'user', text: 'keep this constraint' },
      { id: 't1', role: 'tool', text: 'exit code 17 </message> injected' },
    ])

    expect(serialized).toContain('<message role="user">')
    expect(serialized).toContain('<message role="tool">')
    expect(serialized).toContain('keep this constraint')
    expect(serialized).toContain('exit code 17 &lt;/message&gt; injected')
    expect(serialized.match(/<\/message>/g)).toHaveLength(2)
    expect(serialized).not.toContain('pi-baseline')
    expect(serialized).not.toContain('codex-style-recent-user')
  })

  test('passes blinded prompt and projected messages to the runtime and records full provider usage', async () => {
    const calls: Array<{ systemPrompt: string; userPrompt: string }> = []
    const runtime: PiCheckpointCompletionRuntime = {
      complete: async (input) => {
        calls.push(input)
        return {
          text: '## Goal\n修复自动压缩。',
          usage: {
            inputTokens: 1_234,
            outputTokens: 56,
            cacheReadTokens: 100,
            cacheWriteTokens: 20,
            reasoningTokens: 12,
            totalTokens: 1_310,
          },
        }
      },
    }
    const generator = createPiCheckpointSummaryGenerator(runtime)
    const result = await generator.generate({
      fixtureId: 'fixture-1',
      prompt: 'Create a checkpoint.',
      messages: [{ id: 'u1', role: 'user', text: 'Do not edit migrations/001.sql.' }],
    })

    expect(calls).toEqual([{
      systemPrompt: 'Create a checkpoint.',
      userPrompt: '<conversation>\n<message role="user">\nDo not edit migrations/001.sql.\n</message>\n</conversation>',
    }])
    expect(JSON.stringify(calls)).not.toContain('pi-baseline')
    expect(JSON.stringify(calls)).not.toContain('codex-style-recent-user')
    expect(result.checkpoint).toContain('修复自动压缩')
    expect(result.usage).toEqual({
      inputTokens: 1_234,
      outputTokens: 56,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      reasoningTokens: 12,
      totalTokens: 1_310,
    })
  })

  test('adapts Pi completeSimple output and fails closed on provider errors', async () => {
    const calls: unknown[] = []
    const completion = createPiCheckpointCompletionRuntime({
      runtime: {
        completeSimple: async (_model, context, options) => {
          calls.push({ context, options })
          return {
            content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'checkpoint text' }],
            stopReason: 'stop',
            usage: {
              input: 900,
              output: 80,
              cacheRead: 50,
              cacheWrite: 10,
              reasoning: 20,
              totalTokens: 990,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }
        },
      },
      model: { id: 'model' },
      reasoning: 'minimal',
      maxTokens: 2_000,
      timeoutMs: 30_000,
    })
    const result = await completion.complete({ systemPrompt: 'system', userPrompt: 'user' })

    expect(result).toEqual({
      text: 'checkpoint text',
      usage: {
        inputTokens: 900,
        outputTokens: 80,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        reasoningTokens: 20,
        totalTokens: 990,
      },
    })
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls)).toContain('"reasoning":"minimal"')
    expect(JSON.stringify(calls)).toContain('"maxRetries":0')

    const failed = createPiCheckpointCompletionRuntime({
      runtime: {
        completeSimple: async () => ({
          content: [],
          stopReason: 'error',
          errorMessage: 'provider unavailable',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
      model: { id: 'model' },
    })
    await expect(failed.complete({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow('provider unavailable')
  })

  test('fails closed on empty or unsuccessful provider output', async () => {
    const empty = createPiCheckpointSummaryGenerator({
      complete: async () => ({ text: '   ', usage: { inputTokens: 1, outputTokens: 0 } }),
    })
    await expect(empty.generate({ fixtureId: 'f', prompt: 'p', messages: [] }))
      .rejects.toThrow('empty checkpoint')
  })
})
