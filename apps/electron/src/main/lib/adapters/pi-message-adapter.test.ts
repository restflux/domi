import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import type { SDKAssistantMessage } from '@domi/shared'
import {
  convertPiMessage,
  convertResultMessage,
  createPiCompactionBoundaryMessage,
  getPiAssistantErrorDetails,
  hasPiAssistantTextContent,
  stripPiAssistantError,
} from './pi-message-adapter'

function writeToolCall(content: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'tool-call-1',
      name: 'write',
      arguments: {
        path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
        content,
      },
    }],
  } as unknown as AssistantMessage
}

describe('Pi 压缩消息转换', () => {
  test('Given 自动压缩返回压缩后预估 When 转成 SDK 消息 Then 携带新占用而不是保留压缩前值', () => {
    const message = createPiCompactionBoundaryMessage('session-1', {
      summary: '已压缩',
      estimatedTokensAfter: 32_000,
    }) as { compactionEstimatedTokensAfter?: number }

    expect(message.compactionEstimatedTokensAfter).toBe(32_000)
  })
})

describe('convertPiMessage', () => {
  test('Given Pi partial 尚无终态 usage When 转成 SDK 消息 Then 不生成零值 usage 覆盖上一轮真实占用', () => {
    const partial = convertPiMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '正在分析' }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    } as unknown as AssistantMessage, 'session-1', 'gpt-5.4-mini', {
      final: false,
      uuid: 'assistant-partial',
    }) as { _partial?: boolean; message: { usage?: unknown } }

    expect(partial._partial).toBe(true)
    expect(partial.message.usage).toBeUndefined()
  })

  test('Given Pi final 带真实 usage When 转成 SDK 消息 Then 保留完整上下文用量', () => {
    const final = convertPiMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '分析完成' }],
      usage: {
        input: 3_000,
        output: 500,
        cacheRead: 18_000,
        cacheWrite: 453,
      },
    } as unknown as AssistantMessage, 'session-1', 'gpt-5.4-mini', {
      final: true,
      uuid: 'assistant-final',
    }) as { message: { usage?: Record<string, number> } }

    expect(final.message.usage).toEqual({
      input_tokens: 3_000,
      output_tokens: 500,
      cache_read_input_tokens: 18_000,
      cache_creation_input_tokens: 453,
    })
  })

  test('omits cumulative write content from partial tool-call frames', () => {
    const message = convertPiMessage(writeToolCall('x'.repeat(10_240)), 'session-1', undefined, {
      final: false,
      uuid: 'assistant-1',
    }) as { _partial?: boolean; message: { content: Array<{ input?: unknown }> } }

    expect(message._partial).toBe(true)
    expect(message.message.content[0]?.input).toEqual({})
    expect(JSON.stringify(message).length).toBeLessThan(1_000)
  })

  test('keeps complete write input in the final tool-call frame', () => {
    const content = 'x'.repeat(10_240)
    const message = convertPiMessage(writeToolCall(content), 'session-1', undefined, {
      final: true,
      uuid: 'assistant-1',
    }) as { message: { content: Array<{ input?: Record<string, unknown> }> } }

    expect(message.message.content[0]?.input).toEqual({
      path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      file_path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      content,
    })
    expect(JSON.stringify(message).length).toBeGreaterThan(content.length)
  })

  test('only exposes terminal Pi errors in final frames', () => {
    const providerError = 'Connection error. Failed to fetch'
    const partialStop = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'stop', errorMessage: providerError,
    } as unknown as AssistantMessage, 'session-1') as { error?: unknown }
    const retryPreview = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as AssistantMessage, 'session-1', undefined, { final: false }) as { error?: unknown }
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(partialStop.error).toBeUndefined()
    expect(retryPreview.error).toBeUndefined()
    expect(terminalError.error).toEqual({
      message: providerError,
      errorType: 'network_error',
    })
  })

  test('classifies a malformed upstream JSON response as service_error', () => {
    const errorMessage = 'Unexpected non-whitespace character after JSON at position 199 (line 2 column 1)'
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: errorMessage, errorType: 'service_error' })
  })

  test('keeps non-network terminal Pi errors as provider_error', () => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded',
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: '529 overloaded', errorType: 'provider_error' })
  })

  test.each([
    'peer closed connection',
    'incomplete chunked read',
    'peer closed connection without sending complete message body (incomplete chunked read)',
  ])('classifies terminal Pi transport error "%s" as network_error', (errorMessage) => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
    } as unknown as AssistantMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toEqual({ message: errorMessage, errorType: 'network_error' })
  })

  test('keeps generated text separate from a terminal transport error', () => {
    const body = 'Generated assistant output must not appear inside the error card.'
    const transportError = 'peer closed connection without sending complete message body (incomplete chunked read)'
    const terminalError = convertPiMessage({
      role: 'assistant',
      content: [{ type: 'text', text: body }],
      stopReason: 'error',
      errorMessage: transportError,
    } as unknown as AssistantMessage, 'session-1') as SDKAssistantMessage

    expect(getPiAssistantErrorDetails(terminalError)).toEqual({
      detailedMessage: transportError,
      originalError: transportError,
    })
    expect(hasPiAssistantTextContent(terminalError)).toBe(true)
    expect(stripPiAssistantError(terminalError).error).toBeUndefined()
    expect(terminalError.message.content).toEqual([{ type: 'text', text: body }])
    expect(terminalError.error).toEqual({ message: transportError, errorType: 'network_error' })
  })

  test('counts each top-level final Pi assistant usage as one exact provider request', () => {
    const result = convertResultMessage([
      { role: 'assistant', content: [], usage: { input: 100, output: 10, cacheRead: 80, cacheWrite: 0 } },
      { role: 'toolResult', content: [], toolCallId: 'tool-1', toolName: 'read', isError: false },
      { role: 'assistant', content: [], usage: { input: 20, output: 5, cacheRead: 90, cacheWrite: 0 } },
      { role: 'assistant', content: [], usage: { input: 999, output: 99, cacheRead: 0, cacheWrite: 0 }, _partial: true },
      { role: 'assistant', content: [], usage: { input: 999, output: 99, cacheRead: 0, cacheWrite: 0 }, isReplay: true },
      { role: 'assistant', content: [], usage: { input: 999, output: 99, cacheRead: 0, cacheWrite: 0 }, parent_tool_use_id: 'child' },
    ] as unknown as AssistantMessage[], 'session-1') as {
      usage: {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens: number
        cache_creation_input_tokens: number
      }
      _providerRequestCount?: number
      _providerRequestCountAccuracy?: string
    }

    expect(result._providerRequestCount).toBe(2)
    expect(result._providerRequestCountAccuracy).toBe('exact')
    expect(result.usage).toEqual({
      input_tokens: 120,
      output_tokens: 15,
      cache_read_input_tokens: 170,
      cache_creation_input_tokens: 0,
    })
  })

  test('only reports result errors for terminal Pi failures', () => {
    const providerError = 'stream ended before a terminal response event'
    const partialStop = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'stop', errorMessage: providerError,
    } as unknown as AssistantMessage], 'session-1') as { subtype?: string; errors?: string[] }
    const terminalError = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as AssistantMessage], 'session-1') as { subtype?: string; errors?: string[] }

    expect(partialStop.subtype).toBe('success')
    expect(partialStop.errors).toBeUndefined()
    expect(terminalError.subtype).toBe('error_during_execution')
    expect(terminalError.errors).toEqual([providerError])
  })
})
