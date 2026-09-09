import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { SDKMessage } from '@domi/shared'
import { agentStreamingStatesAtom, liveMessagesMapAtom, agentLiveMessagesAtomFamily, type AgentStreamState } from './agent-atoms'
import { retainCompletedSideChatAtom, sideChatViewAtomFamily, sideChatOperationAtomFamily } from './side-chat-atoms'
import { mergeAgentMessageTimeline } from '@/lib/agent-message-timeline'
import { sideChatTextMessages } from '@/components/agent/side-chat/side-chat-behavior'

function state(startedAt: number, running = false): AgentStreamState {
  return { running, startedAt, toolActivities: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 1000 }
}
const answer: SDKMessage = { type: 'assistant', uuid: 'answer', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '私有推理' }, { type: 'text', text: '已收到实时正文' }] } }
function setup() {
  const store = createStore()
  store.set(sideChatViewAtomFamily('parent'), { parentSessionId: 'parent', sessionId: 'child', messages: [], isRunning: true })
  store.set(sideChatViewAtomFamily('other'), { parentSessionId: 'other', sessionId: 'other-child', messages: [], isRunning: true })
  store.set(agentStreamingStatesAtom, new Map([['child', state(100)]]))
  store.set(liveMessagesMapAtom, new Map([['child', [answer]]]))
  return store
}
test('连续文字增量在同一子会话上更新，主会话订阅不被通知', () => {
  const store = setup()
  let parentChanges = 0
  const stop = store.sub(agentLiveMessagesAtomFamily('parent'), () => { parentChanges++ })
  const first = { ...answer, message: { content: [{ type: 'text' as const, text: '第一段' }] }, _partial: true }
  store.set(liveMessagesMapAtom, new Map([['child', [first]]]))
  expect(sideChatTextMessages(store.get(agentLiveMessagesAtomFamily('child')))[0]?.text).toBe('第一段')
  const second = { ...first, message: { content: [{ type: 'text' as const, text: '第一段第二段' }] } }
  store.set(liveMessagesMapAtom, new Map([['child', [second]]]))
  expect(sideChatTextMessages(store.get(agentLiveMessagesAtomFamily('child')))[0]?.text).toBe('第一段第二段')
  expect(parentChanges).toBe(0)
  stop()
})

test('未等轮询即可读取实时正文，不混入父会话或推理', () => {
  const store = setup()
  const texts = sideChatTextMessages(mergeAgentMessageTimeline([], store.get(agentLiveMessagesAtomFamily('child'))))
  expect(texts.map(m => m.text)).toEqual(['已收到实时正文'])
  expect(store.get(agentLiveMessagesAtomFamily('parent'))).toEqual([])
  expect(store.get(sideChatViewAtomFamily('parent'))?.messages).toEqual([])
})
test('完成或停止后释放实时缓存仍保留正文，收起不影响交接，重复最终历史不重复', () => {
  const store = setup()
  store.set(retainCompletedSideChatAtom, { sessionId: 'child', startedAt: 100 })
  store.set(liveMessagesMapAtom, new Map())
  const view = store.get(sideChatViewAtomFamily('parent'))!
  expect(view.messages).toEqual([answer])
  expect(view.isRunning).toBe(false)
  expect(store.get(sideChatOperationAtomFamily('parent')).revision).toBe(1)
  expect(store.get(sideChatViewAtomFamily('other'))?.messages).toEqual([])
  expect(mergeAgentMessageTimeline(view.messages, [answer])).toEqual([answer])
})
test('新run进行中或已替换旧run时，迟到完成不能接管正文或解除运行态', () => {
  const store = setup()
  store.set(agentStreamingStatesAtom, new Map([['child', state(200, true)]]))
  store.set(retainCompletedSideChatAtom, { sessionId: 'child', startedAt: 100 })
  expect(store.get(sideChatViewAtomFamily('parent'))?.isRunning).toBe(true)
  expect(store.get(sideChatOperationAtomFamily('parent')).revision).toBe(0)
  store.set(agentStreamingStatesAtom, new Map([['child', state(200)]]))
  store.set(retainCompletedSideChatAtom, { sessionId: 'child', startedAt: 100 })
  expect(store.get(sideChatViewAtomFamily('parent'))?.messages).toEqual([])
})
