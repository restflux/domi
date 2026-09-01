import { describe, expect, test } from 'bun:test'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { Context, Model } from '@earendil-works/pi-ai/compat'

type OpenAIModel = Model<'openai-completions'>

const CONTEXT: Context = {
  messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
  tools: [{
    name: 'Bash',
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }],
}

function createModel(supportsFinishReason: boolean): OpenAIModel {
  return {
    id: 'finish-reason-test',
    name: 'Finish Reason Test',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: 'https://example.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
    compat: { supportsFinishReason },
  }
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: 'response-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'finish-reason-test',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

async function runStream(
  supportsFinishReason: boolean,
  chunks: Record<string, unknown>[],
  includeDone = true,
) {
  const body = chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')
    + (includeDone ? 'data: [DONE]\n\n' : '')
  const fetchFn = async (): Promise<Response> => new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  const stream = streamSimple(createModel(supportsFinishReason), CONTEXT, {
    apiKey: 'test-key',
    fetch: fetchFn as unknown as typeof globalThis.fetch,
    maxRetries: 0,
  })
  for await (const _event of stream) {
    // Drain all lifecycle events so the final AssistantMessage is settled.
  }
  return stream.result()
}

describe('Pi OpenAI finish_reason 原生兼容管线', () => {
  test('Given 标准终态帧 When required Then 正常完成', async () => {
    const result = await runStream(true, [
      chunk({ role: 'assistant', content: 'hello' }),
      chunk({}, 'stop'),
    ])

    expect(result.stopReason).toBe('stop')
    expect(result.errorMessage).toBeUndefined()
  })

  test('Given 明确 DONE 但缺少 finish_reason When required Then 保留断流错误', async () => {
    const result = await runStream(true, [
      chunk({ role: 'assistant', content: 'hello' }),
    ])

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('Stream ended without finish_reason')
  })

  test('Given 纯文本且服务不提供 finish_reason When not-supported Then 推断 stop', async () => {
    const result = await runStream(false, [
      chunk({ role: 'assistant', content: 'hello' }),
    ])

    expect(result.stopReason).toBe('stop')
    expect(result.errorMessage).toBeUndefined()
  })

  test('Given 工具调用且服务不提供 finish_reason When not-supported Then 推断 toolUse', async () => {
    const result = await runStream(false, [
      chunk({
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"pwd"}' },
        }],
      }),
    ])

    expect(result.stopReason).toBe('toolUse')
    expect(result.content).toContainEqual({
      type: 'toolCall',
      id: 'call-1',
      name: 'Bash',
      arguments: { command: 'pwd' },
    })
  })

  test('Given SSE 在终态前 clean EOF When 比较两种模式 Then required 报错而 not-supported 会视为正常', async () => {
    const chunks = [chunk({ role: 'assistant', content: 'partial' })]
    const required = await runStream(true, chunks, false)
    const notSupported = await runStream(false, chunks, false)

    expect(required.stopReason).toBe('error')
    expect(required.errorMessage).toContain('Stream ended without finish_reason')
    expect(notSupported.stopReason).toBe('stop')
    expect(notSupported.errorMessage).toBeUndefined()
  })
})
