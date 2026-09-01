import { describe, expect, test } from 'bun:test'
import type { AssistantTurn, MessageGroup } from './SDKMessageRenderer'
import { buildLiveGroupSet } from './live-group-set'
import { filterAndMergeConversationGroups } from './visible-conversation-groups'

function assistantTurn(id: string, model = 'gpt-5.6-sol', startsAfterWake = false): AssistantTurn {
  const assistant = {
    type: 'assistant',
    uuid: id,
    message: { model, content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Read', input: {} }] },
  } as never
  return {
    type: 'assistant-turn',
    assistantMessages: [assistant],
    turnMessages: [assistant],
    model,
    startsAfterWake: startsAfterWake || undefined,
  }
}

const hiddenCompaction = {
  type: 'system',
  message: { type: 'system', subtype: 'compact_boundary' },
  identityMessage: { type: 'system', subtype: 'compacting' },
} as never

const hideCompaction = (group: MessageGroup): boolean => group === hiddenCompaction

describe('消息区隐藏控制记录后的分组', () => {
  test('同一次任务被隐藏的压缩生命周期切开后仍展示为一个 assistant turn', () => {
    const visibleGroups = filterAndMergeConversationGroups([
      assistantTurn('before'),
      hiddenCompaction,
      assistantTurn('after'),
    ], hideCompaction)

    expect(visibleGroups).toHaveLength(1)
    expect(visibleGroups[0]).toMatchObject({
      type: 'assistant-turn',
      assistantMessages: [{ uuid: 'before' }, { uuid: 'after' }],
    })
  })

  test('合并后的消息块仍能识别压缩后恢复的实时输出', () => {
    const before = assistantTurn('before')
    const after = assistantTurn('after')
    const visibleGroups = filterAndMergeConversationGroups([
      before,
      hiddenCompaction,
      after,
    ], hideCompaction)

    const liveGroups = buildLiveGroupSet({
      allGroups: visibleGroups,
      liveMessages: after.assistantMessages,
      streaming: true,
    })

    expect(liveGroups.has(visibleGroups[0]!)).toBe(true)
  })

  test('没有隐藏控制记录时不改变原有 assistant turn 边界', () => {
    const visibleGroups = filterAndMergeConversationGroups([
      assistantTurn('first'),
      assistantTurn('second'),
    ], hideCompaction)

    expect(visibleGroups).toHaveLength(2)
  })

  test('模型切换与后台任务唤醒仍保持独立消息块', () => {
    const modelChanged = filterAndMergeConversationGroups([
      assistantTurn('before'),
      hiddenCompaction,
      assistantTurn('after', 'claude-sonnet'),
    ], hideCompaction)
    const wokeInBackground = filterAndMergeConversationGroups([
      assistantTurn('before'),
      hiddenCompaction,
      assistantTurn('after', 'gpt-5.6-sol', true),
    ], hideCompaction)

    expect(modelChanged).toHaveLength(2)
    expect(wokeInBackground).toHaveLength(2)
  })
})
