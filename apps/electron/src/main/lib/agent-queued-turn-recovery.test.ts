import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@domi/shared'
import {
  recoverMissingPiUserTurns,
  stripPiInjectedUserContext,
  type RecoverablePiSessionEntry,
} from './agent-queued-turn-recovery'

function piUser(id: string, parentId: string | null, text: string): RecoverablePiSessionEntry {
  return { type: 'message', id, parentId, message: { role: 'user', content: [{ type: 'text', text }] } }
}

function piAssistant(id: string, parentId: string, text: string): RecoverablePiSessionEntry {
  return { type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function sdkUser(text: string): SDKMessage {
  return { type: 'user', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null } as SDKMessage
}

function sdkAssistant(uuid: string, text: string): SDKMessage {
  return { type: 'assistant', uuid, message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null } as SDKMessage
}

function displaySequence(messages: readonly SDKMessage[]): string[] {
  return messages.map((message) => message.type === 'user'
    ? (message as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
    : (message as { uuid?: string }).uuid ?? message.type)
}

describe('queued Agent turn recovery', () => {
  test('补回两个已绑定 assistant 之间只存在于 Pi transcript 的排队用户消息', () => {
    const entries = [
      piUser('u1', null, '第一问'),
      piAssistant('a1', 'u1', '第一答'),
      piUser('queued-u', 'a1', '风险6怎么会是风险？'),
      piAssistant('a2', 'queued-u', '第二答'),
    ]
    entries[2]!.timestamp = '2026-08-14T08:05:33.642Z'

    const recovered = recoverMissingPiUserTurns([
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
      sdkAssistant('ui-a2', '第二答'),
    ], entries, {
      'ui-a1': 'a1',
      'ui-a2': 'a2',
    })

    expect(displaySequence(recovered))
      .toEqual(['第一问', 'ui-a1', '风险6怎么会是风险？', 'ui-a2'])
    expect((recovered[2] as SDKMessage & { uuid?: string }).uuid)
      .toBe('pi-recovered-user:queued-u')
    expect((recovered[2] as SDKMessage & { _createdAt?: number })._createdAt)
      .toBe(Date.parse('2026-08-14T08:05:33.642Z'))
  })

  test('补回活跃路径尾部尚未产生 assistant binding 的用户消息', () => {
    const entries = [
      piUser('u1', null, '第一问'),
      piAssistant('a1', 'u1', '第一答'),
      piUser('running-u', 'a1', '正在执行的新问题'),
    ]

    const recovered = recoverMissingPiUserTurns([
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
    ], entries, { 'ui-a1': 'a1' }, 'running-u')

    expect(displaySequence(recovered)).toEqual(['第一问', 'ui-a1', '正在执行的新问题'])
    expect(recovered[2]).toMatchObject({
      uuid: 'pi-recovered-user:running-u',
      _recoveredFromPiTranscript: true,
      _recoveredPiEntryId: 'running-u',
    })
  })

  test('尾部恢复只沿显式活跃叶路径，不使用 JSONL 最后追加的非活跃分支', () => {
    const entries = [
      piUser('u1', null, '第一问'),
      piAssistant('a1', 'u1', '第一答'),
      piUser('active-u', 'a1', '活跃分支新问题'),
      piUser('inactive-u', 'a1', '后追加的非活跃分支'),
    ]

    const recovered = recoverMissingPiUserTurns([
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
    ], entries, { 'ui-a1': 'a1' }, 'active-u')

    expect(displaySequence(recovered)).toEqual(['第一问', 'ui-a1', '活跃分支新问题'])
  })

  test('尾部问题与历史文本重复时仍按 Pi entry ID 恢复为新 turn', () => {
    const entries = [
      piUser('u1', null, '重复问题'),
      piAssistant('a1', 'u1', '第一答'),
      piUser('repeat-u', 'a1', '重复问题'),
    ]

    const recovered = recoverMissingPiUserTurns([
      sdkUser('重复问题'),
      sdkAssistant('ui-a1', '第一答'),
    ], entries, { 'ui-a1': 'a1' }, 'repeat-u')

    expect(displaySequence(recovered)).toEqual(['重复问题', 'ui-a1', '重复问题'])
    expect((recovered[2] as SDKMessage & { _recoveredPiEntryId?: string })._recoveredPiEntryId).toBe('repeat-u')
  })

  test('Domi transcript 已存在用户边界时不重复插入', () => {
    const entries = [
      piUser('u1', null, '第一问'),
      piAssistant('a1', 'u1', '第一答'),
      piUser('u2', 'a1', '第二问'),
      piAssistant('a2', 'u2', '第二答'),
    ]
    const recovered = recoverMissingPiUserTurns([
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
      sdkUser('第二问'),
      sdkAssistant('ui-a2', '第二答'),
    ], entries, { 'ui-a1': 'a1', 'ui-a2': 'a2' })

    expect(displaySequence(recovered))
      .toEqual(['第一问', 'ui-a1', '第二问', 'ui-a2'])
  })

  test('旧会话中的内部压缩续跑 user entry 不恢复成用户气泡', () => {
    const entries = [
      piUser('u1', null, '第一问'),
      piAssistant('a1', 'u1', '第一答'),
      piUser('internal-u', 'a1', '<proma_compaction_continuation>\n继续原任务\n</proma_compaction_continuation>'),
      piAssistant('a2', 'internal-u', '第二答'),
    ]

    const recovered = recoverMissingPiUserTurns([
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
      sdkAssistant('ui-a2', '第二答'),
    ], entries, { 'ui-a1': 'a1', 'ui-a2': 'a2' })

    expect(displaySequence(recovered)).toEqual(['第一问', 'ui-a1', 'ui-a2'])
  })

  test('尾部内部续跑 entry 不恢复成用户气泡', () => {
    const entries = [
      piUser('u1', null, '第一问'),
      piAssistant('a1', 'u1', '第一答'),
      piUser('internal-tail', 'a1', '<domi_incomplete_turn_continuation>\n继续原任务\n</domi_incomplete_turn_continuation>'),
    ]

    const recovered = recoverMissingPiUserTurns([
      sdkUser('第一问'),
      sdkAssistant('ui-a1', '第一答'),
    ], entries, { 'ui-a1': 'a1' }, 'internal-tail')

    expect(displaySequence(recovered)).toEqual(['第一问', 'ui-a1'])
  })

  test('两个 assistant 不在同一 Pi 祖先路径时不跨分支补消息', () => {
    const entries = [
      piUser('u1', null, '第一问'),
      piAssistant('a1', 'u1', '第一答'),
      piUser('old-u', 'a1', '旧分支'),
      piAssistant('old-a', 'old-u', '旧回答'),
      piUser('new-u', 'a1', '新分支'),
      piAssistant('new-a', 'new-u', '新回答'),
    ]
    const recovered = recoverMissingPiUserTurns([
      sdkUser('第一问'),
      sdkAssistant('ui-old-a', '旧回答'),
      sdkAssistant('ui-new-a', '新回答'),
    ], entries, { 'ui-old-a': 'old-a', 'ui-new-a': 'new-a' })

    expect(displaySequence(recovered)).toEqual(['第一问', 'ui-old-a', 'ui-new-a'])
  })

  test('恢复文本剥离运行时上下文但保留用户正文', () => {
    expect(stripPiInjectedUserContext([
      '**当前时间: Friday, August 14, 2026 at 04:05 PM GMT+8**',
      '<workspace_state>项目: domi</workspace_state>',
      '<working_directory>D:\\workspace\\domi</working_directory>',
      '<domi_next_turn_asides><aside>背景</aside></domi_next_turn_asides>',
      '<referenced_sessions>历史</referenced_sessions>',
      '风险6怎么会是风险？',
    ].join('\n\n'))).toBe('风险6怎么会是风险？')
  })
})
