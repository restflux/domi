import { expect, test } from 'bun:test'
import type { SDKAssistantMessage } from '@domi/shared'
import { mergeAgentMessageTimeline } from './agent-message-timeline'

function message(uuid: string, text: string, partial = false): SDKAssistantMessage {
  return { type: 'assistant', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] }, ...{ _partial: partial } }
}
test('实时帧按同一身份更新，持久终态不会被迟到 partial 截短', () => {
  const partial = message('a', '正在', true)
  const final = message('a', '正在回答，已完成')
  expect(mergeAgentMessageTimeline([], [partial])).toEqual([partial])
  expect(mergeAgentMessageTimeline([partial], [final])).toEqual([final])
  expect(mergeAgentMessageTimeline([final], [partial])).toEqual([final])
  expect(mergeAgentMessageTimeline([final], [final])).toEqual([final])
})
test('同正文不同消息不去重，历史与实时逐条重叠不重复', () => {
  const a = message('a', '相同')
  const b = message('b', '相同')
  const c = message('c', '新增')
  expect(mergeAgentMessageTimeline([a, b], [b, c])).toEqual([a, b, c])
})
test('没有UUID的不同对象不按正文误合并', () => {
  const { uuid: _, ...a } = message('a', '相同')
  const b = { ...a }
  expect(mergeAgentMessageTimeline([a], [b])).toHaveLength(2)
  expect(mergeAgentMessageTimeline([a], [a])).toHaveLength(1)
})
