import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { readPiResponsesDiagnostics } from '../audit/pi-responses-diagnostics.ts'

const model: Model<'openai-responses'> = {
  id: 'fixture', name: 'Fixture', api: 'openai-responses', provider: 'fixture',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
}
function item(text: string, id = 'msg_1') {
  return { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
}
const added = { type: 'response.output_item.added', output_index: 0, item: item('') }
const delta = { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' }
const done = (text: string) => ({ type: 'response.output_item.done', output_index: 0, item: item(text) })
const terminal = (text: string) => ({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item(text)] } })

async function replay(events: readonly unknown[]) {
  const output: AssistantMessage = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: 0,
  }
  // 合成网关事件故意包含不完整 payload，通过真实 SDK 解析边界验证兼容行为。
  const source = (async function* () { yield* events })() as Parameters<typeof processResponsesStream>[0]
  const stream = new AssistantMessageEventStream()
  await processResponsesStream(source, output, stream, model)
  stream.end(output)
  const updates = []
  for await (const event of stream) {
    if (event.type === 'text_delta') updates.push({ type: event.type, text: event.delta })
    if (event.type === 'text_end') updates.push({ type: event.type, text: event.content })
  }
  return { text: output.content.filter(block => block.type === 'text').map(block => block.text).join(''), output, updates }
}

describe('Pi Responses 正文恢复', () => {
  test('标准流保留正文且只结束一次', async () => {
    const result = await replay([added, delta, done('OK'), terminal('OK')])
    expect(result.text).toBe('OK')
    expect(result.updates).toEqual([{ type: 'text_delta', text: 'OK' }, { type: 'text_end', text: 'OK' }])
  })

  test('最终完整响应可补回空正文并按消息 ID 去重', async () => {
    const result = await replay([added, done(''), terminal('OK')])
    expect(result.text).toBe('OK')
    expect(result.output.content).toHaveLength(1)
    expect(result.updates.at(-1)).toEqual({ type: 'text_end', text: 'OK' })
    expect(readPiResponsesDiagnostics(result.output)).toEqual({ eventCount: 3, textDeltaChars: 0, itemDoneTextChars: 0, terminalTextChars: 2, recoveredTextBlocks: 1, parsedTextChars: 2 })
  })

  test('只有 terminal 的完整正文也能创建可展示块', async () => {
    const result = await replay([terminal('OK')])
    expect(result.text).toBe('OK')
    expect(result.output.content).toHaveLength(1)
  })

  test('终态补齐截断正文时替换而不是追加', async () => {
    const result = await replay([added, delta, done('OK'), terminal('OK complete')])
    expect(result.text).toBe('OK complete')
    expect(result.output.content).toHaveLength(1)
  })

  test('不同消息 ID 的正文不混合', async () => {
    const response = terminal('OK')
    response.response.output.push(item(' next', 'msg_2'))
    const result = await replay([added, delta, done('OK'), response])
    expect(result.text).toBe('OK next')
    expect(result.output.content).toHaveLength(2)
  })

  test('拒绝内容也保留，空上游不伪造文字', async () => {
    const result = await replay([{ type: 'response.completed', response: { status: 'completed', output: [{ ...item(''), content: [{ type: 'refusal', refusal: 'Cannot comply' }] }] } }])
    expect(result.text).toBe('Cannot comply')
    expect((await replay([added, done(''), terminal('')])).text).toBe('')
  })

  test('failed 和 incomplete 不被恢复逻辑改成成功', async () => {
    await expect(replay([{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'fixture' } } }])).rejects.toThrow('fixture')
    const result = await replay([{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [item('partial')] } }])
    expect(result.text).toBe('partial')
    expect(result.output.stopReason).toBe('length')
  })

  test('只在 terminal 出现的工具不被意外执行', async () => {
    const result = await replay([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'delete', arguments: '{}' }] } }])
    expect(result.output.content).toEqual([])
  })

  test('空 item.done 不得清空已接收正文', async () => {
    const result = await replay([added, delta, done(''), terminal('')])
    expect(result.text).toBe('OK')
    expect(result.updates.at(-1)).toEqual({ type: 'text_end', text: 'OK' })
  })
})
